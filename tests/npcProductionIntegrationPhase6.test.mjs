import assert from "node:assert/strict";
import test from "node:test";

import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoInterpreterProvider, createLocalInterpreterHttpProvider } from "../src/interpreterTransport.mjs";
import { createNpcReactionCandidateProvider } from "../src/npcReactionCandidateProvider.mjs";
import { createLocalNpcReactionCandidateTransport } from "../src/npcReactionCandidateTransport.mjs";
import {
  createOpenAINpcReactionCandidateInvoker,
  createPseudoNpcReactionCandidateInvoker
} from "../src/npcReactionCandidateUpstream.mjs";
import { createNpcCliPublicationSink } from "../src/npcCliPublicationSink.mjs";
import { createNpcBrowserPublicationSink } from "../src/npcBrowserPublicationSink.mjs";
import { createProductionNpcStructuredDeliveryIntegration } from "../src/npcProductionIntegration.mjs";
import { consumeLiveActionDisplay } from "../src/playerDisplaySink.mjs";
import { HttpResponseProvider } from "../public/httpResponseProvider.mjs";
import { createWebServer } from "../src/webServer.mjs";

test("production integration has an exact three-method public surface and strict dependencies", () => {
  assert.throws(() => createProductionNpcStructuredDeliveryIntegration({}), TypeError);
  assert.throws(() => enabledGame({ extraFactoryField: true }), /npc_structured_integration_required|Invalid/);
  const game = enabledGame();
  assert.deepEqual(Reflect.ownKeys(game.npcStructuredProductionIntegration), [
    "executeNpcReaction", "pumpNpcPublicationAfterPlayerDisplay", "reset"
  ]);
  game.destroy();
});

test("browser candidate transport preserves the exact HTTP response bytes", async () => {
  const bytes = new TextEncoder().encode('{"schemaVersion":1,"exact":"  É  "}');
  const provider = new HttpResponseProvider({
    fetch: async () => ({
      status: 200,
      headers: { get: (name) => name === "content-type" ? "application/json; charset=utf-8" : null },
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
    })
  });
  const result = await provider.generateCandidateTransport({ requestId: "request-1" });
  assert.deepEqual([...result.transportEvidence.bodyBytes], [...bytes]);
  assert.equal(result.transportEvidence.contentTypeHeader, "application/json; charset=utf-8");
});

test("server candidate endpoint is registered only for the explicit production flag", async () => {
  for (const [enabled, expectedStatus] of [[false, 404], [true, 400]]) {
    const server = createWebServer({ config: {
      provider: "pseudo",
      npcStructuredReactionMode: enabled,
      interpreterValidationMode: true,
      interpreterShadowMode: false,
      playerConversationCommitMode: true,
      playerStructuredConsumerMode: false,
      openai: { maxRequestsPerMinute: 60 }
    } });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/generate-npc-reaction-candidate`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: "{}"
      });
      assert.equal(response.status, expectedStatus);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("flag disabled preserves the legacy provider path", async () => {
  let legacyCalls = 0;
  const game = WerewolfGame.create({
    seed: 1, scenario: "sample", shuffleRoles: false, createId: ids("legacy"),
    interpreterValidationEnabled: true, playerConversationCommitEnabled: true,
    npcStructuredReactionEnabled: false, interpreterProvider: localInterpreter(),
    responseProvider: { async generateResponse() { legacyCalls += 1; return { text: "legacy", providerName: "legacy", model: "test", usage: null, notes: [] }; } }
  });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "What do you think?" });
  assert.equal(legacyCalls, 1);
  assert.equal(action.result.text, "legacy");
  assert.equal(game.state.stateVersion, 2);
  assert.equal(game.state.conversation.npcReactionCommitIdempotencyRecords.length, 0);
});

test("flag enabled commits and delivers once through CLI while suppressing legacy", async () => {
  const writes = [];
  let legacyCalls = 0;
  const game = enabledGame({
    writes,
    responseProvider: { async generateResponse() { legacyCalls += 1; throw new Error("legacy must not run"); } }
  });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Who do you suspect?" });
  assert.equal(legacyCalls, 0);
  assert.equal(action.result.structuredNpc.legacySuppressed, true);
  assert.equal(action.result.structuredNpc.legacyUsed, false);
  assert.equal(action.result.structuredNpc.routeStatus, "committed");
  assert.equal(action.result.structuredNpc.deliveryStatus, "pending_player_display");
  assert.equal(writes.length, 0);
  const completed = await completePlayerThenNpc(game, action);
  assert.equal(completed.deliveryStatus, "delivered");
  assert.equal(writes.length, 1);
  assert.equal(game.state.stateVersion, 2);
  assert.equal(game.state.conversation.reactionPlans.length, 1);
  assert.equal(game.state.conversation.npcReactionCommitIdempotencyRecords.length, 1);
  assert.equal(game.state.playerLog.some((entry) => entry.message === writes[0]), false);
  assert.equal(Object.isFrozen(action.result.structuredNpc), true);
  for (const marker of ["knownInformation", "ownRole", "ownTeam", "retryToken", "receiptId", "diagnostics", "stack", "cause"]) {
    assert.equal(JSON.stringify(action.result.structuredNpc).includes(marker), false);
  }
});

test("browser production sink attaches canonical text exactly once and reset prevents reuse", async () => {
  const dom = fakeDom();
  const game = enabledGame({ sinkType: "browser", dom });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Who do you suspect?" });
  assert.equal(action.result.structuredNpc.deliveryStatus, "pending_player_display");
  assert.equal(dom.container.children.length, 0);
  const completed = await completePlayerThenNpc(game, action);
  assert.equal(completed.deliveryStatus, "delivered");
  assert.equal(dom.container.children.length, 1);
  assert.equal(dom.container.children[0].childNodes.length, 1);
  assert.equal(dom.container.children[0].childNodes[0].nodeType, 3);
  game.destroy();
  assert.equal(dom.container.children.length, 1);
  const resetResult = await game.npcStructuredProductionIntegration.executeNpcReaction({ schemaVersion: 1, gameSessionId: game.state.gameSessionId, triggerRequestId: "x", originatingInputRecordId: "y" });
  assert.equal(resetResult.routeStatus, "reset");
  assert.equal(dom.container.children.length, 1);
});

test("enabled route failure is redacted and never falls back to legacy", async () => {
  let legacyCalls = 0;
  const game = enabledGame({
    invokeProvider: async () => { const error = new Error("PRIVATE_PROVIDER_FAILURE"); error.code = "provider_unavailable"; throw error; },
    responseProvider: { async generateResponse() { legacyCalls += 1; return { text: "legacy", providerName: "legacy" }; } }
  });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Who do you suspect?" });
  assert.equal(legacyCalls, 0);
  assert.equal(action.result.structuredNpc.legacySuppressed, true);
  assert.equal(JSON.stringify(action.result.structuredNpc).includes("PRIVATE_PROVIDER_FAILURE"), false);
  assert.equal(game.state.stateVersion, 2);
  assert.equal(game.state.phase, "day_discussion");
});

test("authoritative replay never pumps delivery or repeats the legacy or CLI sinks", async () => {
  const writes = [];
  let legacyCalls = 0;
  const game = enabledGame({
    writes,
    responseProvider: { async generateResponse() { legacyCalls += 1; throw new Error("legacy must not run"); } }
  });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Who do you suspect?" });
  await completePlayerThenNpc(game, action);
  const playerResult = action.result.conversationCommitResult;
  const replay = await game.npcStructuredProductionIntegration.executeNpcReaction({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    triggerRequestId: playerResult.requestId,
    originatingInputRecordId: playerResult.inputRecordId
  });
  assert.equal(replay.routeStatus, "replayed");
  assert.equal(replay.deliveryStatus, "skipped_not_eligible");
  assert.equal(writes.length, 1);
  assert.equal(legacyCalls, 0);
  assert.equal(game.state.stateVersion, 2);
});

test("candidate budget survives game reset while authoritative replay consumes no fetch", async () => {
  let fetchCalls = 0;
  const invokeProvider = createOpenAINpcReactionCandidateInvoker({
    apiKey: "unit-test-credential",
    maxRequestsPerMinute: 1,
    maxConcurrentRequests: 1,
    now: () => 0,
    fetch: async (_url, options) => {
      fetchCalls += 1;
      const body = JSON.parse(options.body);
      const request = JSON.parse(body.input[0].content[0].text);
      const targetId = request.knownInformation.constraints.allowedLivingTargetIds[0];
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async json() {
          return {
            status: "completed",
            output_text: JSON.stringify({
              schemaVersion: 1,
              proposals: [{ proposalType: "suspicion", targetId }]
            })
          };
        }
      };
    }
  });
  const firstGame = enabledGame({ invokeProvider });
  const action = await firstGame.dispatchPlayerAction({
    type: "ask_npc",
    targetId: "npc1",
    input: "Who do you suspect?"
  });
  assert.equal(action.result.structuredNpc.routeStatus, "committed");
  assert.equal(fetchCalls, 1);
  const playerResult = action.result.conversationCommitResult;
  const replay = await firstGame.npcStructuredProductionIntegration.executeNpcReaction({
    schemaVersion: 1,
    gameSessionId: firstGame.state.gameSessionId,
    triggerRequestId: playerResult.requestId,
    originatingInputRecordId: playerResult.inputRecordId
  });
  assert.equal(replay.routeStatus, "replayed");
  assert.equal(fetchCalls, 1);
  firstGame.destroy();

  const secondGame = enabledGame({ invokeProvider });
  const secondAction = await secondGame.dispatchPlayerAction({
    type: "ask_npc",
    targetId: "npc1",
    input: "Who do you suspect?"
  });
  assert.equal(secondAction.result.structuredNpc.legacySuppressed, true);
  assert.notEqual(secondAction.result.structuredNpc.routeStatus, "committed");
  assert.equal(fetchCalls, 1);
  secondGame.destroy();
});

test("candidate rejection and observer failure never enable legacy fallback", async () => {
  let legacyCalls = 0;
  const pseudo = createPseudoNpcReactionCandidateInvoker();
  const game = enabledGame({
    observer() { throw new Error("PRIVATE_OBSERVER_FAILURE"); },
    invokeProvider: async (request, options) => {
      const result = await pseudo(request, options);
      return { ...result, candidate: { schemaVersion: 1, proposals: [{ proposalType: "decline" }] } };
    },
    responseProvider: { async generateResponse() { legacyCalls += 1; return { text: "legacy" }; } }
  });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Who do you suspect?" });
  assert.equal(action.result.structuredNpc.routeStatus, "rejected");
  assert.equal(action.result.structuredNpc.deliveryStatus, "skipped_not_eligible");
  assert.equal(legacyCalls, 0);
  assert.equal(game.state.stateVersion, 2);
  assert.equal(game.state.phase, "day_discussion");
  assert.equal(JSON.stringify(action.result.structuredNpc).includes("PRIVATE_OBSERVER_FAILURE"), false);
});

test("malformed public actions and concurrent actions do not cross-deliver", async () => {
  let providerCalls = 0;
  let release;
  const pseudo = createPseudoNpcReactionCandidateInvoker();
  const game = enabledGame({
    invokeProvider: async (request, options) => {
      providerCalls += 1;
      await new Promise((resolve) => { release = resolve; });
      return pseudo(request, options);
    }
  });
  await assert.rejects(
    () => game.dispatchPlayerAction({ type: "ask_npc", targetId: "missing", input: "Question" }),
    /Unknown NPC/
  );
  assert.equal(providerCalls, 0);
  const first = game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "First" });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc2", input: "Second" }),
    /input_in_progress/
  );
  release();
  assert.equal((await first).result.structuredNpc.routeStatus, "committed");
  assert.equal(providerCalls, 1);
  assert.equal(game.state.conversation.reactionPlans.length, 1);
});

function enabledGame({ writes = [], sinkType = "cli", dom = null, responseProvider = undefined, invokeProvider = null, observer = () => {}, extraFactoryField = false } = {}) {
  if (extraFactoryField) return WerewolfGame.create({ npcStructuredReactionEnabled: true, playerConversationCommitEnabled: true, interpreterValidationEnabled: true });
  const candidateProvider = createNpcReactionCandidateProvider({ invokeProvider: invokeProvider ?? createPseudoNpcReactionCandidateInvoker() });
  let correlation = 0;
  const transport = createLocalNpcReactionCandidateTransport({ provider: candidateProvider, createServerCorrelationId: () => `server-test-${++correlation}` });
  return WerewolfGame.create({
    seed: 1, scenario: "sample", shuffleRoles: false, createId: ids("game"),
    interpreterValidationEnabled: true, playerConversationCommitEnabled: true,
    npcStructuredReactionEnabled: true, interpreterProvider: localInterpreter(), responseProvider,
    createNpcStructuredProductionIntegration: ({ gameSessionId, authorityPort, deliveryReadPort }) => {
      const sink = sinkType === "cli"
        ? createNpcCliPublicationSink({ write: async ({ text }) => { writes.push(text); }, failureGuarantee: "unknown_on_failure" })
        : createNpcBrowserPublicationSink({
            getConversationContainer: dom.getConversationContainer,
            createTextNode: dom.createTextNode,
            createMessageNode: dom.createMessageNode
          });
      return createProductionNpcStructuredDeliveryIntegration({
        gameSessionId, authorityPort, deliveryReadPort, candidateTransport: transport, sink,
        consumer: { consumerId: `${sinkType}-consumer`, sinkType }, createId: ids("runtime"),
        nowUtc: () => "2026-07-19T00:00:00.000Z", nowMonotonicMs: () => Math.floor(performance.now()),
        scheduleTimer: (callback, delay) => setTimeout(callback, delay), cancelTimer: (handle) => clearTimeout(handle),
        createAbortController: () => new AbortController(), observer
      });
    }
  });
}

function ids(prefix) { let order = 0; return () => `${prefix}-${++order}`; }
function localInterpreter() { let order = 0; return createLocalInterpreterHttpProvider(new PseudoInterpreterProvider(), { createServerCorrelationId: () => `server-interpreter-${++order}` }); }
async function completePlayerThenNpc(game, action) {
  await consumeLiveActionDisplay({
    game,
    action,
    consumerId: "test-player",
    sinkType: "cli",
    bookkeeping: new Map(),
    writeStructured: async () => {},
    writeLegacy: async () => {}
  });
  return game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId: action.result.conversationCommitResult.playerPublicationId
  });
}

function fakeDom() {
  const container = {
    children: [],
    appendChild(node) { this.children.push(node); node.parentNode = this; return node; },
    contains(node) { return this.children.includes(node); },
    removeChild(node) { this.children = this.children.filter((value) => value !== node); node.parentNode = null; }
  };
  return {
    container,
    getConversationContainer: () => container,
    createTextNode: (text) => ({ nodeType: 3, textContent: text, parentNode: null }),
    createMessageNode: ({ textNode }) => { const node = { nodeType: 1, childNodes: [textNode], firstChild: textNode, lastChild: textNode, parentNode: null, remove() { this.parentNode?.removeChild(this); } }; textNode.parentNode = node; return node; }
  };
}
