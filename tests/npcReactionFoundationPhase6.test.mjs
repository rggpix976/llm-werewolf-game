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
  assert.deepEqual(Object.keys(first.public).sort(), ["attackDeaths", "claims", "day", "events", "executions", "participants", "phase", "triggeringInput", "votes"]);
  assert(first.public.events.length > 0);
  assert.deepEqual(first.public.votes, []);
  assert.deepEqual(first.public.executions, []);
  assert.deepEqual(first.public.attackDeaths, []);
  assert.deepEqual(first.public.triggeringInput, {
    schemaVersion: 1,
    inputRecordId: trigger.inputRecordId,
    requestId: trigger.requestId,
    correlationId: trigger.correlationId,
    turnId: pending.game.state.turnId,
    capturedStateVersion: trigger.preconditionStateVersion,
    actorId: "player",
    rawText: "hello",
    locale: "ja-JP"
  });
  assert(first.public.participants.every((participant) => Object.keys(participant).sort().join(",") === "displayName,participantId,publicStatus"));
  assert(first.constraints.allowedReferenceIds.includes(trigger.inputRecordId));
  for (const category of [first.public.participants, first.public.events, first.public.claims, first.public.votes, first.public.executions, first.public.attackDeaths]) assert(Object.isFrozen(category));
  assert(Object.isFrozen(first.public.triggeringInput));

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

test("public vote projection uses only structured vote declarations with authoritative ordering and bounds", async () => {
  const pending = await startPendingQuestion({ npcStructuredReactionEnabled: true });
  const trigger = pending.game.state.conversation.commitResults.at(-1);
  const snapshot = authoritativeSnapshot(pending.game);
  const base = snapshot.conversation.events[0];
  snapshot.conversation.events.push(
    structuredVoteEvent(base, { eventId: "vote-event-later", targetId: "npc3", createdOrder: base.createdOrder + 20 }),
    structuredVoteEvent(base, { eventId: "vote-event-earlier", targetId: "npc2", createdOrder: base.createdOrder + 10 })
  );
  snapshot.voteHistory.push({ day: 1, votes: { npc1: "npc4" }, executedId: "npc4", privateNote: "PRIVATE_FINAL_VOTE" });
  snapshot.players.find((player) => player.id === "npc1").voteHistory.push({ day: 2, targetId: "npc4", privateNote: "PRIVATE_ACTOR_VOTE" });

  const projected = buildNpcKnownInformationProjection("npc1", trigger.requestId, snapshot);
  assert.deepEqual(projected.public.votes.map(({ voteEventId, targetId }) => ({ voteEventId, targetId })), [
    { voteEventId: "vote-event-earlier", targetId: "npc2" },
    { voteEventId: "vote-event-later", targetId: "npc3" }
  ]);
  assert(projected.public.votes.every((vote) => Object.keys(vote).sort().join(",") === "actorId,occurredPhase,projectionType,schemaVersion,targetId,turnId,voteEventId"));
  assert(Object.isFrozen(projected.public.votes[0]));
  assert.equal(JSON.stringify(projected.public).includes("PRIVATE_FINAL_VOTE"), false);
  assert.equal(JSON.stringify(projected.public).includes("PRIVATE_ACTOR_VOTE"), false);
  const missingVoteProjection = structuredClone(projected);
  missingVoteProjection.public.votes.pop();
  assert.throws(() => validateNpcKnownInformationProjection(missingVoteProjection), hasCode("invalid_public_vote_reference"));

  const reordered = structuredClone(snapshot);
  reordered.players.reverse();
  reordered.conversation.events.reverse();
  reordered.conversation.claims.reverse();
  assert.deepEqual(buildNpcKnownInformationProjection("npc1", trigger.requestId, reordered), projected);

  const overflow = authoritativeSnapshot(pending.game);
  const overflowBase = overflow.conversation.events[0];
  for (let index = 0; index < 33; index += 1) overflow.conversation.events.push(structuredVoteEvent(overflowBase, { eventId: `vote-event-${index}`, targetId: "npc2", createdOrder: overflowBase.createdOrder + index + 1 }));
  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, overflow), hasCode("projection_public_vote_limit"));

  pending.release();
  await pending.dispatch;
});

test("execution and attack-death categories reject legacy synthesis and enforce strict public shapes", async () => {
  const pending = await startPendingQuestion({ npcStructuredReactionEnabled: true });
  const trigger = pending.game.state.conversation.commitResults.at(-1);
  const snapshot = authoritativeSnapshot(pending.game);
  snapshot.publicInfo.push({ type: "execution", playerId: "npc2", text: "LEGACY_EXECUTION_TEXT", hiddenRole: "werewolf" });
  snapshot.publicInfo.push({ type: "night_death", playerId: "npc3", attackerId: "npc4", text: "SECRET_ATTACK_TEXT" });
  snapshot.voteHistory.push({ day: 1, executedId: "npc2", votes: { npc1: "npc2" } });

  const projected = buildNpcKnownInformationProjection("npc1", trigger.requestId, snapshot);
  assert.deepEqual(projected.public.executions, []);
  assert.deepEqual(projected.public.attackDeaths, []);
  assert.equal(JSON.stringify(projected.public).includes("LEGACY_EXECUTION_TEXT"), false);
  assert.equal(JSON.stringify(projected.public).includes("SECRET_ATTACK_TEXT"), false);
  assert.equal(JSON.stringify(projected.public).includes("attackerId"), false);
  assert.equal(JSON.stringify(projected.public).includes("hiddenRole"), false);

  const withStructuredShapes = structuredClone(projected);
  withStructuredShapes.public.executions.push({ schemaVersion: 1, projectionType: "execution", executionEventId: "execution-event-1", executedPlayerId: "npc2", turnId: trigger.requestId, occurredPhase: "vote" });
  withStructuredShapes.public.attackDeaths.push({ schemaVersion: 1, projectionType: "attack_death", attackEventId: "attack-event-1", attackedPlayerId: "npc3", turnId: trigger.requestId, occurredPhase: "night" });
  withStructuredShapes.constraints.allowedReferenceIds.push("execution-event-1", "attack-event-1");
  assert.doesNotThrow(() => validateNpcKnownInformationProjection(withStructuredShapes));
  assert.throws(() => validateNpcKnownInformationProjection({ ...withStructuredShapes, public: { ...withStructuredShapes.public, executions: [{ ...withStructuredShapes.public.executions[0], hiddenRole: "werewolf" }] } }), hasCode("invalid_projection"));
  assert.throws(() => validateNpcKnownInformationProjection({ ...withStructuredShapes, public: { ...withStructuredShapes.public, attackDeaths: [{ ...withStructuredShapes.public.attackDeaths[0], attackerId: "npc4" }] } }), hasCode("invalid_projection"));
  assert.throws(() => validateNpcKnownInformationProjection({ ...withStructuredShapes, public: { ...withStructuredShapes.public, executions: [{ ...withStructuredShapes.public.executions[0], executedPlayerId: "deleted-player" }] } }), hasCode("unknown_public_participant"));
  assert.throws(() => validateNpcKnownInformationProjection({ ...withStructuredShapes, public: { ...withStructuredShapes.public, attackDeaths: [{ ...withStructuredShapes.public.attackDeaths[0], attackedPlayerId: "deleted-player" }] } }), hasCode("unknown_public_participant"));
  assert.throws(() => validateNpcKnownInformationProjection({ ...projected, public: { ...projected.public, executions: Array.from({ length: 17 }, (_, index) => ({ schemaVersion: 1, projectionType: "execution", executionEventId: `execution-${index}`, executedPlayerId: "npc2", turnId: trigger.requestId, occurredPhase: "vote" })) } }), hasCode("projection_execution_limit"));
  assert.throws(() => validateNpcKnownInformationProjection({ ...projected, public: { ...projected.public, attackDeaths: Array.from({ length: 17 }, (_, index) => ({ schemaVersion: 1, projectionType: "attack_death", attackEventId: `attack-${index}`, attackedPlayerId: "npc2", turnId: trigger.requestId, occurredPhase: "night" })) } }), hasCode("projection_attack_death_limit"));

  pending.release();
  await pending.dispatch;
});

test("triggering input is exact, bounded, detached, and excludes unrelated input history", async () => {
  const pending = await startPendingQuestion({ npcStructuredReactionEnabled: true });
  const trigger = pending.game.state.conversation.commitResults.at(-1);
  const snapshot = authoritativeSnapshot(pending.game);
  const triggerInput = snapshot.conversation.inputRecords.find((record) => record.inputRecordId === trigger.inputRecordId);
  snapshot.conversation.inputRecords.push({ ...triggerInput, inputRecordId: "unrelated-input", requestId: "unrelated-request", correlationId: "unrelated-correlation", rawText: "PRIVATE_PREVALIDATION_TEXT", createdOrder: triggerInput.createdOrder + 100 });
  const projected = buildNpcKnownInformationProjection("npc1", trigger.requestId, snapshot);
  assert.equal(projected.public.triggeringInput.rawText, "hello");
  assert.equal(JSON.stringify(projected).includes("PRIVATE_PREVALIDATION_TEXT"), false);
  triggerInput.rawText = "MUTATED_AFTER_BUILD";
  assert.equal(projected.public.triggeringInput.rawText, "hello");

  const oversized = authoritativeSnapshot(pending.game);
  oversized.conversation.inputRecords.find((record) => record.inputRecordId === trigger.inputRecordId).rawText = "x".repeat(2001);
  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, oversized), hasCode("invalid_triggerRawText"));
  const absent = authoritativeSnapshot(pending.game);
  absent.conversation.inputRecords = absent.conversation.inputRecords.filter((record) => record.inputRecordId !== trigger.inputRecordId);
  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, absent), hasCode("trigger_input_not_found"));
  const unpublished = authoritativeSnapshot(pending.game);
  unpublished.conversation.publications = unpublished.conversation.publications.filter((record) => record.publicationId !== trigger.playerPublicationId);
  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, unpublished), hasCode("trigger_publication_not_found"));
  const mismatchedPublication = authoritativeSnapshot(pending.game);
  mismatchedPublication.conversation.publications.find((record) => record.publicationId === trigger.playerPublicationId).correlationId = "different-correlation";
  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, mismatchedPublication), hasCode("stale_reaction_trigger"));

  pending.release();
  await pending.dispatch;
});

test("public projection fails closed on malformed, duplicate, name-only, and unknown references", async () => {
  const pending = await startPendingQuestion({ npcStructuredReactionEnabled: true });
  const trigger = pending.game.state.conversation.commitResults.at(-1);
  const original = authoritativeSnapshot(pending.game);
  const base = original.conversation.events[0];
  const mutateWithVote = (overrides) => {
    const candidate = structuredClone(original);
    candidate.conversation.events.push(structuredVoteEvent(base, { eventId: "vote-integrity", targetId: "npc2", createdOrder: base.createdOrder + 1, ...overrides }));
    return candidate;
  };

  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, mutateWithVote({ targetId: "deleted-player" })), hasCode("unknown_public_participant"));
  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, mutateWithVote({ targetId: "bad id" })), hasCode("invalid_eventTargetId"));
  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, mutateWithVote({ targetId: undefined, targetName: "Aoi" })), hasCode("invalid_voteTargetId"));
  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, mutateWithVote({ eventId: undefined })), hasCode("invalid_eventId"));

  const duplicate = structuredClone(original);
  duplicate.conversation.events.push({ ...base, createdOrder: base.createdOrder + 1 });
  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, duplicate), hasCode("duplicate_public_event"));
  const duplicateOrder = structuredClone(original);
  duplicateOrder.conversation.events.push(structuredVoteEvent(base, { eventId: "vote-order-conflict", targetId: "npc2", createdOrder: base.createdOrder }));
  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, duplicateOrder), hasCode("duplicate_public_event_order"));

  const deletedParticipant = mutateWithVote({ targetId: "npc2" });
  deletedParticipant.players = deletedParticipant.players.filter((player) => player.id !== "npc2");
  deletedParticipant.alivePlayers = deletedParticipant.alivePlayers.filter((id) => id !== "npc2");
  const deletedActorView = deletedParticipant.players.find((player) => player.id === "npc1");
  delete deletedActorView.suspicionScores.npc2;
  deletedActorView.voteHistory = deletedActorView.voteHistory.filter((vote) => vote.targetId !== "npc2");
  deletedActorView.knownInfo = deletedActorView.knownInfo.filter((fact) => fact.targetId !== "npc2");
  assert.throws(() => buildNpcKnownInformationProjection("npc1", trigger.requestId, deletedParticipant), hasCode("unknown_public_participant"));

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
function structuredVoteEvent(base, overrides) { return { ...base, eventType: "vote_declared", ...overrides }; }
function idSequence(prefix) { let value = 0; return () => `${prefix}-${++value}`; }
function authoritativeSnapshot(game) { const { rng: _rng, ...state } = game.state; return structuredClone(state); }
function publicState(game) { const { developerLog: _developerLog, ...state } = authoritativeSnapshot(game); return state; }
function hasCode(code) { return (error) => error?.code === code; }
