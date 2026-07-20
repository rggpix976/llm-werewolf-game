import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { WerewolfGame } from "../src/gameEngine.mjs";
import { createLocalInterpreterHttpProvider, PseudoInterpreterProvider } from "../src/interpreterTransport.mjs";
import { createNpcCliPublicationSink } from "../src/npcCliPublicationSink.mjs";
import { createProductionNpcStructuredDeliveryIntegration } from "../src/npcProductionIntegration.mjs";
import { createNpcReactionCandidateProvider } from "../src/npcReactionCandidateProvider.mjs";
import { createLocalNpcReactionCandidateTransport } from "../src/npcReactionCandidateTransport.mjs";
import { createPseudoNpcReactionCandidateInvoker } from "../src/npcReactionCandidateUpstream.mjs";
import { consumeLiveActionDisplay } from "../src/playerDisplaySink.mjs";

test("NPC delivery remains pending until the exact Player publication has display evidence", async () => {
  const order = [];
  const game = enabledGame({ npcWrite: async () => { order.push("npc"); } });
  const action = await ask(game);
  const playerPublicationId = action.result.conversationCommitResult.playerPublicationId;

  assert.equal(action.result.structuredNpc.routeStatus, "committed");
  assert.equal(action.result.structuredNpc.deliveryStatus, "pending_player_display");
  assert.deepEqual(order, []);
  const authoritativeBeforeDisplay = JSON.stringify(game.state);
  assert.deepEqual(Reflect.ownKeys(game.npcStructuredProductionIntegration), [
    "executeNpcReaction", "pumpNpcPublicationAfterPlayerDisplay", "reset"
  ]);

  const pending = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId
  });
  assert.equal(pending.deliveryStatus, "pending_player_display");
  assert.deepEqual(order, []);

  await displayPlayer(game, action, async () => { order.push("player"); });
  const completed = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId
  });
  assert.equal(completed.deliveryStatus, "delivered");
  assert.deepEqual(order, ["player", "npc"]);
  assert.equal(Object.isFrozen(completed), true);
  assert.equal(JSON.stringify(game.state), authoritativeBeforeDisplay);
  for (const marker of ["knownInformation", "ownRole", "ownTeam", "retryToken", "receiptId", "stack", "cause"]) {
    assert.equal(JSON.stringify(completed).includes(marker), false);
  }

  const duplicate = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId
  });
  assert.equal(duplicate, completed);
  assert.deepEqual(order, ["player", "npc"]);
  game.destroy();
});

test("legacy-compatible Player evidence also gates NPC delivery", async () => {
  const order = [];
  const game = enabledGame({ playerStructuredConsumerEnabled: false, npcWrite: async () => { order.push("npc"); } });
  const action = await ask(game);
  const playerPublicationId = action.result.conversationCommitResult.playerPublicationId;
  await displayPlayer(game, action, async () => { order.push("player"); });
  assert.equal(game.playerPublicationDeliveryController.stateFor(playerPublicationId), "evidence_recorded");
  await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({ schemaVersion: 1, gameSessionId: game.state.gameSessionId, playerPublicationId });
  assert.deepEqual(order, ["player", "npc"]);
  game.destroy();
});

test("pending handoff blocks mutation, allows reads, and rejects malformed identities without effects", async () => {
  let npcWrites = 0;
  const game = enabledGame({ npcWrite: async () => { npcWrites += 1; } });
  const action = await ask(game);
  const playerPublicationId = action.result.conversationCommitResult.playerPublicationId;
  const version = game.state.stateVersion;

  const state = await game.dispatchPlayerAction({ type: "get_state" });
  assert.equal(state.ok, true);
  assert.equal(game.state.stateVersion, version);
  await assert.rejects(
    () => game.dispatchPlayerAction({ type: "advance_vote" }),
    (error) => error.code === "input_in_progress"
  );
  assert.equal(game.state.stateVersion, version);

  const exact = { schemaVersion: 1, gameSessionId: game.state.gameSessionId, playerPublicationId };
  const sourceBefore = structuredClone(exact);
  const malformed = [
    {},
    ...Object.keys(exact).map((field) => Object.fromEntries(Object.entries(exact).filter(([key]) => key !== field))),
    { ...exact, extra: true },
    { ...exact, schemaVersion: 2 },
    Object.assign(Object.create({ inherited: true }), exact),
    Object.defineProperty({ ...exact }, "playerPublicationId", { enumerable: true, get: () => playerPublicationId }),
    Object.assign({ ...exact }, { [Symbol("hidden")]: true })
  ];
  for (const value of malformed) {
    await assert.rejects(
      () => game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(value),
      TypeError
    );
  }
  await assert.rejects(
    () => game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({ ...exact, gameSessionId: "other-session" }),
    (error) => error.code === "stale_session"
  );
  await assert.rejects(
    () => game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({ ...exact, playerPublicationId: "other-publication" }),
    (error) => error.code === "publication_not_found"
  );
  assert.equal(npcWrites, 0);
  assert.equal(game.state.stateVersion, version);
  assert.deepEqual(exact, sourceBefore);
  game.destroy();
});

test("integration pump input is strict and reset before Player evidence starts no sink", async () => {
  let npcWrites = 0;
  const game = enabledGame({ npcWrite: async () => { npcWrites += 1; } });
  const action = await ask(game);
  const integration = game.npcStructuredProductionIntegration;
  for (const value of [
    {},
    null,
    { schemaVersion: 1, gameSessionId: game.state.gameSessionId, extra: true },
    { schemaVersion: 2, gameSessionId: game.state.gameSessionId },
    { schemaVersion: 1, gameSessionId: "other-session" },
    Object.assign(Object.create({ inherited: true }), { schemaVersion: 1, gameSessionId: game.state.gameSessionId }),
    Object.defineProperty({ gameSessionId: game.state.gameSessionId }, "schemaVersion", { enumerable: true, get: () => 1 }),
    Object.assign({ schemaVersion: 1, gameSessionId: game.state.gameSessionId }, { [Symbol("hidden")]: true })
  ]) {
    await assert.rejects(() => integration.pumpNpcPublicationAfterPlayerDisplay(value), TypeError);
  }
  integration.reset();
  await displayPlayer(game, action, async () => {});
  const result = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId: action.result.conversationCommitResult.playerPublicationId
  });
  assert.equal(result.routeStatus, "reset");
  assert.equal(npcWrites, 0);
  game.destroy();
});

test("concurrent completion pumps once and destroy makes late completion stale", async () => {
  let releaseNpc;
  let npcWrites = 0;
  const game = enabledGame({
    npcWrite: async () => {
      npcWrites += 1;
      await new Promise((resolve) => { releaseNpc = resolve; });
    }
  });
  const action = await ask(game);
  await displayPlayer(game, action, async () => {});
  const input = {
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId: action.result.conversationCommitResult.playerPublicationId
  };
  const first = game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input),
    (error) => error.code === "input_in_progress"
  );
  assert.equal(npcWrites, 1);
  game.destroy();
  releaseNpc();
  await first;
  await assert.rejects(
    () => game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input),
    (error) => error.code === "stale_session"
  );
  assert.equal(npcWrites, 1);
});

test("Player display failure never starts the NPC sink and can be retried explicitly", async () => {
  let npcWrites = 0;
  const game = enabledGame({ npcWrite: async () => { npcWrites += 1; } });
  const action = await ask(game);
  const input = {
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId: action.result.conversationCommitResult.playerPublicationId
  };
  await assert.rejects(() => displayPlayer(game, action, async () => { throw new Error("player write failed"); }));
  assert.equal(npcWrites, 0);
  assert.equal((await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input)).deliveryStatus, "pending_player_display");
  await displayPlayer(game, action, async () => {});
  await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input);
  assert.equal(npcWrites, 1);
  game.destroy();
});

test("Browser and CLI entrypoints encode Player-first sequencing and stale-session DOM isolation", () => {
  const browser = readFileSync(new URL("../public/browserApp.mjs", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../src/cli.mjs", import.meta.url), "utf8");

  const browserConsume = browser.indexOf("await consumeLiveActionDisplay");
  const browserComplete = browser.indexOf("completeNpcStructuredReactionDeliveryAfterPlayerDisplay");
  assert.ok(browserConsume >= 0 && browserComplete > browserConsume);
  assert.match(browser, /sessionManager\.isCurrentGame\(gameIdAtStart\)[\s\S]*completeNpcStructuredReactionDeliveryAfterPlayerDisplay/);
  assert.match(browser, /capturedGameId[\s\S]*isCurrentGame\(capturedGameId\)/);
  assert.match(browser, /querySelectorAll\("\[data-npc-publication-id\]"\)[\s\S]*node\.remove\(\)/);
  assert.ok(browser.indexOf("node.remove()") < browser.indexOf("npcPublicationDomBookkeeping.clear()"));
  assert.equal(browser.includes("merged.push(...untrackedNpcNodes)"), false);
  assert.match(browser, /createTextNode: \(text\) => document\.createTextNode\(text\)/);

  const cliConsume = cli.indexOf("await consumeLiveActionDisplay");
  const cliComplete = cli.indexOf("completeNpcStructuredReactionDeliveryAfterPlayerDisplay");
  assert.ok(cliConsume >= 0 && cliComplete > cliConsume);
});

test("Browser New Game and renderLogs remove old or untracked NPC nodes in the actual entrypoint", async () => {
  const browser = fakeBrowserEnvironment();
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalAlert = globalThis.alert;
  globalThis.document = browser.document;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        provider: "pseudo",
        interpreterShadowMode: false,
        interpreterValidationMode: false,
        playerConversationCommitMode: false,
        playerStructuredConsumerMode: false,
        npcStructuredReactionMode: false
      };
    }
  });
  globalThis.alert = () => { throw new Error("browser initialization must not alert"); };
  try {
    await import(`../public/browserApp.mjs?npc-cleanup=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const oldNode = browser.document.createElement("div");
    oldNode.dataset.npcPublicationId = "old-publication";
    oldNode.dataset.browserGameId = "1";
    browser.elements.logList.append(oldNode);
    assert.equal(oldNode.parentNode, browser.elements.logList);
    browser.elements.newGameButton.listeners.get("click")();
    assert.equal(oldNode.parentNode, null);
    assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 0);

    const untracked = browser.document.createElement("div");
    untracked.dataset.npcPublicationId = "untracked-current-looking-publication";
    untracked.dataset.browserGameId = "2";
    browser.elements.logList.append(untracked);
    await browser.elements.voteButton.listeners.get("click")();
    assert.equal(untracked.parentNode, null);
    assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 0);
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.alert = originalAlert;
  }
});

async function ask(game) {
  return game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Who do you suspect?" });
}

async function displayPlayer(game, action, write) {
  const bookkeeping = new Map();
  await consumeLiveActionDisplay({
    game,
    action,
    consumerId: "test-player",
    sinkType: "cli",
    bookkeeping,
    writeStructured: write,
    writeLegacy: write
  });
}

function enabledGame({ npcWrite, playerStructuredConsumerEnabled = true } = {}) {
  const provider = createNpcReactionCandidateProvider({ invokeProvider: createPseudoNpcReactionCandidateInvoker() });
  let serverCorrelationOrder = 0;
  const candidateTransport = createLocalNpcReactionCandidateTransport({
    provider,
    createServerCorrelationId: () => `server-candidate-${++serverCorrelationOrder}`
  });
  return WerewolfGame.create({
    seed: 1,
    scenario: "sample",
    shuffleRoles: false,
    createId: ids("game"),
    interpreterValidationEnabled: true,
    playerConversationCommitEnabled: true,
    playerStructuredConsumerEnabled,
    npcStructuredReactionEnabled: true,
    interpreterProvider: createLocalInterpreterHttpProvider(new PseudoInterpreterProvider(), {
      createServerCorrelationId: ids("server-interpreter")
    }),
    createNpcStructuredProductionIntegration: ({ gameSessionId, authorityPort, deliveryReadPort }) => {
      const sink = createNpcCliPublicationSink({
        write: async ({ text }) => npcWrite?.(text),
        failureGuarantee: "unknown_on_failure"
      });
      return createProductionNpcStructuredDeliveryIntegration({
        gameSessionId,
        authorityPort,
        deliveryReadPort,
        candidateTransport,
        sink,
        consumer: { consumerId: "cli-npc", sinkType: "cli" },
        createId: ids("runtime"),
        nowUtc: () => "2026-07-20T00:00:00.000Z",
        nowMonotonicMs: () => Math.floor(performance.now()),
        scheduleTimer: (callback, delay) => setTimeout(callback, delay),
        cancelTimer: (handle) => clearTimeout(handle),
        createAbortController: () => new AbortController(),
        observer: () => {}
      });
    }
  });
}

function ids(prefix) {
  let order = 0;
  return () => `${prefix}-${++order}`;
}

function fakeBrowserEnvironment() {
  class FakeNode {
    constructor(tagName) {
      this.tagName = tagName;
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
    get scrollHeight() { return this.children.length; }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) {
      node.remove?.();
      this.children.push(node);
      node.parentNode = this;
      return node;
    }
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

  const ids = [
    "statusLine", "newGameButton", "playerGrid", "askForm", "targetSelect", "questionInput",
    "askButton", "voteButton", "nightButton", "logList", "voteList", "devModeToggle", "developerPanel"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeNode(id)]));
  const document = {
    querySelector(selector) { return elements[selector.slice(1)]; },
    createElement(tagName) { return new FakeNode(tagName); },
    createTextNode(text) { const node = new FakeNode("#text"); node.nodeType = 3; node.textContent = text; return node; }
  };
  return { document, elements };
}
