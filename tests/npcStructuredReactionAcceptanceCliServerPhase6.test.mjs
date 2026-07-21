import assert from "node:assert/strict";
import test from "node:test";

import { HttpResponseProvider } from "../public/httpResponseProvider.mjs";
import { runCli } from "../src/cli.mjs";
import { createNpcReactionCandidateProvider } from "../src/npcReactionCandidateProvider.mjs";
import { createPseudoNpcReactionCandidateInvoker } from "../src/npcReactionCandidateUpstream.mjs";
import { createWebServer } from "../src/webServer.mjs";
import {
  assertPrivacySafe,
  completePlayerAndNpc,
  createAcceptanceGame,
  createDeliveryAcceptanceGame
} from "./helpers/npcStructuredReactionAcceptanceHarness.mjs";

for (const [id, consumerEnabled] of [["ACC-018", false], ["ACC-019", true]]) {
  test(`${id} actual CLI preserves two-question order and vote/night continuity with consumer ${consumerEnabled ? "on" : "off"}`, async () => {
    const order = [];
    const output = [];
    const errors = [];
    const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
    const { game } = createAcceptanceGame({
      counters,
      playerStructuredConsumerEnabled: consumerEnabled,
      npcWrite: async () => { order.push("npc"); }
    });
    const commands = [
      "ask npc1 CLI question A?",
      "ask npc2 CLI question B?",
      "state",
      "vote",
      "dev",
      "quit"
    ];
    await runCli({
      game,
      runtimeConfig: { playerStructuredConsumerMode: consumerEnabled },
      readlineInterface: { async question() { return commands.shift() ?? "quit"; }, close() {} },
      writeLine: (line) => output.push(String(line)),
      writeError: (line) => errors.push(String(line)),
      writePublicationText: async (text) => {
        if (text.includes("CLI question")) order.push("player");
      },
      destroyOnExit: false
    });
    assert.deepEqual(order.slice(0, 4), ["player", "npc", "player", "npc"]);
    assert.equal(counters.candidate, 2);
    assert.equal(counters.legacy, 0);
    assert.equal(game.state.conversation.reactionPlans.length, 2);
    assert.equal(game.state.voteHistory.length, 1);
    assert.equal(game.state.day, 2);
    assert.equal(game.state.phase, "day_discussion");
    assert.deepEqual(errors, []);
    assertPrivacySafe(output.join("\n"));
    game.destroy();
  });
}

test("ACC-020 actual CLI retry preserves the same action after Player writer failure", async () => {
  const order = [];
  const errors = [];
  let playerAttempts = 0;
  const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
  const { game } = createAcceptanceGame({
    counters,
    playerStructuredConsumerEnabled: true,
    npcWrite: async () => { order.push("npc"); }
  });
  const commands = ["ask npc1 CLI retry question?", "retry", "retry", "state", "quit"];
  await runCli({
    game,
    runtimeConfig: { playerStructuredConsumerMode: true },
    readlineInterface: { async question() { return commands.shift() ?? "quit"; }, close() {} },
    writeLine: () => {},
    writeError: (line) => errors.push(String(line)),
    writePublicationText: async (text) => {
      if (!text.includes("CLI retry question?")) return;
      playerAttempts += 1;
      if (playerAttempts === 1) throw new Error("player writer failed");
      order.push("player");
    },
    destroyOnExit: false
  });
  assert.equal(playerAttempts, 2);
  assert.deepEqual(order, ["player", "npc"]);
  assert.equal(counters.candidate, 1);
  assert.equal(counters.legacy, 0);
  assert.equal(game.state.conversation.reactionPlans.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /player writer failed/);
  game.destroy();
});

test("ACC-021 actual CLI observability is bounded, redacted, and absent from normal output", async () => {
  const output = [];
  const errors = [];
  const commands = ["ask npc1 CLI observation?", "dev", "quit"];
  await runCli({
    runtimeConfig: structuredRuntimeConfig(true),
    showDev: true,
    readlineInterface: { async question() { return commands.shift() ?? "quit"; }, close() {} },
    writeLine: (line) => output.push(String(line)),
    writeError: (line) => errors.push(String(line))
  });
  const observationBlocks = output.filter((line) => line.includes("--- NPC Structured Observations ---"));
  assert.ok(observationBlocks.length >= 1);
  const observationText = observationBlocks.join("\n");
  assert.match(observationText, /source=route/);
  assert.match(observationText, /source=delivery_controller/);
  assert.match(observationText, /source=delivery_orchestrator/);
  assertPrivacySafe(observationText);
  for (const forbidden of ["knownInformation", "privateMemory", "promptPreview", "rawResponse", "retryToken", "receiptId"]) {
    assert.equal(observationText.includes(forbidden), false);
  }
  assert.deepEqual(errors, []);

  const normalOutput = [];
  const normalCommands = ["ask npc1 CLI normal output?", "quit"];
  await runCli({
    runtimeConfig: structuredRuntimeConfig(true),
    showDev: false,
    readlineInterface: { async question() { return normalCommands.shift() ?? "quit"; }, close() {} },
    writeLine: (line) => normalOutput.push(String(line)),
    writeError: (line) => { throw new Error(`unexpected CLI error: ${line}`); }
  });
  assert.equal(normalOutput.join("\n").includes("NPC Structured Observations"), false);
});

test("ACC-022 actual Server keeps the candidate endpoint absent when the flag is off", async () => {
  let candidateCalls = 0;
  await withServer({
    config: structuredRuntimeConfig(false),
    npcReactionCandidateProvider: { async generateCandidate() { candidateCalls += 1; throw new Error("must not run"); } }
  }, async (baseUrl) => {
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:/);
    const config = await fetch(`${baseUrl}/api/runtime-config`);
    assert.equal(config.status, 200);
    assert.equal((await config.json()).npcStructuredReactionMode, false);
    const candidate = await fetch(`${baseUrl}/api/generate-npc-reaction-candidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: "{}"
    });
    assert.equal(candidate.status, 404);
    assert.equal(candidateCalls, 0);
  });
});

test("ACC-023 actual HttpResponseProvider and localhost Server complete one candidate, commit, and delivery", async () => {
  let providerCalls = 0;
  const pseudo = createPseudoNpcReactionCandidateInvoker();
  const candidateProvider = createNpcReactionCandidateProvider({
    invokeProvider: async (request, options) => {
      providerCalls += 1;
      return pseudo(request, options);
    }
  });
  await withServer({
    config: structuredRuntimeConfig(true),
    npcReactionCandidateProvider: candidateProvider
  }, async (baseUrl) => {
    const requestTargets = [];
    const httpProvider = new HttpResponseProvider({
      fetch: async (url, options) => {
        const target = new URL(url, baseUrl);
        assert.equal(target.origin, new URL(baseUrl).origin);
        requestTargets.push(target.pathname);
        assert.equal(Object.hasOwn(options.headers, ["Author", "ization"].join("")), false);
        return fetch(target, options);
      }
    });
    const counters = { candidate: 0, legacy: 0, npcWrites: 0, playerWrites: 0 };
    const { game } = createDeliveryAcceptanceGame({
      counters,
      idPrefix: "loopback-game",
      candidateTransport: Object.freeze({
        generateCandidateTransport: httpProvider.generateCandidateTransport.bind(httpProvider)
      })
    });
    const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Loopback candidate?" });
    const { delivery } = await completePlayerAndNpc(game, action, { counters });
    assert.equal(action.result.structuredNpc.routeStatus, "committed");
    assert.equal(delivery.deliveryStatus, "delivered");
    assert.deepEqual(requestTargets, ["/api/generate-npc-reaction-candidate"]);
    assert.equal(providerCalls, 1);
    assert.equal(counters.legacy, 0);
    assert.equal(counters.npcWrites, 1);
    assert.equal(game.state.phase, "day_discussion");
    assert.equal(game.state.conversation.reactionPlans.length, 1);
    game.destroy();
  });
});

test("ACC-024 actual Server rejects malformed candidate requests without invoking the Provider and remains reusable", async () => {
  let providerCalls = 0;
  const provider = { async generateCandidate() { providerCalls += 1; throw new Error("must not run"); } };
  await withServer({ config: structuredRuntimeConfig(true), npcReactionCandidateProvider: provider }, async (baseUrl) => {
    const wrongMethod = await fetch(`${baseUrl}/api/generate-npc-reaction-candidate`, { method: "GET" });
    assert.equal(wrongMethod.status, 405);

    const encoded = await fetch(`${baseUrl}/api/generate-npc-reaction-candidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "identity" },
      body: "{}"
    });
    assert.equal(encoded.status, 415);
    assertPrivacySafe(await encoded.text());

    const malformed = await fetch(`${baseUrl}/api/generate-npc-reaction-candidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: "{"
    });
    assert.equal(malformed.status, 400);
    assertPrivacySafe(await malformed.text());
    assert.equal(providerCalls, 0);

    const runtime = await fetch(`${baseUrl}/api/runtime-config`);
    assert.equal(runtime.status, 200);
    assert.equal((await runtime.json()).npcStructuredReactionMode, true);
  });
});

function structuredRuntimeConfig(npcStructuredReactionMode) {
  return {
    provider: "pseudo",
    interpreterShadowMode: false,
    interpreterValidationMode: true,
    playerConversationCommitMode: true,
    playerStructuredConsumerMode: true,
    npcStructuredReactionMode,
    openai: { maxRequestsPerMinute: 60 }
  };
}

async function withServer(options, callback) {
  const server = createWebServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.equal(address.address, "127.0.0.1");
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
