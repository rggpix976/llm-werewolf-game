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
  const counters = { candidate: 0, legacy: 0, ids: 0 };
  const { game } = createLifecycleGame({ counters });
  game.state.stateVersion = Number.MAX_SAFE_INTEGER - 1;
  const beforeConversation = conversationSnapshot(game.state);
  const beforePhase = game.state.phase;
  const beforeVersion = game.state.stateVersion;
  await assert.rejects(
    () => game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Capacity?" }),
    (error) => error.code === "state_version_exhausted"
  );
  assert.equal(game.state.phase, beforePhase);
  assert.equal(game.state.stateVersion, beforeVersion);
  assert.deepEqual(conversationSnapshot(game.state), beforeConversation);
  assert.equal(counters.candidate, 0);
  assert.equal(counters.legacy, 0);
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
