import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getRuntimeConfig, parseConfig } from "../src/config.mjs";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { buildNpcKnownInformationProjection, validateNpcKnownInformationProjection } from "../src/npcKnownInformationProjection.mjs";
import {
  LOGICAL_REACTION_STATUSES,
  REACTION_ATTEMPT_STATUSES,
  assertLogicalReactionStatus,
  assertReactionAttemptStatus,
  createLogicalReactionFoundation,
  createReactionAttemptFoundation,
  isLogicalReactionTerminal,
  isReactionAttemptTerminal,
  resolveNpcStructuredReactionPolicy,
  validateLogicalReactionFoundation,
  validateReactionAttemptFoundation
} from "../src/npcReactionFoundation.mjs";

test("Phase 6 flag defaults off, requires Phase 4, and is public but inert", async () => {
  const defaults = parseConfig({});
  assert.equal(defaults.npcStructuredReactionMode, false);
  assert.equal(getRuntimeConfig(defaults).npcStructuredReactionMode, false);
  assert.throws(() => parseConfig({ NPC_STRUCTURED_REACTION_MODE: "true" }), /requires PLAYER_CONVERSATION_COMMIT_MODE=true/);
  assert.throws(() => parseConfig({ NPC_STRUCTURED_REACTION_MODE: "yes" }), /must be 'true' or 'false'/);

  const enabled = parseConfig({
    INTERPRETER_VALIDATION_MODE: "true",
    PLAYER_CONVERSATION_COMMIT_MODE: "true",
    NPC_STRUCTURED_REACTION_MODE: "true"
  });
  assert.equal(enabled.npcStructuredReactionMode, true);
  assert.equal(getRuntimeConfig(enabled).npcStructuredReactionMode, true);
  assert.deepEqual(resolveNpcStructuredReactionPolicy({ npcStructuredReactionMode: false, playerConversationCommitMode: false }), { enabled: false });
  assert.deepEqual(resolveNpcStructuredReactionPolicy({ npcStructuredReactionMode: true, playerConversationCommitMode: true }), { enabled: true });

  const [browser, cli] = await Promise.all([
    readFile(new URL("../public/browserApp.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/cli.mjs", import.meta.url), "utf8")
  ]);
  assert.match(browser, /npcStructuredReactionEnabled:\s*runtimeConfig\?\.npcStructuredReactionMode === true/);
  assert.match(cli, /npcStructuredReactionEnabled:\s*runtimeConfig\.npcStructuredReactionMode/);

  const disabledRun = await runCompletedQuestion(false);
  const enabledRun = await runCompletedQuestion(true);
  assert.equal(disabledRun.game.npcStructuredReactionEnabled, false);
  assert.equal(enabledRun.game.npcStructuredReactionEnabled, true);
  assert.deepEqual(publicState(enabledRun.game), publicState(disabledRun.game));
  assert.deepEqual(enabledRun.providerRequests, disabledRun.providerRequests);
  assert.equal(enabledRun.game.state.stateVersion, 2);
  assert.equal(enabledRun.game.state.conversation.publications.length, disabledRun.game.state.conversation.publications.length);
});

test("engine-owned logical and attempt identities are separate, immutable, and mutation-free", async () => {
  const pending = await startPendingQuestion({ npcStructuredReactionEnabled: true });
  const trigger = pending.game.state.conversation.commitResults.at(-1);
  const before = authoritativeSnapshot(pending.game);
  const foundation = pending.game.createNpcReactionFoundation("npc1", trigger.requestId);
  const firstAttempt = pending.game.createNpcReactionAttemptFoundation(foundation.logicalReaction);
  const secondAttempt = pending.game.createNpcReactionAttemptFoundation(foundation.logicalReaction);

  assert.equal(foundation.logicalReaction.status, "planned");
  assert.equal(firstAttempt.status, "attempting");
  assert.equal(firstAttempt.reactionPlanId, foundation.logicalReaction.reactionPlanId);
  assert.equal(secondAttempt.reactionPlanId, foundation.logicalReaction.reactionPlanId);
  assert.notEqual(firstAttempt.reactionAttemptId, secondAttempt.reactionAttemptId);
  assert.notEqual(firstAttempt.reactionAttemptId, foundation.logicalReaction.reactionPlanId);
  assert.equal(foundation.logicalReaction.causationId, trigger.requestId);
  assert.equal(foundation.logicalReaction.originatingInputRecordId, trigger.inputRecordId);
  assert.equal(foundation.logicalReaction.preconditionStateVersion, trigger.resultingStateVersion);
  assert(Object.isFrozen(foundation));
  assert(Object.isFrozen(foundation.logicalReaction));
  assert(Object.isFrozen(foundation.projection));
  assert.deepEqual(authoritativeSnapshot(pending.game), before);
  assert.doesNotThrow(() => validateLogicalReactionFoundation(foundation.logicalReaction));
  assert.doesNotThrow(() => validateReactionAttemptFoundation(firstAttempt));

  pending.release();
  await pending.dispatch;
});

test("identity factories ignore caller-suggested authoritative IDs and reject invalid domains", () => {
  const generated = idSequence("engine");
  const logical = createLogicalReactionFoundation({
    gameSessionId: "game-1",
    triggerRequestId: "player-request-1",
    inputRecordId: "input-1",
    turnId: "turn-1",
    turnOrder: 1,
    phase: "player_question",
    actorId: "npc1",
    baseStateVersion: 1,
    createId: generated,
    reactionPlanId: "provider-controlled-plan"
  });
  assert.notEqual(logical.reactionPlanId, "provider-controlled-plan");
  const attempt = createReactionAttemptFoundation(logical, generated);
  assert.match(logical.reactionPlanId, /^reaction-plan-engine-/);
  assert.match(attempt.reactionAttemptId, /^reaction-attempt-engine-/);
  assert.throws(() => validateLogicalReactionFoundation({ ...logical, status: "retrying" }), hasCode("invalid_logical_reaction_status"));
  assert.throws(() => validateReactionAttemptFoundation({ ...attempt, status: "planned" }), hasCode("invalid_reaction_attempt_status"));
  assert.throws(() => assertLogicalReactionStatus("free-form"), hasCode("invalid_logical_reaction_status"));
  assert.throws(() => assertReactionAttemptStatus("free-form"), hasCode("invalid_reaction_attempt_status"));

  assert.deepEqual(LOGICAL_REACTION_STATUSES, ["planned", "active", "committed", "rejected", "superseded", "cancelled", "exhausted"]);
  assert.deepEqual(REACTION_ATTEMPT_STATUSES, ["attempting", "candidate_received", "validated", "accepted", "failed", "timed_out", "rejected", "aborted"]);
  assert.equal(isLogicalReactionTerminal("planned"), false);
  assert.equal(isLogicalReactionTerminal("exhausted"), true);
  assert.equal(isReactionAttemptTerminal("validated"), false);
  assert.equal(isReactionAttemptTerminal("accepted"), true);
  assert.throws(() => createReactionAttemptFoundation({ ...logical, status: "committed" }, generated), hasCode("logical_reaction_terminal"));
});

test("known-information projection is deterministic, strict, isolated, and allowlisted", async () => {
  const pending = await startPendingQuestion({ npcStructuredReactionEnabled: true, decorate(game) {
    const actor = game.getPlayer("npc1");
    actor.knownInfo.push({ day: 1, type: "seer_result", visibility: "private", shareable: false, targetId: "npc3", targetName: "Chika", result: "werewolf", text: "ACTOR_PRIVATE_RESULT_TEXT" });
    actor.privateMemory.push({ type: "secret", text: "ACTOR_PRIVATE_MEMORY_SECRET" });
    actor.hiddenInfo.push({ type: "secret", value: "ACTOR_HIDDEN_SECRET" });
    const other = game.getPlayer("npc2");
    other.knownInfo.push({ day: 1, type: "seer_result", visibility: "private", shareable: false, targetId: "npc4", result: "werewolf", text: "OTHER_ACTOR_RESULT_SECRET" });
    other.privateMemory.push({ type: "secret", text: "OTHER_ACTOR_MEMORY_SECRET" });
    other.hiddenInfo.push({ type: "secret", value: "OTHER_ACTOR_HIDDEN_SECRET" });
  } });
  const trigger = pending.game.state.conversation.commitResults.at(-1);
  const before = authoritativeSnapshot(pending.game);
  const first = pending.game.buildNpcKnownInformationProjection("npc1", trigger.requestId);
  const second = pending.game.buildNpcKnownInformationProjection("npc1", trigger.requestId);

  assert.deepEqual(first, second);
  assert.deepEqual(authoritativeSnapshot(pending.game), before);
  assert.doesNotThrow(() => validateNpcKnownInformationProjection(first));
  assert(Object.isFrozen(first.actorPrivate.investigationResults));
  assert.equal(first.actorPrivate.actorId, "npc1");
  assert.equal(first.actorPrivate.ownRole, "seer");
  assert.deepEqual(first.actorPrivate.investigationResults.map(({ targetId, result }) => ({ targetId, result })), [{ targetId: "npc3", result: "werewolf" }]);
  assert(first.public.events.length > 0);
  assert(first.public.participants.every((participant) => Object.keys(participant).sort().join(",") === "displayName,participantId,publicStatus"));
  assert(first.constraints.allowedReferenceIds.includes(trigger.inputRecordId));

  const serialized = JSON.stringify(first);
  for (const forbidden of [
    "ACTOR_PRIVATE_RESULT_TEXT", "ACTOR_PRIVATE_MEMORY_SECRET", "ACTOR_HIDDEN_SECRET",
    "OTHER_ACTOR_RESULT_SECRET", "OTHER_ACTOR_MEMORY_SECRET", "OTHER_ACTOR_HIDDEN_SECRET",
    "privateMemory", "hiddenInfo", "conversationPolicy", "developerLog", "idempotencyRecords", "provider"
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(Object.hasOwn(first.public.participants.find((entry) => entry.participantId === "npc2"), "role"), false);

  const detachedState = authoritativeSnapshot(pending.game);
  const detached = buildNpcKnownInformationProjection("npc1", trigger.requestId, detachedState);
  detachedState.players[0].name = "CHANGED_AFTER_PROJECTION";
  detachedState.players[0].suspicionScores.npc2 = 999;
  assert.equal(JSON.stringify(detached).includes("CHANGED_AFTER_PROJECTION"), false);
  assert.equal(detached.actorPrivate.suspicionScores.find((entry) => entry.targetId === "npc2").score === 999, false);
  assert.throws(() => validateNpcKnownInformationProjection({ ...first, unexpected: true }), hasCode("invalid_projection"));
  assert.throws(() => validateNpcKnownInformationProjection({ ...first, actorPrivate: { ...first.actorPrivate, hiddenInfo: [] } }), hasCode("invalid_projection"));

  pending.release();
  await pending.dispatch;
});

test("known-information projection rejects unknown, ineligible, stale, and unsupported actors without leaking state", async () => {
  const pending = await startPendingQuestion({ npcStructuredReactionEnabled: true });
  const trigger = pending.game.state.conversation.commitResults.at(-1);
  const snapshot = authoritativeSnapshot(pending.game);
  assert.throws(() => buildNpcKnownInformationProjection("missing", trigger.requestId, snapshot), hasCode("actor_not_found"));
  const dead = structuredClone(snapshot); dead.players.find((player) => player.id === "npc1").alive = false; dead.alivePlayers = dead.alivePlayers.filter((id) => id !== "npc1"); dead.deadPlayers.push("npc1");
  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, dead), hasCode("actor_not_eligible"));
  const phase = structuredClone(snapshot); phase.phase = "vote";
  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, phase), hasCode("unsupported_projection_phase"));
  const stale = structuredClone(snapshot); stale.stateVersion += 1;
  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, stale), hasCode("stale_reaction_trigger"));
  assert.throws(() => buildNpcKnownInformationProjection("npc1", "unknown-trigger", snapshot), hasCode("trigger_not_found"));

  for (const action of [
    () => buildNpcKnownInformationProjection("missing", trigger.requestId, snapshot),
    () => buildNpcKnownInformationProjection("npc1", "unknown-trigger", snapshot)
  ]) {
    try { action(); assert.fail("expected projection failure"); }
    catch (error) {
      assert.equal(JSON.stringify({ name: error.name, code: error.code, message: error.message }).includes("private"), false);
      assert.equal(Object.hasOwn(error, "state"), false);
    }
  }

  pending.release();
  await pending.dispatch;
});

async function runCompletedQuestion(npcStructuredReactionEnabled) {
  const providerRequests = [];
  const game = createGame({ npcStructuredReactionEnabled, responseProvider: { async generateResponse(request) { providerRequests.push(structuredClone(request)); return response(); } } });
  await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" });
  return { game, providerRequests };
}

async function startPendingQuestion({ npcStructuredReactionEnabled, decorate = () => {} }) {
  let releaseProvider;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const wait = new Promise((resolve) => { releaseProvider = resolve; });
  const game = createGame({ npcStructuredReactionEnabled, responseProvider: { async generateResponse() { markStarted(); await wait; return response(); } } });
  decorate(game);
  const dispatch = game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "hello" });
  await started;
  return { game, dispatch, release: releaseProvider };
}

function createGame({ npcStructuredReactionEnabled, responseProvider }) {
  return WerewolfGame.create({
    seed: 1,
    scenario: "sample",
    shuffleRoles: false,
    createId: idSequence("id"),
    interpreterValidationEnabled: true,
    playerConversationCommitEnabled: true,
    playerStructuredConsumerEnabled: false,
    npcStructuredReactionEnabled,
    interpreterProvider: interpreter(),
    responseProvider
  });
}

function interpreter() {
  return { async interpretPlayerInput(request) {
    return {
      schemaVersion: 1,
      requestId: request.requestId,
      correlationId: request.correlationId,
      serverCorrelationId: "server-correlation-1",
      result: {
        schemaVersion: 1,
        requestId: request.requestId,
        correlationId: request.correlationId,
        modelOutput: { schemaVersion: 1, alternatives: [{ alternativeId: "alternative-1", confidence: 1, speechActs: [{ type: "non_game_statement", sourceSpan: { start: 0, end: [...request.rawText].length } }] }] },
        diagnostics: { providerName: "test", model: "test", attemptCount: 1, elapsedMs: 0 }
      }
    };
  } };
}

function response() { return { text: "response", providerName: "test", model: "test", usage: null, notes: [] }; }
function idSequence(prefix) { let value = 0; return () => `${prefix}-${++value}`; }
function authoritativeSnapshot(game) { const { rng: _rng, ...state } = game.state; return structuredClone(state); }
function publicState(game) { const { developerLog: _developerLog, ...state } = authoritativeSnapshot(game); return state; }
function hasCode(code) { return (error) => error?.code === code; }
