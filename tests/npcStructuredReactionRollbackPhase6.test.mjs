import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getRuntimeConfig, parseConfig } from "../src/config.mjs";
import { runCli } from "../src/cli.mjs";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { createLocalInterpreterHttpProvider, PseudoInterpreterProvider } from "../src/interpreterTransport.mjs";
import { createNpcCliPublicationSink } from "../src/npcCliPublicationSink.mjs";
import { createProductionNpcStructuredDeliveryIntegration } from "../src/npcProductionIntegration.mjs";
import { createNpcReactionCandidateProvider } from "../src/npcReactionCandidateProvider.mjs";
import { createLocalNpcReactionCandidateTransport } from "../src/npcReactionCandidateTransport.mjs";
import { createPseudoNpcReactionCandidateInvoker } from "../src/npcReactionCandidateUpstream.mjs";
import { createWebServer } from "../src/webServer.mjs";

const RUNBOOK_URL = new URL("../docs/npc-structured-reaction-rollback-runbook.md", import.meta.url);

test("rollback config keeps Objective A distinct from Objective B and exposes no credential or budget", () => {
  const defaults = parseConfig({});
  assert.equal(defaults.provider, "pseudo");
  assert.equal(defaults.npcStructuredReactionMode, false);

  const explicitFalse = parseConfig({ NPC_STRUCTURED_REACTION_MODE: "false" });
  assert.equal(explicitFalse.npcStructuredReactionMode, false);
  assert.throws(
    () => parseConfig({ NPC_STRUCTURED_REACTION_MODE: "true" }),
    /requires PLAYER_CONVERSATION_COMMIT_MODE=true/
  );

  const objectiveA = parseConfig({
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "unit-test-credential",
    INTERPRETER_VALIDATION_MODE: "true",
    PLAYER_CONVERSATION_COMMIT_MODE: "true",
    NPC_STRUCTURED_REACTION_MODE: "false"
  });
  assert.equal(objectiveA.provider, "openai");
  assert.equal(objectiveA.npcStructuredReactionMode, false);
  assert.equal(objectiveA.openai.apiKey, "unit-test-credential");

  const objectiveB = parseConfig({
    LLM_PROVIDER: "pseudo",
    OPENAI_API_KEY: "unit-test-credential",
    NPC_STRUCTURED_REACTION_MODE: "false"
  });
  assert.equal(objectiveB.provider, "pseudo");
  assert.equal(objectiveB.openai, null);

  const browserConfig = getRuntimeConfig(objectiveA);
  assert.equal(browserConfig.provider, "openai");
  assert.equal(browserConfig.npcStructuredReactionMode, false);
  assert.equal(Object.hasOwn(browserConfig, "apiKey"), false);
  for (const privateField of [
    "maxOutputTokens", "maxRequestsPerMinute", "maxConcurrentRequests", "timeoutMs", "maxRetries"
  ]) {
    assert.equal(Object.hasOwn(browserConfig, privateField), false);
  }
  assert.equal(JSON.stringify(browserConfig).includes("unit-test-credential"), false);
});

test("Server handler captures candidate endpoint registration until process replacement", async () => {
  let providerCalls = 0;
  const provider = Object.freeze({
    async generateCandidate() {
      providerCalls += 1;
      throw new Error("invalid request must not reach the candidate provider");
    }
  });
  const originalTrue = serverConfig(true);
  const originalFalse = serverConfig(false);
  const oldServer = await startServer({ config: originalTrue, npcReactionCandidateProvider: provider });
  const rollbackServer = await startServer({ config: originalFalse, npcReactionCandidateProvider: provider });
  try {
    assert.equal(await candidateStatus(oldServer.port), 400);
    assert.equal(await candidateStatus(rollbackServer.port), 404);

    originalTrue.npcStructuredReactionMode = false;
    originalFalse.npcStructuredReactionMode = true;
    assert.equal(await candidateStatus(oldServer.port), 400);
    assert.equal(await candidateStatus(rollbackServer.port), 404);
    assert.equal(providerCalls, 0);
  } finally {
    await oldServer.close();
    await rollbackServer.close();
  }
});

test("Browser caches the first runtime config, New Game does not reload it, and a fresh page uses rollback config", async () => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalAlert = globalThis.alert;
  const oldBrowser = fakeBrowserEnvironment();
  const oldTransport = browserRollbackTransport(true);
  globalThis.document = oldBrowser.document;
  globalThis.fetch = oldTransport.fetch;
  globalThis.alert = () => { throw new Error("browser initialization must not alert"); };

  try {
    await import(`../public/browserApp.mjs?rollback-old=${Date.now()}`);
    await settleBrowserInitialization();
    assert.equal(oldTransport.runtimeConfigCalls, 1);

    oldTransport.serverMode = false;
    oldBrowser.elements.newGameButton.listeners.get("click")();
    oldBrowser.elements.newGameButton.listeners.get("click")();
    assert.equal(oldTransport.runtimeConfigCalls, 1);
    oldBrowser.elements.devModeToggle.listeners.get("click")();
    assert.match(nodeText(oldBrowser.elements.developerPanel), /NPC Structured Observations/);
    assert.match(nodeText(oldBrowser.elements.developerPanel), /No NPC structured observations yet/);
    assert.doesNotMatch(nodeText(oldBrowser.elements.developerPanel), /observations unavailable/);

    oldBrowser.elements.targetSelect.value = "npc1";
    oldBrowser.elements.questionInput.value = "Who do you suspect?";
    await oldBrowser.elements.askForm.listeners.get("submit")({ preventDefault() {} });
    assert.equal(oldTransport.candidateCalls, 1);
    assert.equal(oldTransport.legacyCalls, 0);

    const freshBrowser = fakeBrowserEnvironment();
    const freshTransport = browserRollbackTransport(false);
    globalThis.document = freshBrowser.document;
    globalThis.fetch = freshTransport.fetch;
    await import(`../public/browserApp.mjs?rollback-fresh=${Date.now() + 1}`);
    await settleBrowserInitialization();
    assert.equal(freshTransport.runtimeConfigCalls, 1);
    freshBrowser.elements.devModeToggle.listeners.get("click")();
    assert.match(nodeText(freshBrowser.elements.developerPanel), /NPC structured observations unavailable/);

    freshBrowser.elements.targetSelect.value = "npc1";
    freshBrowser.elements.questionInput.value = "Who do you suspect?";
    await freshBrowser.elements.askForm.listeners.get("submit")({ preventDefault() {} });
    assert.equal(freshTransport.candidateCalls, 0);
    assert.equal(freshTransport.legacyCalls, 1);
    assert.equal(freshBrowser.elements.askButton.textContent, "Ask");
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.alert = originalAlert;
  }
});

test("CLI captures config once and a fresh false plus pseudo process performs no external fetch", async () => {
  const environment = {
    LLM_PROVIDER: "pseudo",
    INTERPRETER_VALIDATION_MODE: "true",
    PLAYER_CONVERSATION_COMMIT_MODE: "true",
    NPC_STRUCTURED_REACTION_MODE: "false",
    OPENAI_API_KEY: "unit-test-credential"
  };
  const output = [];
  const errors = [];
  const commands = ["ask npc1 Who do you suspect?", "dev", "quit"];
  let questionCount = 0;
  let externalFetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { externalFetches += 1; throw new Error("external fetch forbidden"); };
  try {
    await runCli({
      environment,
      readlineInterface: {
        async question() {
          questionCount += 1;
          if (questionCount === 1) environment.NPC_STRUCTURED_REACTION_MODE = "true";
          return commands.shift() ?? "quit";
        },
        close() {}
      },
      writeLine: (line) => output.push(String(line)),
      writeError: (line) => errors.push(String(line))
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(environment.NPC_STRUCTURED_REACTION_MODE, "true");
  assert.equal(externalFetches, 0);
  assert.equal(errors.length, 0);
  assert.match(output.join("\n"), /NPC Structured Observations/);
  assert.match(output.join("\n"), /unavailable/);
});

test("an injected CLI game does not fabricate a structured rollback contract", async () => {
  const output = [];
  let destroyed = 0;
  const game = {
    state: { gameSessionId: "external-session", playerLog: [] },
    getPublicSnapshot() { return { players: [], day: 1, phase: "day", winner: null }; },
    formatDeveloperLog() { return "external developer log"; },
    destroy() { destroyed += 1; }
  };
  const commands = ["dev", "quit"];
  await runCli({
    game,
    runtimeConfig: {
      provider: "pseudo",
      interpreterValidationMode: true,
      playerConversationCommitMode: true,
      playerStructuredConsumerMode: true,
      npcStructuredReactionMode: true
    },
    readlineInterface: { async question() { return commands.shift() ?? "quit"; }, close() {} },
    writeLine: (line) => output.push(String(line)),
    writeError: (line) => { throw new Error(`unexpected CLI error: ${line}`); }
  });
  assert.match(output.join("\n"), /NPC Structured Observations/);
  assert.match(output.join("\n"), /unavailable/);
  assert.equal(destroyed, 1);
});

test("WerewolfGame instance mode is fixed and never mixes Structured Route with legacy fallback", async () => {
  let legacyCalls = 0;
  const legacyGame = WerewolfGame.create({
    seed: 1,
    scenario: "sample",
    shuffleRoles: false,
    createId: ids("legacy"),
    interpreterValidationEnabled: true,
    playerConversationCommitEnabled: true,
    npcStructuredReactionEnabled: false,
    interpreterProvider: localInterpreter(),
    responseProvider: {
      async generateResponse() {
        legacyCalls += 1;
        return { text: "legacy", providerName: "pseudo", model: "pseudo", usage: null, notes: [] };
      }
    }
  });
  const legacyResult = await legacyGame.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Who do you suspect?" });
  assert.equal(legacyCalls, 1);
  assert.equal(legacyResult.result.text, "legacy");
  assert.equal(legacyGame.state.conversation.reactionPlans.length, 0);
  legacyGame.destroy();

  let candidateCalls = 0;
  let forbiddenLegacyCalls = 0;
  const structuredGame = enabledGame({
    invokeProvider: async (request) => {
      candidateCalls += 1;
      return createPseudoNpcReactionCandidateInvoker()(request);
    },
    responseProvider: {
      async generateResponse() {
        forbiddenLegacyCalls += 1;
        throw new Error("legacy fallback must not run");
      }
    }
  });
  const structuredResult = await structuredGame.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Who do you suspect?" });
  assert.equal(structuredResult.result.structuredNpc.legacySuppressed, true);
  assert.equal(candidateCalls, 1);
  assert.equal(forbiddenLegacyCalls, 0);
  assert.equal(structuredGame.state.conversation.reactionPlans.length, 1);
  structuredGame.destroy();
});

test("rollback runbook has the exact operator structure, required recovery boundaries, and no secret fixture", () => {
  const runbook = readFileSync(RUNBOOK_URL, "utf8");
  const headings = [...runbook.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, [
    "1. 目的",
    "2. 対象と非対象",
    "3. 重要な安全原則",
    "4. 実装上のflag取得タイミング",
    "5. rollback目的の選択",
    "6. rollback前の状態判定",
    "7. Browserのgraceful rollback",
    "8. Browserのemergency rollback",
    "9. CLIのgraceful rollback",
    "10. CLIのemergency rollback",
    "11. rollback後の検証",
    "12. in-flight／commit／deliveryの扱い",
    "13. 診断情報の取得とprivacy",
    "14. 失敗時の停止条件",
    "15. 既知の制約",
    "16. 再有効化について",
    "17. operator checklist"
  ]);

  for (const marker of [
    "Objective A", "Objective B", "New Gameだけでは不十分", "server process restart",
    "full reload", "process exit後にrestart", "route_in_progress", "player_display_pending",
    "delivery_retry_pending", "terminal_delivery", "unknown", "repeat_sink", "ack_only",
    "Provider、Validation、Preparation、Commit、Player action dispatchは0回",
    "OPENAI_FALLBACK_TO_PSEUDO=true`だけでは不十分", "Remove-Item Env:OPENAI_API_KEY",
    "unset OPENAI_API_KEY", "POST /api/generate-npc-reaction-candidate", "`404`",
    "stateVersion` decrementは0", "old sessionを新processで回復しない", "billable live smokeは未実施"
  ]) {
    assert.ok(runbook.includes(marker), `missing runbook contract marker: ${marker}`);
  }
  for (const commandMarker of [
    "production serverのdefault `4173`", "$env:PORT", "$baseUrl = \"http://127.0.0.1:$port\"",
    "Invoke-RestMethod", "$config.npcStructuredReactionMode -ne $false", "Invoke-WebRequest",
    "$candidateStatus -ne 404", "port=\"${PORT:-4173}\"", "base_url=\"http://127.0.0.1:${port}\"",
    "curl --silent", "test \"$config_status\" = \"200\"", "config.npcStructuredReactionMode !== false",
    "test \"$candidate_status\" = \"404\""
  ]) {
    assert.ok(runbook.includes(commandMarker), `missing executable verification marker: ${commandMarker}`);
  }
  assert.doesNotMatch(runbook, /127\.0\.0\.1:3000/);
  const verificationBlocks = [...runbook.matchAll(/```(?:powershell|bash)\n([\s\S]*?)\n```/g)]
    .map((match) => match[1])
    .filter((block) => block.includes("/api/generate-npc-reaction-candidate"));
  assert.equal(verificationBlocks.length, 2);
  for (const block of verificationBlocks) {
    assert.match(block, /(?:-Body \"\{\}\"|--data '\{\}')/);
    assert.doesNotMatch(block, /OPENAI_API_KEY|Authorization|private question|Known Information|role|team/i);
  }
  assert.doesNotMatch(runbook, /sk-(?:proj-)?[A-Za-z0-9_-]{8,}/);
  assert.doesNotMatch(runbook, /C:\\Users\\|\/home\/|Authorization:\s*Bearer/);
  assert.doesNotMatch(runbook, /hot toggle.{0,20}(?:可能|supported)/i);
});

function serverConfig(enabled) {
  return {
    provider: "pseudo",
    npcStructuredReactionMode: enabled,
    interpreterValidationMode: true,
    interpreterShadowMode: false,
    playerConversationCommitMode: true,
    playerStructuredConsumerMode: false,
    openai: null
  };
}

async function startServer(options) {
  const server = createWebServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function candidateStatus(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/generate-npc-reaction-candidate`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: "{}"
  });
  return response.status;
}

function browserRollbackTransport(initialMode) {
  let serverMode = initialMode;
  let runtimeConfigCalls = 0;
  let candidateCalls = 0;
  let legacyCalls = 0;
  return {
    get runtimeConfigCalls() { return runtimeConfigCalls; },
    get candidateCalls() { return candidateCalls; },
    get legacyCalls() { return legacyCalls; },
    get serverMode() { return serverMode; },
    set serverMode(value) { serverMode = value; },
    async fetch(url) {
      if (url === "/api/runtime-config") {
        runtimeConfigCalls += 1;
        return new Response(JSON.stringify({
          provider: "pseudo",
          interpreterShadowMode: false,
          interpreterValidationMode: true,
          playerConversationCommitMode: true,
          playerStructuredConsumerMode: true,
          npcStructuredReactionMode: serverMode
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/generate-npc-reaction-candidate") {
        candidateCalls += 1;
        assert.equal(serverMode, false);
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
      if (url === "/api/npc-response") {
        legacyCalls += 1;
        return new Response(JSON.stringify({
          text: "legacy response",
          providerName: "pseudo",
          model: "pseudo",
          usage: null,
          notes: []
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected Browser rollback URL: ${url}`);
    }
  };
}

function fakeBrowserEnvironment() {
  class FakeNode {
    constructor(tagName) {
      this.tagName = tagName;
      this.nodeType = tagName === "#text" ? 3 : 1;
      this.children = [];
      this.childNodes = this.children;
      this.dataset = {};
      this.listeners = new Map();
      this.parentNode = null;
      this.textContent = "";
      this.value = "";
      this.hidden = false;
      this.disabled = false;
      this.className = "";
      this.scrollTop = 0;
    }
    get firstChild() { return this.children[0] ?? null; }
    get lastChild() { return this.children.at(-1) ?? null; }
    get scrollHeight() { return this.children.length; }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) { node.remove?.(); this.children.push(node); node.parentNode = this; return node; }
    replaceChildren(...nodes) {
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      this.childNodes = this.children;
      this.append(...nodes);
    }
    remove() {
      if (!this.parentNode) return;
      const parent = this.parentNode;
      parent.children = parent.children.filter((child) => child !== this);
      parent.childNodes = parent.children;
      this.parentNode = null;
    }
    contains(node) { return this === node || this.children.some((child) => child.contains?.(node)); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    setAttribute(name, value) { this[name] = String(value); }
    querySelectorAll(selector) {
      const field = selector === "[data-publication-id]" ? "publicationId"
        : selector === "[data-npc-publication-id]" ? "npcPublicationId" : null;
      if (!field) return [];
      const found = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (Object.hasOwn(child.dataset, field)) found.push(child);
          visit(child);
        }
      };
      visit(this);
      return found;
    }
  }

  const elementIds = [
    "statusLine", "newGameButton", "playerGrid", "askForm", "targetSelect", "questionInput",
    "askButton", "voteButton", "nightButton", "logList", "voteList", "devModeToggle", "developerPanel"
  ];
  const elements = Object.fromEntries(elementIds.map((id) => [id, new FakeNode(id)]));
  const document = {
    querySelector(selector) { return elements[selector.slice(1)]; },
    createElement(tagName) { return new FakeNode(tagName); },
    createTextNode(text) { const node = new FakeNode("#text"); node.textContent = text; return node; }
  };
  return { document, elements };
}

function nodeText(node) {
  return [node.textContent, ...node.children.flatMap((child) => nodeText(child))].filter(Boolean).join("\n");
}

async function settleBrowserInitialization() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function enabledGame({ invokeProvider, responseProvider } = {}) {
  const candidateProvider = createNpcReactionCandidateProvider({
    invokeProvider: invokeProvider ?? createPseudoNpcReactionCandidateInvoker()
  });
  const transport = createLocalNpcReactionCandidateTransport({
    provider: candidateProvider,
    createServerCorrelationId: ids("server")
  });
  return WerewolfGame.create({
    seed: 1,
    scenario: "sample",
    shuffleRoles: false,
    createId: ids("structured"),
    interpreterValidationEnabled: true,
    playerConversationCommitEnabled: true,
    npcStructuredReactionEnabled: true,
    interpreterProvider: localInterpreter(),
    responseProvider,
    createNpcStructuredProductionIntegration: ({ gameSessionId, authorityPort, deliveryReadPort }) =>
      createProductionNpcStructuredDeliveryIntegration({
        gameSessionId,
        authorityPort,
        deliveryReadPort,
        candidateTransport: transport,
        sink: createNpcCliPublicationSink({ write: async () => {}, failureGuarantee: "unknown_on_failure" }),
        consumer: { consumerId: "rollback-cli", sinkType: "cli" },
        createId: ids("runtime"),
        nowUtc: () => "2026-07-20T00:00:00.000Z",
        nowMonotonicMs: () => Math.floor(performance.now()),
        scheduleTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        cancelTimer: (handle) => clearTimeout(handle),
        createAbortController: () => new AbortController(),
        observer: () => {}
      })
  });
}

function localInterpreter() {
  return createLocalInterpreterHttpProvider(new PseudoInterpreterProvider(), {
    createServerCorrelationId: ids("interpreter")
  });
}

function ids(prefix) {
  let order = 0;
  return () => `${prefix}-${++order}`;
}
