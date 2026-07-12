import assert from "node:assert/strict";
import test from "node:test";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { createPhase3Binding, validatePhase3Response } from "../src/interpreterValidation.mjs";
import { PseudoInterpreterProvider } from "../src/interpreterTransport.mjs";
import { parseConfig, getRuntimeConfig } from "../src/config.mjs";

function ids() { let value = 0; return () => String(++value); }
function providerFor(output) { return { async interpretPlayerInput(request) { const result = output ? { schemaVersion: 1, requestId: request.requestId, correlationId: request.correlationId, modelOutput: output, diagnostics: { providerName: "test", model: "test", attemptCount: 1, elapsedMs: 0 } } : await new PseudoInterpreterProvider({ now: () => 0 }).interpretPlayerInput(request); return { schemaVersion: 1, requestId: request.requestId, correlationId: request.correlationId, serverCorrelationId: "server-1", result }; } }; }
function game(options = {}) { return WerewolfGame.create({ seed: 1, scenario: "sample", shuffleRoles: false, createId: ids(), responseProvider: { generateResponse: async () => ({ text: "same response", providerName: "test", model: "test", usage: null, notes: [] }) }, ...options }); }

test("authoritative lifecycle allocates opaque turns and one version per compatibility transaction", async () => {
  const first = game(), second = game({ createId: (() => { let value = 100; return () => String(++value); })() }); assert.equal(first.state.turnOrder, 0); assert.equal(first.state.stateVersion, 0); assert.match(first.state.gameSessionId, /^game-/); assert.match(first.state.turnId, /^turn-/); assert.notEqual(first.state.gameSessionId, second.state.gameSessionId);
  const setupTurn = first.state.turnId; await first.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "hello" }); assert.equal(first.state.turnOrder, 1); assert.notEqual(first.state.turnId, setupTurn); assert.equal(first.state.stateVersion, 1);
  const turn = first.state.turnId, order = first.state.turnOrder, version = first.state.stateVersion; await assert.rejects(first.dispatchPlayerAction({ type: "ask_npc", target: "missing", input: "x" })); assert.deepEqual([first.state.turnId, first.state.turnOrder, first.state.stateVersion], [turn, order, version]);
  await first.dispatchPlayerAction({ type: "get_state" }); assert.equal(first.state.stateVersion, version);
  first.state.stateVersion = Number.MAX_SAFE_INTEGER; await assert.rejects(first.dispatchPlayerAction({ type: "advance_vote" }), (error) => error.code === "state_version_exhausted"); assert.equal(first.state.turnOrder, order);
  first.state.stateVersion = version; first.state.turnOrder = Number.MAX_SAFE_INTEGER; await assert.rejects(first.dispatchPlayerAction({ type: "advance_vote" }), (error) => error.code === "turn_order_exhausted");
});

test("vote and night remain one transaction each and authoritative lifecycle is flag-independent", async () => {
  const instance = game(); await instance.dispatchPlayerAction({ type: "advance_vote" }); assert.deepEqual([instance.state.turnOrder, instance.state.stateVersion], [1, 1]); await instance.dispatchPlayerAction({ type: "run_night" }); assert.deepEqual([instance.state.turnOrder, instance.state.stateVersion], [2, 2]);
  assert.deepEqual(getRuntimeConfig(parseConfig({ INTERPRETER_SHADOW_MODE: "true", INTERPRETER_VALIDATION_MODE: "true" })), { provider: "pseudo", interpreterShadowMode: true, interpreterValidationMode: true });
});

test("clarification continuation reuses the logical turn without reusing request identity", async () => {
  const instance = game(), turn = instance.state.turnId; instance.state.turnOrder = 1; instance.state.stateVersion = 1; instance.interpreterTerminalAudit.set("clarify-1", { turnId: turn, outcome: { category: "clarification" } });
  await instance.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "clarified", clarificationRequestId: "clarify-1" }); assert.equal(instance.state.turnId, turn); assert.equal(instance.state.turnOrder, 1); assert.equal(instance.state.stateVersion, 2);
  await assert.rejects(instance.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "bad", clarificationRequestId: "missing" }), (error) => error.code === "invalid_clarification_continuation"); assert.equal(instance.state.turnOrder, 1);
});

test("compatibility transaction is isolated and rolls back every partial write", async () => {
  const instance = game(), before = structuredClone({ ...instance.state, rng: undefined }); instance.handlePlayerQuestion = async function () { this.state.phase = "vote"; this.state.publicInfo.push({ secret: "partial" }); throw new Error("boom"); };
  await assert.rejects(instance.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "hello" }), /boom/);
  assert.equal(instance.state.stateVersion, 0); assert.equal(instance.state.phase, before.phase); assert.equal(instance.state.publicInfo.some((entry) => entry.secret), false); assert.equal(instance.state.turnOrder, 1);
});

test("Phase 3 captures immutable engine binding before compatibility mutation and stays diagnostic-only", async () => {
  let captured, observed, returned; const instance = game({ interpreterValidationEnabled: true, interpreterProvider: { async interpretPlayerInput(request) { captured = request; assert.equal(instance.state.phase, "day_discussion"); assert.equal(instance.state.stateVersion, 0); assert.equal(Object.isFrozen(request), true); returned = await providerFor().interpretPlayerInput(request); return returned; } }, interpreterObserver: (entry) => { observed = entry; }, now: () => 5 });
  const action = await instance.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "PRIVATE RAW" });
  assert.equal(action.result.text, "same response"); assert.equal(captured.turnId, instance.state.turnId); assert.equal(captured.preconditionStateVersion, 0); assert.equal(captured.inputRecordId.startsWith("input-"), true); assert.equal("shadowTurnId" in captured, false); assert.equal(instance.state.stateVersion, 1); assert.equal(instance.pendingInterpreterRequests.size, 0);
  const diagnostic = JSON.stringify(observed); assert.equal(diagnostic.includes("PRIVATE RAW"), false); assert.equal(diagnostic.includes("role"), false); assert.deepEqual(Object.keys(observed), ["correlationId", "inputRecordId", "turnId", "capturedStateVersion", "outcomeCategory", "candidateCount", "alternativeCount", "reasonCode", "stale", "latencyMs", "retryAttempt", "terminalStatus"]);
  const requestId = [...instance.interpreterTerminalAudit.keys()][0]; assert.equal(instance.acceptInterpreterResponse(requestId, returned).reasonCode, "duplicate_response"); assert.equal(instance.acceptInterpreterResponse(requestId, { ...returned, serverCorrelationId: "server-2" }).reasonCode, "duplicate_response_conflict");
});

test("alternative semantics never select by confidence and reject the whole candidate set", () => {
  const instance = game(), binding = createPhase3Binding({ state: instance.state, rawText: "Aoi?x", targetNpcId: "npc1", createId: ids() });
  const envelope = (alternatives) => ({ schemaVersion: 1, requestId: binding.requestId, correlationId: binding.correlationId, serverCorrelationId: "server-1", result: { schemaVersion: 1, requestId: binding.requestId, correlationId: binding.correlationId, modelOutput: { schemaVersion: 1, alternatives }, diagnostics: { providerName: "test", model: "test", attemptCount: 1, elapsedMs: 0 } } });
  const act = { type: "question", targetId: "npc1", topic: "opinion", sourceSpan: { start: 0, end: 4 } }, alternative = (id, confidence, speechActs = [act]) => ({ alternativeId: id, confidence, speechActs });
  assert.equal(validatePhase3Response(envelope([alternative("a", 0.1), alternative("b", 0.9)]), binding, instance.state).reasonCode, "multiple_alternatives");
  const rejected = validatePhase3Response(envelope([alternative("a", 1, [act, { type: "question", targetId: "missing", topic: "opinion", sourceSpan: { start: 4, end: 5 } }])]), binding, instance.state); assert.equal(rejected.category, "rejected"); assert.equal(rejected.candidateCount, 2);
  const claimRejected = validatePhase3Response(envelope([alternative("r", 1, [{ type: "result_claim", targetId: "npc1", result: "werewolf", sourceSpan: { start: 0, end: 5 } }])]), binding, instance.state); assert.equal(claimRejected.reasonCode, "unauthorized_known_information");
  const uninterpretable = { type: "uninterpretable", reason: "gibberish", sourceSpan: { start: 0, end: 5 } }; assert.equal(validatePhase3Response(envelope([alternative("u", 1, [uninterpretable])]), binding, instance.state).reasonCode, "uninterpretable");
});

test("strict source spans use Unicode code points and reject overlap, duplicates, and UTF-16 offsets", () => {
  const instance = game(), binding = createPhase3Binding({ state: instance.state, rawText: "😀あ", targetNpcId: "npc1", createId: ids() }), response = (acts) => ({ schemaVersion: 1, requestId: binding.requestId, correlationId: binding.correlationId, serverCorrelationId: "server-1", result: { schemaVersion: 1, requestId: binding.requestId, correlationId: binding.correlationId, modelOutput: { schemaVersion: 1, alternatives: [{ alternativeId: "a", confidence: 1, speechActs: acts }] }, diagnostics: { providerName: "test", model: "test", attemptCount: 1, elapsedMs: 0 } } });
  assert.equal(validatePhase3Response(response([{ type: "non_game_statement", sourceSpan: { start: 0, end: 2 } }]), binding, instance.state).category, "validated");
  for (const acts of [[{ type: "non_game_statement", sourceSpan: { start: 0, end: 3 } }], [{ type: "non_game_statement", sourceSpan: { start: 0, end: 2 } }, { type: "question", targetId: "npc1", topic: "opinion", sourceSpan: { start: 1, end: 2 } }]]) assert.throws(() => validatePhase3Response(response(acts), binding, instance.state));
});

test("stale dimensions, terminal duplicate, input-in-progress, observer failure, and reset are isolated", async () => {
  let resolve; const waiting = new Promise((done) => { resolve = done; }), instance = game({ interpreterValidationEnabled: true, interpreterProvider: { interpretPlayerInput: () => waiting }, interpreterObserver: () => { throw new Error("observer"); } });
  const active = instance.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "hello" }); await Promise.resolve(); const order = instance.state.turnOrder; await assert.rejects(instance.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "again" }), (error) => error.code === "input_in_progress"); assert.equal(instance.state.turnOrder, order);
  instance.destroy(); resolve(await providerFor().interpretPlayerInput([...instance.pendingInterpreterRequests.values()][0].binding.request)); await assert.rejects(active, (error) => error.name === "AbortError"); assert.equal(instance.state.stateVersion, 0); assert.equal(instance.pendingInterpreterRequests.size, 0);
  assert.equal(instance.interpreterTerminalAudit.size, 1); assert.equal(instance.acceptInterpreterResponse("missing", {}).reasonCode, "stale_no_pending");
});

test("each authoritative binding mismatch is classified before semantic validation", async () => {
  const instance = game(), binding = createPhase3Binding({ state: instance.state, rawText: "hello", targetNpcId: "npc1", createId: ids() }), response = await providerFor().interpretPlayerInput(binding.request);
  for (const [reason, mutate] of [["stale_session", (copy) => copy.gameSessionId = "other"], ["stale_turn", (copy) => copy.turnId = "other"], ["stale_state_version", (copy) => copy.preconditionStateVersion = 1], ["stale_phase", (copy) => copy.preconditionPhase = "vote"], ["stale_actor", (copy) => copy.actorId = "npc1"], ["stale_input", (copy) => copy.inputRecordId = "other"]]) { const copy = structuredClone(binding); mutate(copy); assert.equal(validatePhase3Response(response, copy, instance.state).reasonCode, reason); }
  const advanced = structuredClone(instance.state); advanced.stateVersion += 1; assert.equal(validatePhase3Response(response, binding, advanced).reasonCode, "stale_state_version");
});

test("provider and observer failures preserve compatibility behavior and cleanup", async () => {
  for (const failure of [Object.assign(new Error("timeout secret"), { code: "provider_timeout" }), Object.assign(new Error("provider secret"), { code: "provider_unavailable" })]) { const instance = game({ interpreterValidationEnabled: true, interpreterProvider: { interpretPlayerInput: async () => { throw failure; } }, interpreterObserver: () => { throw new Error("observer secret"); } }); const action = await instance.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "hello" }); assert.equal(action.result.text, "same response"); assert.equal(instance.state.stateVersion, 1); assert.equal(instance.pendingInterpreterRequests.size, 0); assert.equal(JSON.stringify([...instance.interpreterTerminalAudit.values()]).includes("secret"), false); }
});
