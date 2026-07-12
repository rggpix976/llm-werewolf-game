import assert from "node:assert/strict";
import test from "node:test";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { canonicalJson, sha256CanonicalJson } from "../src/conversation/ids.mjs";
import { validatePlayerLegacyDisplayCompatibilityReferences } from "../src/conversation/references.mjs";
import { validateDisplayPublicationRecord, validatePlayerLegacyDisplayCompatibilityRecord } from "../src/conversation/validators.mjs";

function ids() { let value = 0; return () => String(++value); }
function interpreterFor(acts) { return { async interpretPlayerInput(request) { return { schemaVersion: 1, requestId: request.requestId, correlationId: request.correlationId, serverCorrelationId: "server-1", result: { schemaVersion: 1, requestId: request.requestId, correlationId: request.correlationId, modelOutput: { schemaVersion: 1, alternatives: [{ alternativeId: "alternative-1", confidence: 1, speechActs: acts }] }, diagnostics: { providerName: "test", model: "test", attemptCount: 1, elapsedMs: 0 } } }; } }; }
function game(acts = [{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }], options = {}) { return WerewolfGame.create({ seed: 1, scenario: "sample", shuffleRoles: false, createId: ids(), interpreterValidationEnabled: true, playerConversationCommitEnabled: true, interpreterProvider: interpreterFor(acts), responseProvider: { async generateResponse() { return { text: "response", providerName: "test", model: "test", usage: null, notes: [] }; } }, ...options }); }
async function committed(acts, input = "hello", options = {}) { const instance = game(acts, options); await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input }); return instance; }
function graph(instance) { return { ...structuredClone(instance.state.conversation), gameSessionId: instance.state.gameSessionId, legacyPlayerLog: structuredClone(instance.state.playerLog) }; }
function validRecord() { return { schemaVersion: 1, recordType: "player_legacy_display_compatibility", compatibilityMappingId: "mapping-1", gameSessionId: "game-1", publicationId: "publication-1", displayPlanId: "display-1", inputRecordId: "input-1", requestId: "request-1", correlationId: "correlation-1", turnId: "turn-1", legacyEntryId: "legacy-1", legacyLogAppendOrder: 0, legacyEntryFingerprint: "a".repeat(64), playerCommitResultingStateVersion: 1, createdOrder: 0 }; }

test("mapping schema is strict, discriminated, safe-integer bounded, and not a publication union member", () => {
  const valid = validRecord(); assert.equal(validatePlayerLegacyDisplayCompatibilityRecord(valid), valid); assert.throws(() => validateDisplayPublicationRecord(valid), { name: "ConversationValidationError" });
  for (const key of Object.keys(valid)) { const candidate = { ...valid }; delete candidate[key]; assert.throws(() => validatePlayerLegacyDisplayCompatibilityRecord(candidate), { name: "ConversationValidationError" }); }
  for (const candidate of [{ ...valid, extra: true }, { ...valid, schemaVersion: 2 }, { ...valid, recordType: "player_utterance_published" }, { ...valid, compatibilityMappingId: "bad id" }, { ...valid, legacyEntryId: "bad id" }, { ...valid, legacyEntryFingerprint: "A".repeat(64) }, { ...valid, legacyLogAppendOrder: -1 }, { ...valid, createdOrder: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, playerCommitResultingStateVersion: 0 }]) assert.throws(() => validatePlayerLegacyDisplayCompatibilityRecord(candidate), (error) => error.code === "invalid_mapping_schema");
  const inherited = Object.assign(Object.create({ inherited: true }), valid); assert.throws(() => validatePlayerLegacyDisplayCompatibilityRecord(inherited), { name: "ConversationValidationError" });
});

test("legacy fingerprint hashes canonical JSON of the exact object without Unicode normalization", () => {
  const entry = { day: 1, phase: "player_question", message: "  日本語😀e\u0301\n" }, reordered = { message: entry.message, phase: entry.phase, day: entry.day };
  assert.equal(canonicalJson(entry), canonicalJson(reordered)); assert.equal(sha256CanonicalJson(entry), sha256CanonicalJson(reordered));
  for (const changed of [{ ...entry, day: 2 }, { ...entry, phase: "npc_response" }, { ...entry, message: entry.message + " " }, { ...entry, message: "  日本語😀é\n" }, { ...entry, message: entry.message.replace("\n", "\r\n") }]) assert.notEqual(sha256CanonicalJson(entry), sha256CanonicalJson(changed));
});

test("Phase 4 atomically writes one exact mapping and immutable read access resolves both identities", async () => {
  let providerCalls = 0; const instance = await committed(undefined, "  hello😀  ", { responseProvider: { async generateResponse() { providerCalls += 1; return { text: "response", providerName: "test", model: "test", usage: null, notes: [] }; } } });
  const { conversation } = instance.state, mapping = conversation.playerLegacyDisplayCompatibilityRecords[0], publication = conversation.publications[0], plan = conversation.displayPlans[0], input = conversation.inputRecords[0], result = conversation.commitResults[0], entry = instance.state.playerLog[mapping.legacyLogAppendOrder];
  assert.equal(conversation.playerLegacyDisplayCompatibilityRecords.length, 1); assert.equal(mapping.gameSessionId, instance.state.gameSessionId); assert.equal(mapping.publicationId, publication.publicationId); assert.equal(mapping.displayPlanId, plan.displayPlanId); assert.equal(mapping.inputRecordId, input.inputRecordId); assert.equal(mapping.requestId, input.requestId); assert.equal(mapping.correlationId, input.correlationId); assert.equal(mapping.turnId, input.turnId); assert.equal(mapping.playerCommitResultingStateVersion, 1); assert.equal(result.playerPublicationId, mapping.publicationId); assert.equal(mapping.legacyLogAppendOrder, 1); assert.equal(mapping.legacyEntryFingerprint, sha256CanonicalJson(entry)); assert.deepEqual(Object.keys(entry), ["day", "phase", "message"]); assert.equal(providerCalls, 1); assert.equal(instance.state.stateVersion, 2);
  const byPublication = instance.getPlayerLegacyDisplayCompatibilityRecord({ publicationId: mapping.publicationId }), byMapping = instance.getPlayerLegacyDisplayCompatibilityRecord({ compatibilityMappingId: mapping.compatibilityMappingId }); assert.deepEqual(byPublication, mapping); assert.deepEqual(byMapping, mapping); assert.equal(Object.isFrozen(byPublication), true); assert.throws(() => { byPublication.turnId = "changed"; }, TypeError); assert.equal(conversation.playerLegacyDisplayCompatibilityRecords[0].turnId, mapping.turnId);
  assert.throws(() => instance.getPlayerLegacyDisplayCompatibilityRecord({ publicationId: mapping.publicationId, gameSessionId: "old-session" }), (error) => error.code === "stale_session"); assert.throws(() => instance.getPlayerLegacyDisplayCompatibilityRecord({ publicationId: "missing" }), (error) => error.code === "mapping_not_found");
});

test("one mapping is written per publication across speech-act and claim cardinalities", async () => {
  const cases = [
    { acts: [{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }] },
    { acts: [{ type: "question", targetId: "npc1", topic: "opinion", sourceSpan: { start: 0, end: 5 } }] },
    { acts: [{ type: "role_claim", claimedRole: "seer", sourceSpan: { start: 0, end: 5 } }] },
    { acts: [{ type: "result_claim", targetId: "npc1", result: "werewolf", sourceSpan: { start: 0, end: 5 } }] },
    { phase: "vote", acts: [{ type: "vote_declaration", targetId: "npc1", sourceSpan: { start: 0, end: 5 } }] },
    { acts: [{ type: "suspicion", targetId: "npc1", sourceSpan: { start: 0, end: 5 } }] },
    { acts: [{ type: "role_claim", claimedRole: "seer", sourceSpan: { start: 0, end: 2 } }, { type: "result_claim", targetId: "npc1", result: "werewolf", sourceSpan: { start: 2, end: 5 } }] }
  ];
  for (const { acts, phase } of cases) { const instance = game(acts); if (phase) instance.setPhase(phase); await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }); assert.equal(instance.state.conversation.publications.length, 1, acts[0].type); assert.equal(instance.state.conversation.playerLegacyDisplayCompatibilityRecords.length, 1, acts[0].type); }
});

test("mapping and legacy staging failures roll back every protected field before provider invocation", async () => {
  for (const stage of ["legacy_entry", "compatibility_mapping", "committed_graph", "mapping_registry_staged", "commit_result_insertion", "legacy_log_staged", "mapping_graph_validation", "final_state_replacement"]) {
    let providerCalls = 0; const instance = game(undefined, { phase4FaultInjector(value) { if (value === stage) throw new Error(stage); }, responseProvider: { async generateResponse() { providerCalls += 1; } } });
    const before = structuredClone({ version: instance.state.stateVersion, phase: instance.state.phase, conversation: instance.state.conversation, log: instance.state.playerLog, publicInfo: instance.state.publicInfo });
    await assert.rejects(instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }), new RegExp(stage));
    assert.deepEqual(structuredClone({ version: instance.state.stateVersion, phase: instance.state.phase, conversation: instance.state.conversation, log: instance.state.playerLog, publicInfo: instance.state.publicInfo }), before); assert.equal(providerCalls, 0);
  }
});

test("invalid and conflicting prepared mappings fail the real player transaction without partial publication", async () => {
  const mutations = [
    (mapping) => { delete mapping.recordType; },
    (mapping, prior) => { mapping.compatibilityMappingId = prior.compatibilityMappingId; },
    (mapping, prior) => { mapping.legacyEntryId = prior.legacyEntryId; },
    (mapping, prior) => { mapping.publicationId = prior.publicationId; },
    (mapping, prior) => { mapping.legacyLogAppendOrder = prior.legacyLogAppendOrder; },
    (mapping) => { mapping.legacyEntryFingerprint = "0".repeat(64); },
    (mapping) => { mapping.displayPlanId = "display-missing"; },
    (mapping) => { mapping.inputRecordId = "input-missing"; },
    (mapping) => { mapping.publicationId = "publication-missing"; },
    (mapping, prior) => { mapping.createdOrder = prior.createdOrder; }
  ];
  for (const mutate of mutations) {
    let providerCalls = 0; const instance = await committed(undefined, "hello", { responseProvider: { async generateResponse() { providerCalls += 1; return { text: "response", providerName: "test", model: "test", usage: null, notes: [] }; } } }), prior = instance.state.conversation.playerLegacyDisplayCompatibilityRecords[0]; instance.setPhase("day_discussion"); instance.interpreterProvider = interpreterFor([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }]); instance.phase4FaultInjector = (stage, mapping) => { if (stage === "compatibility_mapping") mutate(mapping, prior); };
    const snapshot = () => structuredClone({ version: instance.state.stateVersion, phase: instance.state.phase, conversation: instance.state.conversation, log: instance.state.playerLog, publicInfo: instance.state.publicInfo }), before = snapshot();
    await assert.rejects(instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" })); assert.deepEqual(snapshot(), before); assert.equal(providerCalls, 1);
  }
});

test("final CAS rejects a changed legacy append location without publishing N+1", async () => {
  let instance, providerCalls = 0, injected = false; instance = game(undefined, { phase4FaultInjector(stage) { if (stage === "committed_graph" && !injected) { injected = true; instance.state.playerLog.push({ day: 1, phase: "external", message: "concurrent" }); } }, responseProvider: { async generateResponse() { providerCalls += 1; } } });
  await assert.rejects(instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }), (error) => error.code === "stale_commit_precondition"); assert.equal(instance.state.stateVersion, 0); assert.equal(instance.state.conversation.playerLegacyDisplayCompatibilityRecords.length, 0); assert.equal(providerCalls, 0);
});

test("referential validator fails closed for every mapping identity dimension and location proof", async () => {
  const instance = await committed(), baseline = graph(instance), mutations = [
    ["mapping_session_mismatch", (g) => g.playerLegacyDisplayCompatibilityRecords[0].gameSessionId = "game-other"],
    ["mapping_request_mismatch", (g) => g.playerLegacyDisplayCompatibilityRecords[0].requestId = "request-other"],
    ["mapping_correlation_mismatch", (g) => g.playerLegacyDisplayCompatibilityRecords[0].correlationId = "correlation-other"],
    ["mapping_turn_mismatch", (g) => g.playerLegacyDisplayCompatibilityRecords[0].turnId = "turn-other"],
    ["dangling_input", (g) => g.playerLegacyDisplayCompatibilityRecords[0].inputRecordId = "input-other"],
    ["dangling_display_plan", (g) => g.playerLegacyDisplayCompatibilityRecords[0].displayPlanId = "display-other"],
    ["dangling_publication", (g) => g.playerLegacyDisplayCompatibilityRecords[0].publicationId = "publication-other"],
    ["mapping_version_mismatch", (g) => g.playerLegacyDisplayCompatibilityRecords[0].playerCommitResultingStateVersion = 2],
    ["dangling_legacy_entry", (g) => g.playerLegacyDisplayCompatibilityRecords[0].legacyLogAppendOrder = 99],
    ["legacy_fingerprint_mismatch", (g) => g.playerLegacyDisplayCompatibilityRecords[0].legacyEntryFingerprint = "0".repeat(64)]
  ];
  for (const [code, mutate] of mutations) { const candidate = structuredClone(baseline); mutate(candidate); assert.throws(() => validatePlayerLegacyDisplayCompatibilityReferences(candidate.playerLegacyDisplayCompatibilityRecords, candidate), (error) => error.code === code); }
});

test("duplicate mapping identities, publication ownership, append location, and created order are rejected", async () => {
  const instance = await committed(), baseline = graph(instance), mapping = baseline.playerLegacyDisplayCompatibilityRecords[0];
  for (const [code, mutate] of [["duplicate_mapping_id", (x) => x.compatibilityMappingId = mapping.compatibilityMappingId], ["duplicate_legacy_entry_id", (x) => x.legacyEntryId = mapping.legacyEntryId], ["duplicate_publication_mapping", (x) => x.publicationId = mapping.publicationId], ["duplicate_legacy_append_location", (x) => x.legacyLogAppendOrder = mapping.legacyLogAppendOrder], ["mapping_created_order_conflict", (x) => x.createdOrder = mapping.createdOrder]]) {
    const candidate = structuredClone(baseline), duplicate = { ...mapping, compatibilityMappingId: "mapping-new", legacyEntryId: "legacy-new", publicationId: "publication-new", inputRecordId: "input-new", legacyLogAppendOrder: mapping.legacyLogAppendOrder + 1, createdOrder: mapping.createdOrder + 10 }; mutate(duplicate); candidate.playerLegacyDisplayCompatibilityRecords.push(duplicate); assert.throws(() => validatePlayerLegacyDisplayCompatibilityReferences(candidate.playerLegacyDisplayCompatibilityRecords, candidate), (error) => error.code === code);
  }
});

test("exact replay reuses mapping and corruption fails closed without backfill or provider call", async () => {
  let providerCalls = 0; const instance = await committed(undefined, "hello", { responseProvider: { async generateResponse() { providerCalls += 1; return { text: "response", providerName: "test", model: "test", usage: null, notes: [] }; } } }), record = instance.state.conversation.idempotencyRecords[0], snapshot = () => structuredClone({ version: instance.state.stateVersion, turn: instance.state.turnId, order: instance.state.turnOrder, conversation: instance.state.conversation, log: instance.state.playerLog }), before = snapshot();
  const replay = await instance.dispatchPlayerAction({ type: "ask_npc", replayRequestId: record.requestId, replayRequestFingerprint: record.requestFingerprint }); assert.equal(replay.result.replayed, true); assert.deepEqual(snapshot(), before); assert.equal(providerCalls, 1);
  instance.state.conversation.playerLegacyDisplayCompatibilityRecords.length = 0; const corrupt = snapshot(); await assert.rejects(instance.dispatchPlayerAction({ type: "ask_npc", replayRequestId: record.requestId, replayRequestFingerprint: record.requestFingerprint }), (error) => error.code === "replay_mapping_missing"); assert.deepEqual(snapshot(), corrupt); assert.equal(providerCalls, 1);
});

test("mapping stays out of public/provider projections and preserves legacy visible shape and ordering", async () => {
  let request; const instance = await committed(undefined, "hello", { responseProvider: { async generateResponse(value) { request = value; return { text: "response", providerName: "test", model: "test", usage: null, notes: [] }; } } }), serializedPublic = JSON.stringify(instance.getPublicSnapshot()), serializedRequest = JSON.stringify(request), mapping = instance.state.conversation.playerLegacyDisplayCompatibilityRecords[0];
  assert.equal(serializedPublic.includes("player_legacy_display_compatibility"), false); assert.equal(serializedRequest.includes("player_legacy_display_compatibility"), false); assert.equal(serializedRequest.includes(mapping.legacyEntryFingerprint), false); assert.equal(instance.state.playerLog[mapping.legacyLogAppendOrder].message, "あなた -> Aoi: hello"); assert.equal(instance.state.playerLog[mapping.legacyLogAppendOrder + 1].message, "Aoi: response");
  for (const forbidden of ["role", "team", "result", "truth", "suspicion", "memory", "prompt", "output", "rawText", "text"]) assert.equal(Object.hasOwn(mapping, forbidden), false);
});
