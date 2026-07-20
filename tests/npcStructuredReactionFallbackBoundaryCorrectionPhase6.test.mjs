import assert from "node:assert/strict";
import test from "node:test";

import { createLifecycleGame } from "./helpers/npcStructuredReactionLifecycleCorrectionHarness.mjs";

const CLOSED_CASES = [
  ["clarification", "multiple_alternatives"],
  ["clarification", "uninterpretable"],
  ["rejected", "candidate_not_allowed"],
  ["failure", "provider_timeout"],
  ["failure", "invalid_provider_response"],
  ["stale", "stale_state_version"],
  ["conflict", "idempotency_conflict"],
  [null, null],
  ["unknown_private_category", "PRIVATE_RAW_MARKER"]
];

test("RC-006/007 every nonvalidated Interpreter outcome stays in the closed structured path", async () => {
  for (const [category, reasonCode] of CLOSED_CASES) {
    const counters = { candidate: 0, legacy: 0 };
    const { game } = createLifecycleGame({ counters });
    game._observeInterpreter = async () => category === null
      ? null
      : { binding: null, outcome: { category, reasonCode }, responseFingerprint: null };
    const before = conversationSnapshot(game.state);
    const version = game.state.stateVersion;
    const phase = game.state.phase;
    const result = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "PRIVATE RAW" });
    assert.equal(result.result.responded, false);
    assert.equal(result.result.structuredNpc.resultType, "npc_structured_interpreter_outcome");
    assert.equal(result.result.structuredNpc.legacyUsed, false);
    assert.equal(result.result.structuredNpc.legacySuppressed, true);
    assert.equal(counters.candidate, 0);
    assert.equal(counters.legacy, 0);
    assert.equal(game.state.stateVersion, version);
    assert.equal(game.state.phase, phase);
    assert.deepEqual(conversationSnapshot(game.state), before);
    assert.equal(JSON.stringify(result.result).includes("PRIVATE_RAW_MARKER"), false);
    assert.equal(JSON.stringify(result.result).includes("PRIVATE RAW"), false);
  }
});

test("RC-006 genuine candidate_not_allowed is closed before Player or NPC commit", async () => {
  const counters = { candidate: 0, legacy: 0 };
  const interpreterProvider = {
    async interpretPlayerInput(request) {
      return responseFor(request, [{
        alternativeId: "alternative-1",
        confidence: 1,
        speechActs: [{
          type: "vote_declaration",
          targetId: "npc1",
          sourceSpan: { start: 0, end: [...request.rawText].length }
        }]
      }]);
    }
  };
  const { game } = createLifecycleGame({ counters, interpreterProvider });
  const before = conversationSnapshot(game.state);
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Vote now" });
  assert.equal(action.result.structuredNpc.outcomeCategory, "rejected");
  assert.equal(action.result.structuredNpc.reasonCode, "candidate_not_allowed");
  assert.equal(counters.legacy, 0);
  assert.equal(counters.candidate, 0);
  assert.equal(game.state.stateVersion, 0);
  assert.equal(game.state.phase, "day_discussion");
  assert.deepEqual(conversationSnapshot(game.state), before);
});

test("RC-008 flag off preserves compatibility fallback for rejected and failed observations", async () => {
  for (const outcome of [
    { category: "rejected", reasonCode: "candidate_not_allowed" },
    { category: "failure", reasonCode: "provider_failure" }
  ]) {
    const counters = { candidate: 0, legacy: 0 };
    const { game } = createLifecycleGame({ counters, npcStructuredReactionEnabled: false });
    game._observeInterpreter = async () => ({ binding: null, outcome, responseFingerprint: null });
    const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Legacy?" });
    assert.equal(action.result.text, "legacy");
    assert.equal(counters.legacy, 1);
    assert.equal(counters.candidate, 0);
  }
});

test("RC-018 two-version capacity fails before Player conversation publication", async () => {
  const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0 };
  let interpreterCalls = 0;
  const { game } = createLifecycleGame({
    counters,
    interpreterProvider: {
      async interpretPlayerInput() {
        interpreterCalls += 1;
        throw new Error("Interpreter must not run after capacity denial");
      }
    }
  });
  game.state.stateVersion = Number.MAX_SAFE_INTEGER - 1;
  const beforeTurnOrder = game.state.turnOrder;
  const beforeTurnId = game.state.turnId;
  const beforeIds = counters.ids;
  const beforeState = authoritativeComparable(game.state);
  const beforeConversation = conversationSnapshot(game.state);
  const beforePhase = game.state.phase;
  const beforeVersion = game.state.stateVersion;
  await assert.rejects(
    () => game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Capacity?" }),
    (error) => error.code === "state_version_exhausted"
  );
  assert.equal(game.state.phase, beforePhase);
  assert.equal(game.state.stateVersion, beforeVersion);
  assert.equal(game.state.turnOrder, beforeTurnOrder);
  assert.equal(game.state.turnId, beforeTurnId);
  assert.equal(counters.ids, beforeIds);
  assert.equal(interpreterCalls, 0);
  assert.deepEqual(conversationSnapshot(game.state), beforeConversation);
  assert.equal(counters.candidate, 0);
  assert.equal(counters.legacy, 0);
  assert.equal(counters.npcWrites, 0);
  assert.equal(game.state.conversation.reactionPlans.length, 0);
  assert.deepEqual(authoritativeComparable(game.state), beforeState);
});

test("RC-018 exact two-version capacity reaches MAX_SAFE_INTEGER without fallback", async () => {
  const counters = { candidate: 0, legacy: 0 };
  const { game } = createLifecycleGame({ counters });
  game.state.stateVersion = Number.MAX_SAFE_INTEGER - 2;
  const action = await game.dispatchPlayerAction({
    type: "ask_npc",
    targetId: "npc1",
    input: "Capacity boundary?"
  });
  const playerResult = action.result.conversationCommitResult;
  const npcResult = game.state.conversation.commitResults.find((entry) =>
    entry.commitType === "npc_reaction");
  assert.equal(playerResult.preconditionStateVersion, Number.MAX_SAFE_INTEGER - 2);
  assert.equal(playerResult.resultingStateVersion, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(npcResult.preconditionStateVersion, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(npcResult.resultingStateVersion, Number.MAX_SAFE_INTEGER);
  assert.equal(game.state.stateVersion, Number.MAX_SAFE_INTEGER);
  assert.equal(Number.isSafeInteger(game.state.stateVersion), true);
  assert.equal(game.state.phase, "day_discussion");
  assert.equal(counters.candidate, 1);
  assert.equal(counters.legacy, 0);
});

test("structured capacity preflight does not replace flag-off or non-ask behavior", async (t) => {
  await t.test("flag off reaches the existing Interpreter boundary", async () => {
    let interpreterCalls = 0;
    const { game } = createLifecycleGame({
      npcStructuredReactionEnabled: false,
      interpreterProvider: {
        async interpretPlayerInput() {
          interpreterCalls += 1;
          throw new Error("flag-off interpreter marker");
        }
      }
    });
    game.state.stateVersion = Number.MAX_SAFE_INTEGER - 1;
    const result = await game.dispatchPlayerAction({
      type: "ask_npc",
      targetId: "npc1",
      input: "Legacy boundary?"
    });
    assert.equal(result.result.text, "legacy");
    assert.equal(interpreterCalls, 1);
    assert.equal(game.state.stateVersion, Number.MAX_SAFE_INTEGER);
  });

  await t.test("non-ask command retains its one-version behavior", async () => {
    const { game } = createLifecycleGame();
    game.state.stateVersion = Number.MAX_SAFE_INTEGER - 1;
    const result = await game.dispatchPlayerAction({ type: "advance_vote" });
    assert.equal(result.actionType, "advance_vote");
    assert.equal(game.state.stateVersion, Number.MAX_SAFE_INTEGER);
    assert.equal(Number.isSafeInteger(game.state.stateVersion), true);
  });
});

test("unexpected Interpreter exception is redacted and cannot reopen legacy fallback", async () => {
  const counters = { candidate: 0, legacy: 0 };
  const { game } = createLifecycleGame({ counters });
  game._observeInterpreter = async () => { throw new Error("PRIVATE_INTERPRETER_STACK"); };
  const result = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Question?" });
  assert.equal(result.result.structuredNpc.outcomeCategory, "failure");
  assert.equal(result.result.structuredNpc.reasonCode, "interpreter_failure");
  assert.equal(JSON.stringify(result).includes("PRIVATE_INTERPRETER_STACK"), false);
  assert.equal(counters.legacy, 0);
  assert.equal(counters.candidate, 0);
});

function responseFor(request, alternatives) {
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    correlationId: request.correlationId,
    serverCorrelationId: "server-closed-outcome",
    result: {
      schemaVersion: 1,
      requestId: request.requestId,
      correlationId: request.correlationId,
      modelOutput: { schemaVersion: 1, alternatives },
      diagnostics: { providerName: "test", model: "test", attemptCount: 1, elapsedMs: 0 }
    }
  };
}

function conversationSnapshot(state) {
  return structuredClone(state.conversation);
}

function authoritativeComparable(state) {
  const { rng, ...plain } = state;
  return structuredClone({ ...plain, rngState: rng.state });
}
