import assert from "node:assert/strict";
import test from "node:test";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { createPhase3Binding, validatePhase3Response } from "../src/interpreterValidation.mjs";
import { PseudoInterpreterProvider } from "../src/interpreterTransport.mjs";
import { parseConfig, getRuntimeConfig } from "../src/config.mjs";

function ids() { let value = 0; return () => String(++value); }
function providerFor(output) { return { async interpretPlayerInput(request) { const result = output ? { schemaVersion: 1, requestId: request.requestId, correlationId: request.correlationId, modelOutput: output, diagnostics: { providerName: "test", model: "test", attemptCount: 1, elapsedMs: 0 } } : await new PseudoInterpreterProvider({ now: () => 0 }).interpretPlayerInput(request); return { schemaVersion: 1, requestId: request.requestId, correlationId: request.correlationId, serverCorrelationId: "server-1", result }; } }; }
function game(options = {}) { return WerewolfGame.create({ seed: 1, scenario: "sample", shuffleRoles: false, createId: ids(), responseProvider: { generateResponse: async () => ({ text: "same response", providerName: "test", model: "test", usage: null, notes: [] }) }, ...options }); }
function responseFor(binding, alternatives) { return { schemaVersion: 1, requestId: binding.requestId, correlationId: binding.correlationId, serverCorrelationId: "server-1", result: { schemaVersion: 1, requestId: binding.requestId, correlationId: binding.correlationId, modelOutput: { schemaVersion: 1, alternatives }, diagnostics: { providerName: "test", model: "test", attemptCount: 1, elapsedMs: 0 } } }; }

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
  assert.deepEqual(getRuntimeConfig(parseConfig({ INTERPRETER_SHADOW_MODE: "true", INTERPRETER_VALIDATION_MODE: "true" })), { provider: "pseudo", interpreterShadowMode: true, interpreterValidationMode: true, playerConversationCommitMode: false });
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
  const claimAccepted = validatePhase3Response(envelope([alternative("r", 1, [{ type: "result_claim", targetId: "npc1", result: "werewolf", sourceSpan: { start: 0, end: 5 } }])]), binding, instance.state); assert.equal(claimAccepted.reasonCode, "candidate_valid");
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

test("all invalid safe-integer states reject before turn allocation or mutation", async () => {
  for (const [field, values, code] of [["stateVersion", [-1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1], "state_version_exhausted"], ["turnOrder", [-1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1], "turn_order_exhausted"]]) {
    for (const value of values) { const instance = game(), before = { turnId: instance.state.turnId, stateVersion: instance.state.stateVersion, turnOrder: instance.state.turnOrder, phase: instance.state.phase }; instance.state[field] = value; before[field] = value; await assert.rejects(instance.dispatchPlayerAction({ type: "advance_vote" }), (error) => error.code === code); assert.deepEqual({ turnId: instance.state.turnId, stateVersion: instance.state.stateVersion, turnOrder: instance.state.turnOrder, phase: instance.state.phase }, before); }
  }
});

test("failed accepted commands retain exactly one allocated turn and roll back all authoritative state", async () => {
  const instance = game(), setupTurn = instance.state.turnId, playerRefs = [...instance.state.players], rngState = instance.state.rng.state, before = structuredClone({ ...instance.state, rng: undefined });
  instance.handlePlayerQuestion = async function () { this.state.phase = "vote"; this.state.players[0].alive = false; this.state.publicInfo.push({ type: "partial" }); this.state.rng.next(); throw new Error("compatibility failure"); };
  await assert.rejects(instance.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "hello" }), /compatibility failure/);
  assert.notEqual(instance.state.turnId, setupTurn); assert.equal(instance.state.turnOrder, 1); assert.equal(instance.state.stateVersion, 0); assert.equal(instance.state.phase, before.phase); assert.equal(instance.state.players[0].alive, before.players[0].alive); assert.equal(instance.state.publicInfo.some((entry) => entry.type === "partial"), false); assert.deepEqual(instance.state.players, before.players); assert.equal(instance.state.players.every((player, index) => player === playerRefs[index]), true); assert.equal(instance.state.rng.state, rngState);
});

test("publication preparation failure cannot expose partial player or top-level mutation", async () => {
  const instance = game(), originalPlayer = instance.state.players[0], originalName = originalPlayer.name, originalPhase = instance.state.phase;
  instance.handlePlayerQuestion = async function () { this.state.players[0].name = "PARTIAL"; this.state.phase = "vote"; this.state.nonCloneable = () => {}; return { responded: true, text: "unused" }; };
  await assert.rejects(instance.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "hello" }));
  assert.equal(instance.state.players[0], originalPlayer); assert.equal(originalPlayer.name, originalName); assert.equal(instance.state.phase, originalPhase); assert.equal("nonCloneable" in instance.state, false); assert.equal(instance.state.stateVersion, 0); assert.equal(instance.state.turnOrder, 1);
});

test("successful multi-write commands publish one and only one state-version increment", async () => {
  const instance = game();
  for (const action of [{ type: "ask_npc", target: "npc1", input: "Daichi?" }, { type: "advance_vote" }, { type: "run_night" }]) { const before = instance.state.stateVersion; await instance.dispatchPlayerAction(action); assert.equal(instance.state.stateVersion, before + 1); }
  assert.deepEqual([instance.state.turnOrder, instance.state.stateVersion], [3, 3]);
});

test("every stale identity dimension and fingerprint conflict is independently classified", async () => {
  const instance = game(), binding = createPhase3Binding({ state: instance.state, rawText: "hello", targetNpcId: "npc1", createId: ids() }), response = await providerFor().interpretPlayerInput(binding.request);
  const cases = [["stale_session", (copy) => copy.gameSessionId = "other"], ["stale_turn", (copy) => copy.turnId = "other"], ["stale_state_version", (copy) => copy.preconditionStateVersion += 1], ["stale_phase", (copy) => copy.preconditionPhase = "vote"], ["stale_actor", (copy) => copy.actorId = "npc1"], ["stale_input", (copy) => copy.inputRecordId = "other"]];
  for (const [reason, mutate] of cases) { const copy = structuredClone(binding); mutate(copy); assert.equal(validatePhase3Response(response, copy, instance.state).reasonCode, reason); }
  const changedRequest = structuredClone(binding); changedRequest.request.rawText = "changed"; assert.equal(validatePhase3Response(response, changedRequest, instance.state).reasonCode, "idempotency_conflict");
  assert.throws(() => validatePhase3Response({ ...response, requestId: "other" }, binding, instance.state)); assert.throws(() => validatePhase3Response({ ...response, correlationId: "other" }, binding, instance.state));
});

test("retry, duplicate, abort, reset, late response, observer failure, and cleanup preserve identity", async () => {
  const attempts = []; let release; const waiting = new Promise((resolve) => { release = resolve; });
  const instance = game({ interpreterValidationEnabled: true, interpreterProvider: { async interpretPlayerInput(request, { signal }) { attempts.push(request); await waiting; if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" }); attempts.push(request); return providerFor().interpretPlayerInput(request); } }, interpreterObserver: () => { throw new Error("observer"); } });
  const active = instance.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "hello" }); await Promise.resolve(); const pending = [...instance.pendingInterpreterRequests.values()][0], requestId = pending.binding.requestId; assert.equal(Object.isFrozen(attempts[0]), true); instance.destroy(); release(); await assert.rejects(active, (error) => error.name === "AbortError"); assert.equal(instance.pendingInterpreterRequests.size, 0); assert.equal(instance.state.stateVersion, 0); assert.equal(instance.acceptInterpreterResponse(requestId, {}).reasonCode, "stale_late_response");
  const duplicateGame = game({ interpreterValidationEnabled: true, interpreterProvider: { async interpretPlayerInput(request) { attempts.push(request); attempts.push(request); assert.equal(attempts.at(-1), attempts.at(-2)); return providerFor().interpretPlayerInput(request); } } }); await duplicateGame.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "hello" }); const [terminalId, terminal] = [...duplicateGame.interpreterTerminalAudit.entries()][0]; const same = await providerFor().interpretPlayerInput(attempts.at(-1)); assert.equal(duplicateGame.acceptInterpreterResponse(terminalId, same).reasonCode, "duplicate_response"); assert.equal(duplicateGame.acceptInterpreterResponse(terminalId, { ...same, serverCorrelationId: "changed" }).reasonCode, "duplicate_response_conflict"); assert.equal(terminal.status, "completed");
});

test("semantic authorization rejects disallowed phase, unknown/dead/player targets, and the whole set", () => {
  const question = (targetId, start = 0, end = 5) => ({ type: "question", targetId, topic: "opinion", sourceSpan: { start, end } });
  const day = game(), dayBinding = createPhase3Binding({ state: day.state, rawText: "helloworld", targetNpcId: "npc1", createId: ids() });
  for (const [targetId, reason] of [["missing", "invalid_reference"], ["player", "invalid_target_class"]]) { const result = validatePhase3Response(responseFor(dayBinding, [{ alternativeId: "a", confidence: 1, speechActs: [question(targetId)] }]), dayBinding, day.state); assert.equal(result.reasonCode, reason); assert.equal(result.category, "rejected"); }
  day.state.players[0].alive = false; const deadBinding = createPhase3Binding({ state: day.state, rawText: "hello", targetNpcId: "npc2", createId: ids() }); assert.equal(validatePhase3Response(responseFor(deadBinding, [{ alternativeId: "a", confidence: 1, speechActs: [question("npc1")] }]), deadBinding, day.state).reasonCode, "target_not_alive");
  const vote = game(); vote.state.phase = "vote"; const voteBinding = createPhase3Binding({ state: vote.state, rawText: "hello", targetNpcId: "npc1", createId: ids() }); assert.equal(validatePhase3Response(responseFor(voteBinding, [{ alternativeId: "a", confidence: 1, speechActs: [question("npc1")] }]), voteBinding, vote.state).reasonCode, "candidate_not_allowed");
  const whole = validatePhase3Response(responseFor(dayBinding, [{ alternativeId: "a", confidence: 1, speechActs: [question("npc1"), question("missing", 5, 10)] }]), dayBinding, day.state); assert.equal(whole.category, "rejected"); assert.equal(whole.candidateCount, 2);
});

test("alternative and privacy boundaries are transaction-sized and explicitly allowlisted", () => {
  const instance = game(), binding = createPhase3Binding({ state: instance.state, rawText: "PRIVATE RAW", targetNpcId: "npc1", createId: ids() }), act = { type: "non_game_statement", sourceSpan: { start: 0, end: 7 } }, alternative = (id, confidence) => ({ alternativeId: id, confidence, speechActs: [act] });
  for (const alternatives of [[alternative("a", 0.99), alternative("b", 0.01)], [alternative("a", 0.01), alternative("b", 0.5), alternative("c", 0.99)]]) { const result = validatePhase3Response(responseFor(binding, alternatives), binding, instance.state); assert.equal(result.category, "clarification"); assert.equal(result.candidateCount, alternatives.length); }
  const serialized = JSON.stringify(binding.request); for (const secret of ["hiddenInfo", "knownInfo", "privateMemory", "suspicionScores", "conversationPolicy", "role\"", "team\""]) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(Object.keys(binding.request), ["schemaVersion", "requestId", "correlationId", "inputRecordId", "turnId", "preconditionStateVersion", "preconditionPhase", "locale", "rawText", "playerContext", "publicRoster", "allowedCandidateTypes", "publicContext", "limits"]); assert.deepEqual(binding.request.publicContext, { publicEvents: [], publicClaims: [], publicVotes: [], executions: [], attackDeaths: [] }); assert.equal("state" in binding, false);
});

test("Phase 3 strict schema rejects every transport and model-output boundary", () => {
  const instance = game(), binding = createPhase3Binding({ state: instance.state, rawText: "hello", targetNpcId: "npc1", createId: ids() }), act = { type: "question", targetId: "npc1", topic: "opinion", sourceSpan: { start: 0, end: 5 } }, alternative = { alternativeId: "alt-1", confidence: 1, speechActs: [act] }, valid = responseFor(binding, [alternative]);
  assert.equal(validatePhase3Response(valid, binding, instance.state).category, "validated");
  const invalid = [];
  invalid.push({ ...valid, unknown: true });
  const missing = structuredClone(valid); delete missing.result.modelOutput; invalid.push(missing);
  const discriminator = structuredClone(valid); discriminator.result.modelOutput.alternatives[0].speechActs[0].type = "unknown"; invalid.push(discriminator);
  const enumValue = structuredClone(valid); enumValue.result.modelOutput.alternatives[0].speechActs[0].topic = "secret"; invalid.push(enumValue);
  const invalidId = structuredClone(valid); invalidId.result.modelOutput.alternatives[0].alternativeId = "bad id"; invalid.push(invalidId);
  invalid.push(responseFor(binding, [])); invalid.push(responseFor(binding, [alternative, { ...alternative, alternativeId: "alt-2" }, { ...alternative, alternativeId: "alt-3" }, { ...alternative, alternativeId: "alt-4" }]));
  invalid.push(responseFor(binding, [{ ...alternative, speechActs: [] }])); invalid.push(responseFor(binding, [{ ...alternative, speechActs: [act, { ...act, sourceSpan: { start: 0, end: 1 } }, { ...act, sourceSpan: { start: 1, end: 2 } }, { ...act, sourceSpan: { start: 2, end: 3 } }, { ...act, sourceSpan: { start: 3, end: 4 } }] }]));
  for (const confidence of [-0.1, 1.1, NaN, Infinity]) invalid.push(responseFor(binding, [{ ...alternative, confidence }]));
  const actorInjection = structuredClone(valid); actorInjection.result.modelOutput.alternatives[0].speechActs[0].actorId = "npc1"; invalid.push(actorInjection);
  const authorityInjection = structuredClone(valid); authorityInjection.result.modelOutput.alternatives[0].speechActs[0].stateVersion = 99; invalid.push(authorityInjection);
  for (const value of invalid) assert.throws(() => validatePhase3Response(value, binding, instance.state));
});

test("SourceSpan validates all Unicode code-point boundaries and pairwise relations", () => {
  const instance = game(), rawText = "😀あいう", binding = createPhase3Binding({ state: instance.state, rawText, targetNpcId: "npc1", createId: ids() }), act = (start, end) => ({ type: "non_game_statement", sourceSpan: { start, end } }), validate = (acts) => validatePhase3Response(responseFor(binding, [{ alternativeId: "alt-1", confidence: 1, speechActs: acts }]), binding, instance.state);
  assert.equal(validate([act(0, 1), act(1, 4)]).category, "validated");
  for (const acts of [[act(-1, 1)], [act(0, 0)], [act(2, 1)], [act(0, 5)], [act(2, 4), act(0, 1)], [act(0, 3), act(1, 2)], [act(0, 2), act(1, 3)], [act(0, 1), act(0, 1)]]) assert.throws(() => validate(acts));
  const japanese = createPhase3Binding({ state: instance.state, rawText: "あいう", targetNpcId: "npc1", createId: ids() }); assert.equal(validatePhase3Response(responseFor(japanese, [{ alternativeId: "jp", confidence: 1, speechActs: [{ type: "non_game_statement", sourceSpan: { start: 0, end: 3 } }] }]), japanese, instance.state).category, "validated");
});

test("feature flag OFF creates no Phase 3 request while ON creates exactly one", async () => {
  for (const enabled of [false, true]) { let calls = 0; const instance = game({ interpreterValidationEnabled: enabled, interpreterProvider: { async interpretPlayerInput(request) { calls += 1; return providerFor().interpretPlayerInput(request); } } }); await instance.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "hello" }); assert.equal(calls, enabled ? 1 : 0); assert.equal(instance.state.stateVersion, 1); assert.equal(instance.pendingInterpreterRequests.size, 0); }
});
