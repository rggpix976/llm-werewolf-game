import assert from "node:assert/strict";
import test from "node:test";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { parseConfig } from "../src/config.mjs";
import { resolvePlayerConversationCommitPolicy } from "../src/playerConversationCommit.mjs";

function ids() { let value = 0; return () => String(++value); }
function interpreterFor(acts) { return { async interpretPlayerInput(request) { return { schemaVersion: 1, requestId: request.requestId, correlationId: request.correlationId, serverCorrelationId: "server-1", result: { schemaVersion: 1, requestId: request.requestId, correlationId: request.correlationId, modelOutput: { schemaVersion: 1, alternatives: [{ alternativeId: "alternative-1", confidence: 1, speechActs: acts }] }, diagnostics: { providerName: "test", model: "test", attemptCount: 1, elapsedMs: 0 } } }; } }; }
function game(acts, options = {}) { return WerewolfGame.create({ seed: 1, scenario: "sample", shuffleRoles: false, createId: ids(), interpreterValidationEnabled: true, playerConversationCommitEnabled: true, interpreterProvider: interpreterFor(acts), responseProvider: { async generateResponse() { return { text: "response", providerName: "test", model: "test", usage: null, notes: [] }; } }, ...options }); }

test("Phase 4 policy is default-off and requires Phase 3", () => {
  assert.deepEqual(resolvePlayerConversationCommitPolicy({}), { enabled: false, interpreterValidationRequired: true });
  assert.throws(() => resolvePlayerConversationCommitPolicy({ playerConversationCommitMode: true }), (error) => error.code === "invalid_phase4_dependency");
  assert.throws(() => parseConfig({ PLAYER_CONVERSATION_COMMIT_MODE: "true" }), /requires/);
  assert.equal(parseConfig({ INTERPRETER_VALIDATION_MODE: "true", PLAYER_CONVERSATION_COMMIT_MODE: "true" }).playerConversationCommitMode, true);
});

test("atomic player commit stores strict artifacts at N+1 and NPC effects at N+2", async () => {
  const instance = game([{ type: "question", targetId: "npc1", topic: "opinion", sourceSpan: { start: 0, end: 5 } }]);
  const result = await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" });
  assert.equal(instance.state.stateVersion, 2); assert.equal(result.result.conversationCommitResult.preconditionStateVersion, 0); assert.equal(result.result.conversationCommitResult.resultingStateVersion, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(instance.state.conversation).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])), { inputRecords: 1, acceptedSpeechActs: 1, claims: 0, events: 1, displayPlans: 1, publications: 1, commitResults: 1, idempotencyRecords: 1 });
  assert.equal(instance.state.conversation.events[0].stateVersion, 1); assert.equal(instance.state.conversation.publications[0].gameStateVersion, 1);
  assert.equal(instance.state.playerLog.filter((entry) => entry.message.includes("hello")).length, 1);
});

test("result claims are assertions, relate deterministically, and do not inspect hidden truth", async () => {
  const instance = game([{ type: "result_claim", targetId: "npc1", result: "werewolf", sourceSpan: { start: 0, end: 5 } }]);
  await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" });
  const claim = instance.state.conversation.claims[0]; assert.equal(claim.type, "result_claim"); assert.equal(claim.result, "werewolf"); assert.equal("truth" in claim, false); assert.equal("evidence" in claim, false);
});

test("provider failure preserves committed player N+1 and publishes no NPC transaction", async () => {
  const instance = game([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }], { responseProvider: { async generateResponse() { throw new Error("provider failed"); } } });
  const result = await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" });
  assert.equal(result.result.reason, "response_provider_error"); assert.equal(instance.state.stateVersion, 1); assert.equal(instance.state.conversation.publications.length, 1);
});

test("exact replay returns stored result without providers, mutation, IDs, orders, or display", async () => {
  let interpreterCalls = 0, npcCalls = 0; const instance = game([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }], { interpreterProvider: { async interpretPlayerInput(request) { interpreterCalls += 1; return interpreterFor([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }]).interpretPlayerInput(request); } }, responseProvider: { async generateResponse() { npcCalls += 1; return { text: "response", providerName: "test", model: "test", usage: null, notes: [] }; } } });
  await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }); const record = instance.state.conversation.idempotencyRecords[0], before = structuredClone({ stateVersion: instance.state.stateVersion, turnOrder: instance.state.turnOrder, conversation: instance.state.conversation, playerLog: instance.state.playerLog });
  const replay = await instance.dispatchPlayerAction({ type: "ask_npc", replayRequestId: record.requestId, replayRequestFingerprint: record.requestFingerprint });
  assert.equal(replay.result.replayed, true); assert.deepEqual(replay.result.conversationCommitResult, record.result); assert.deepEqual({ stateVersion: instance.state.stateVersion, turnOrder: instance.state.turnOrder, conversation: instance.state.conversation, playerLog: instance.state.playerLog }, before); assert.deepEqual([interpreterCalls, npcCalls], [1, 1]);
  await assert.rejects(instance.dispatchPlayerAction({ type: "ask_npc", replayRequestId: record.requestId, replayRequestFingerprint: "0".repeat(64) }), (error) => error.code === "idempotency_conflict");
});

test("replay requires both exact identities and malformed attempts are side-effect free", async () => {
  let interpreterCalls = 0, npcCalls = 0; const instance = game([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }], { interpreterProvider: { async interpretPlayerInput(request) { interpreterCalls += 1; return interpreterFor([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }]).interpretPlayerInput(request); } }, responseProvider: { async generateResponse() { npcCalls += 1; return { text: "response", providerName: "test", model: "test", usage: null, notes: [] }; } } });
  await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }); const record = instance.state.conversation.idempotencyRecords[0], before = structuredClone({ version: instance.state.stateVersion, turn: instance.state.turnId, order: instance.state.turnOrder, conversation: instance.state.conversation, log: instance.state.playerLog });
  for (const action of [{ type: "ask_npc", replayRequestId: record.requestId }, { type: "ask_npc", replayRequestId: record.requestId, replayRequestFingerprint: "" }]) await assert.rejects(instance.dispatchPlayerAction(action), (error) => error.code === "invalid_replay_identity");
  await assert.rejects(instance.dispatchPlayerAction({ type: "ask_npc", replayRequestId: "unknown-request", replayRequestFingerprint: record.requestFingerprint }), (error) => error.code === "replay_not_found");
  assert.deepEqual({ version: instance.state.stateVersion, turn: instance.state.turnId, order: instance.state.turnOrder, conversation: instance.state.conversation, log: instance.state.playerLog }, before); assert.deepEqual([interpreterCalls, npcCalls], [1, 1]);
});

test("pre-publication fault injection leaves no structured or legacy partial write and no NPC call", async () => {
  let npcCalls = 0; const instance = game([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }], { phase4FaultInjector(stage) { if (stage === "publication") throw new Error("fault"); }, responseProvider: { async generateResponse() { npcCalls += 1; } } }); const before = structuredClone({ stateVersion: instance.state.stateVersion, conversation: instance.state.conversation, playerLog: instance.state.playerLog, publicInfo: instance.state.publicInfo });
  await assert.rejects(instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }), /fault/); assert.deepEqual({ stateVersion: instance.state.stateVersion, conversation: instance.state.conversation, playerLog: instance.state.playerLog, publicInfo: instance.state.publicInfo }, before); assert.equal(npcCalls, 0);
});

test("four-act conversion is one atomic increment with gap-free Unicode display coverage", async () => {
  const raw = "私は占い師。😀Aoi?";
  const acts = [
    { type: "role_claim", claimedRole: "seer", sourceSpan: { start: 0, end: 5 } },
    { type: "non_game_statement", sourceSpan: { start: 5, end: 7 } },
    { type: "suspicion", targetId: "npc2", sourceSpan: { start: 7, end: 8 } },
    { type: "question", targetId: "npc1", topic: "opinion", sourceSpan: { start: 8, end: 11 } }
  ];
  const instance = game(acts); await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: raw });
  assert.equal(instance.state.conversation.acceptedSpeechActs.length, 4); assert.equal(instance.state.conversation.claims.length, 1); assert.equal(instance.state.conversation.events.length, 4); assert.equal(instance.state.conversation.commitResults[0].resultingStateVersion, 1);
  assert.equal(instance.state.conversation.displayPlans[0].segments.length > 0, true);
});

test("claim repeat and contradiction use prior committed claims without dual-writing NPC claims", async () => {
  const first = [{ type: "result_claim", targetId: "npc1", result: "werewolf", sourceSpan: { start: 0, end: 5 } }], instance = game(first);
  await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }); const npcClaimCount = instance.state.players.reduce((sum, player) => sum + player.publicClaims.length, 0);
  instance.setPhase("day_discussion"); instance.interpreterProvider = interpreterFor(first); await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }); assert.equal(instance.state.conversation.claims.length, 2);
  instance.setPhase("day_discussion"); instance.interpreterProvider = interpreterFor([{ ...first[0], result: "not_werewolf" }]); await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }); assert.equal(instance.state.conversation.claims.length, 3);
  const [original, repeat, contradiction] = instance.state.conversation.claims; assert.equal(repeat.repeatsClaimId, original.claimId); assert.deepEqual(repeat.contradictsClaimIds, []); assert.equal(contradiction.repeatsClaimId, null); assert.deepEqual(contradiction.contradictsClaimIds, [original.claimId, repeat.claimId]); assert.equal(instance.state.players.reduce((sum, player) => sum + player.publicClaims.length, 0), npcClaimCount);
});

test("every preparation fault stage rolls back counters, registries, display, and provider call", async () => {
  for (const stage of ["input", "acts", "claims", "relations", "events", "display_plan", "publication", "commit_result", "idempotency", "final_state_replacement"]) {
    let npcCalls = 0; const instance = game([{ type: "role_claim", claimedRole: "seer", sourceSpan: { start: 0, end: 5 } }], { phase4FaultInjector(value) { if (value === stage) throw new Error(stage); }, responseProvider: { async generateResponse() { npcCalls += 1; } } });
    const before = structuredClone({ version: instance.state.stateVersion, conversation: instance.state.conversation, playerLog: instance.state.playerLog, publicInfo: instance.state.publicInfo }); await assert.rejects(instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }), new RegExp(stage));
    assert.deepEqual({ version: instance.state.stateVersion, conversation: instance.state.conversation, playerLog: instance.state.playerLog, publicInfo: instance.state.publicInfo }, before); assert.equal(npcCalls, 0);
  }
});

test("NPC publication failure rolls back only reaction and leaves player commit at N+1", async () => {
  const instance = game([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }], { phase4FaultInjector(stage) { if (stage === "npc_final_state_replacement") throw new Error("npc rollback"); } });
  await assert.rejects(instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }), /npc rollback/); assert.equal(instance.state.stateVersion, 1); assert.equal(instance.state.conversation.commitResults.length, 1); assert.equal(instance.state.playerLog.some((entry) => entry.message === "Aoi: response"), false);
});

test("destroy aborts pending NPC provider and discards a late successful response at N+1", async () => {
  let resolveProvider, enteredProvider, providerSignal; const entered = new Promise((resolve) => { enteredProvider = resolve; }), waiting = new Promise((resolve) => { resolveProvider = resolve; });
  const instance = game([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }], { responseProvider: { async generateResponse(_request, options) { providerSignal = options.signal; enteredProvider(); await waiting; return { text: "late response", providerName: "test", model: "test", usage: null, notes: [] }; } } });
  const pending = instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }); await entered; assert.equal(instance.state.stateVersion, 1); assert.equal(instance.state.phase, "player_question");
  instance.destroy(); assert.equal(providerSignal.aborted, true); resolveProvider(); await assert.rejects(pending, (error) => error.code === "stale_reaction");
  assert.equal(instance.state.stateVersion, 1); assert.equal(instance.state.conversation.commitResults.length, 1); assert.equal(instance.state.playerLog.some((entry) => entry.message === "Aoi: late response"), false); assert.equal(instance.activeNpcReaction, null);
});

test("late NPC reaction CAS rejects every live binding dimension without publishing effects", async () => {
  const mutations = [
    (instance) => { instance.state.gameSessionId = "game-replaced"; },
    (instance) => { instance.state.turnId = "turn-replaced"; },
    (instance) => { instance.state.turnOrder += 1; },
    (instance) => { instance.state.phase = "vote"; },
    (instance) => { instance.state.stateVersion += 1; },
    (instance) => { instance.state.players = instance.state.players.filter((player) => player.id !== "npc1"); }
  ];
  for (const mutate of mutations) {
    let resolveProvider, enteredProvider; const entered = new Promise((resolve) => { enteredProvider = resolve; }), waiting = new Promise((resolve) => { resolveProvider = resolve; });
    const instance = game([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }], { responseProvider: { async generateResponse() { enteredProvider(); await waiting; return { text: "late response", providerName: "test", model: "test", usage: null, notes: [] }; } } });
    const pending = instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }); await entered; mutate(instance); resolveProvider(); await assert.rejects(pending, (error) => error.code === "stale_reaction");
    assert.equal(instance.state.playerLog.some((entry) => entry.message === "Aoi: late response"), false);
  }
});

test("flag OFF retains the single legacy transaction and creates no structured artifacts", async () => {
  const instance = WerewolfGame.create({ seed: 1, scenario: "sample", shuffleRoles: false, createId: ids(), interpreterValidationEnabled: true, playerConversationCommitEnabled: false, interpreterProvider: interpreterFor([{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }]), responseProvider: { async generateResponse() { return { text: "response", providerName: "test", model: "test", usage: null, notes: [] }; } } });
  await instance.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" }); assert.equal(instance.state.stateVersion, 1); assert.equal(instance.state.conversation.inputRecords.length, 0); assert.equal(instance.state.conversation.publications.length, 0);
});
