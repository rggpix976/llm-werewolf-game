import assert from "node:assert/strict";
import test from "node:test";

import { createPseudoNpcReactionCandidateInvoker } from "../src/npcReactionCandidateUpstream.mjs";
import { consumeLiveActionDisplay } from "../src/playerDisplaySink.mjs";
import {
  assertPrivacySafe,
  assertPrivateFailureSource,
  assertPrivateProjectionAbsent,
  assertPrivateProjectionSource,
  assertSafeIdentityShape,
  authoritativeSnapshot,
  completePlayerAndNpc,
  createAcceptanceGame,
  createPrivateFailureEvidence,
  createDeferred,
  createDeliveryAcceptanceGame,
  createFailingNpcDom,
  installOneShotAcknowledgementPublicationFault
} from "./helpers/npcStructuredReactionAcceptanceHarness.mjs";

test("ACC-001 flag-off engine preserves legacy exclusivity", async () => {
  const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
  const { game } = createAcceptanceGame({ counters, npcStructuredReactionEnabled: false });
  const beforePlans = game.state.conversation.reactionPlans.length;
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Legacy question?" });
  assert.equal(action.result.text, "legacy");
  assert.equal(counters.legacy, 1);
  assert.equal(counters.candidate, 0);
  assert.equal(counters.npcWrites, 0);
  assert.equal(game.state.conversation.reactionPlans.length, beforePlans);
  assert.equal(game.state.conversation.npcReactionCommitIdempotencyRecords.length, 0);
  game.destroy();
});

for (const [id, playerStructuredConsumerEnabled] of [["ACC-002", false], ["ACC-003", true]]) {
  test(`${id} flag-on engine accepts two questions with consumer ${playerStructuredConsumerEnabled ? "on" : "off"}`, async () => {
    const gate = createDeferred();
    const started = createDeferred();
    const pseudo = createPseudoNpcReactionCandidateInvoker();
    const order = [];
    const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
    const { game } = createAcceptanceGame({
      counters,
      playerStructuredConsumerEnabled,
      npcWrite: async () => { order.push(`npc-${counters.npcWrites}`); },
      invokeProvider: async (request, options) => {
        counters.candidate += 1;
        if (counters.candidate === 1) {
          started.resolve();
          await gate.promise;
        }
        return pseudo(request, options);
      }
    });
    const initialVersion = game.state.stateVersion;
    const firstPending = game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Question A?" });
    await started.promise;
    assert.equal(game.state.phase, "player_question");
    assert.equal(game.state.stateVersion, initialVersion + 1);
    assert.equal(game.state.conversation.reactionPlans.length, 0);
    gate.resolve();
    const first = await firstPending;
    assert.equal(first.result.structuredNpc.routeStatus, "committed");
    assert.equal(first.result.structuredNpc.deliveryStatus, "pending_player_display");
    assert.equal(game.state.phase, "day_discussion");
    assert.equal(game.state.stateVersion, initialVersion + 2);
    assert.equal(game.state.conversation.events.filter((entry) => entry.actorId === "npc1").every((entry) => entry.occurredPhase === "player_question"), true);
    await completePlayerAndNpc(game, first, { counters, order, playerLabel: "player-1" });
    assert.equal(game.state.phase, "day_discussion");

    const second = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc2", input: "Question B?" });
    assert.equal(second.result.structuredNpc.routeStatus, "committed");
    assert.equal(second.result.structuredNpc.errorCode, null);
    await completePlayerAndNpc(game, second, { counters, order, playerLabel: "player-2" });

    assert.equal(counters.candidate, 2);
    assert.equal(counters.legacy, 0);
    assert.equal(counters.playerWrites, 2);
    assert.equal(counters.npcWrites, 2);
    assert.deepEqual(order, ["player-1", "npc-1", "player-2", "npc-2"]);
    assert.equal(game.state.phase, "day_discussion");
    assert.equal(game.state.stateVersion, initialVersion + 4);
    assert.equal(game.state.conversation.reactionPlans.length, 2);
    assert.equal(game.state.conversation.npcReactionCommitIdempotencyRecords.length, 2);
    assertSafeIdentityShape(game.state);
    game.destroy();
  });
}

test("ACC-004 replay is authoritative and has no additional effects", async () => {
  const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
  const { game } = createAcceptanceGame({ counters });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Replay question?" });
  await completePlayerAndNpc(game, action, { counters });
  const before = authoritativeSnapshot(game);
  const calls = structuredClone(counters);
  const result = action.result.conversationCommitResult;
  const replay = await game.npcStructuredProductionIntegration.executeNpcReaction({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    triggerRequestId: result.requestId,
    originatingInputRecordId: result.inputRecordId
  });
  assert.equal(replay.routeStatus, "replayed");
  assert.equal(replay.deliveryStatus, "skipped_not_eligible");
  assert.deepEqual(counters, calls);
  assert.deepEqual(authoritativeSnapshot(game), before);
  game.destroy();
});

test("ACC-005 concurrent commands reject the second mutation while reads remain available", async () => {
  const started = createDeferred();
  const gate = createDeferred();
  const pseudo = createPseudoNpcReactionCandidateInvoker();
  let calls = 0;
  const { game } = createAcceptanceGame({
    invokeProvider: async (request, options) => {
      calls += 1;
      started.resolve();
      await gate.promise;
      return pseudo(request, options);
    }
  });
  const first = game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "First?" });
  await started.promise;
  const stateRead = await game.dispatchPlayerAction({ type: "get_state" });
  assert.equal(stateRead.ok, true);
  await assert.rejects(
    () => game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc2", input: "Second?" }),
    (error) => error.code === "input_in_progress"
  );
  await assert.rejects(
    () => game.dispatchPlayerAction({ type: "advance_vote" }),
    (error) => error.code === "input_in_progress"
  );
  assert.equal(calls, 1);
  gate.resolve();
  const action = await first;
  await completePlayerAndNpc(game, action);
  assert.equal(game.state.conversation.reactionPlans.length, 1);
  const next = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc2", input: "After terminal?" });
  assert.equal(next.result.structuredNpc.routeStatus, "committed");
  game.destroy();
});

test("ACC-006 one retryable Provider failure then success remains bounded", async () => {
  let calls = 0;
  const pseudo = createPseudoNpcReactionCandidateInvoker();
  const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
  const { game } = createDeliveryAcceptanceGame({
    counters,
    scheduleTimer: scheduleInMicrotask,
    invokeProvider: async (request, options) => {
      calls += 1;
      counters.candidate += 1;
      if (calls === 1) throw Object.assign(new Error("RAW_PROVIDER_MARKER_DO_NOT_LEAK"), { code: "network_failure", retryable: true });
      return pseudo(request, options);
    }
  });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Retry once?" });
  await completePlayerAndNpc(game, action, { counters });
  assert.equal(calls, 2);
  assert.equal(action.result.structuredNpc.routeStatus, "committed");
  assert.equal(game.state.conversation.reactionPlans.length, 1);
  assert.equal(counters.npcWrites, 1);
  assert.equal(counters.legacy, 0);
  assertPrivacySafe(action);
  game.destroy();
});

test("ACC-007 terminal Provider exhaustion and malformed candidate settle and recover without legacy fallback", async (t) => {
  await t.test("retry exhaustion", async () => {
    const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
    const pseudo = createPseudoNpcReactionCandidateInvoker();
    let fail = true;
    const { game } = createDeliveryAcceptanceGame({
      counters,
      scheduleTimer: scheduleInMicrotask,
      invokeProvider: async (request, options) => {
        counters.candidate += 1;
        if (fail) throw Object.assign(new Error("RAW_PROVIDER_MARKER_DO_NOT_LEAK"), { code: "network_failure", retryable: true });
        return pseudo(request, options);
      }
    });
    const initialVersion = game.state.stateVersion;
    const failed = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Exhaust?" });
    assert.notEqual(failed.result.structuredNpc.routeStatus, "committed");
    assert.equal(game.state.phase, "day_discussion");
    assert.equal(game.state.stateVersion, initialVersion + 2);
    assert.equal(game.state.conversation.reactionPlans.length, 0);
    assert.equal(game.state.conversation.commitResults.filter((entry) => entry.commitType === "player_conversation").length, 1);
    assert.equal(counters.legacy, 0);
    assert.equal(counters.npcWrites, 0);
    assertPrivacySafe(failed);
    fail = false;
    const recovered = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc2", input: "Recover?" });
    assert.equal(recovered.result.structuredNpc.routeStatus, "committed");
    game.destroy();
  });

  await t.test("self-consistent malformed candidate", async () => {
    const pseudo = createPseudoNpcReactionCandidateInvoker();
    let first = true;
    const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
    const { game } = createAcceptanceGame({
      counters,
      invokeProvider: async (request, options) => {
        counters.candidate += 1;
        const result = await pseudo(request, options);
        if (first) {
          first = false;
          return { ...result, candidate: { schemaVersion: 1, proposals: [{ proposalType: "decline" }] } };
        }
        return result;
      }
    });
    const failed = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Malformed?" });
    assert.equal(failed.result.structuredNpc.routeStatus, "rejected");
    assert.equal(game.state.phase, "day_discussion");
    assert.equal(game.state.stateVersion, 2);
    assert.equal(game.state.conversation.reactionPlans.length, 0);
    assert.equal(counters.legacy, 0);
    const recovered = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc2", input: "Valid now?" });
    assert.equal(recovered.result.structuredNpc.routeStatus, "committed");
    game.destroy();
  });
});

test("ACC-008 destroy invalidates a pending Provider and suppresses its late result", async () => {
  const started = createDeferred();
  const gate = createDeferred();
  const pseudo = createPseudoNpcReactionCandidateInvoker();
  const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
  const { game } = createAcceptanceGame({
    counters,
    invokeProvider: async (request, options) => {
      counters.candidate += 1;
      started.resolve();
      await gate.promise;
      return pseudo(request, options);
    }
  });
  const pending = game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Late?" });
  await started.promise;
  game.destroy();
  const destroyed = authoritativeSnapshot(game);
  gate.resolve();
  await assert.rejects(pending);
  assert.deepEqual(authoritativeSnapshot(game), destroyed);
  assert.equal(counters.npcWrites, 0);
  assert.equal(counters.legacy, 0);
});

test("ACC-009 Player display explicit retry preserves the frozen action and starts NPC delivery once", async () => {
  const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
  const { game } = createAcceptanceGame({ counters });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Display retry?" });
  const bookkeeping = new Map();
  let playerAttempts = 0;
  const display = () => consumeLiveActionDisplay({
    game,
    action,
    consumerId: "acceptance-player",
    sinkType: "cli",
    bookkeeping,
    writeStructured: async () => {
      playerAttempts += 1;
      if (playerAttempts === 1) throw new Error("proved player no-effect");
      counters.playerWrites += 1;
    },
    writeLegacy: async () => {
      playerAttempts += 1;
      if (playerAttempts === 1) throw new Error("proved player no-effect");
      counters.playerWrites += 1;
    }
  });
  await assert.rejects(display);
  assert.equal(counters.npcWrites, 0);
  await display();
  const completed = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId: action.result.conversationCommitResult.playerPublicationId
  });
  assert.equal(completed.deliveryStatus, "delivered");
  assert.equal(playerAttempts, 2);
  assert.equal(counters.playerWrites, 1);
  assert.equal(counters.npcWrites, 1);
  assert.equal(counters.candidate, 1);
  game.destroy();
});

test("ACC-010 repeat_sink retries only the failed sink", async () => {
  const npcDom = createFailingNpcDom(1);
  const counters = { candidate: 0, legacy: 0, npcWrites: 0, playerWrites: 0 };
  const { game } = createDeliveryAcceptanceGame({ counters, npcDom });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Repeat sink?" });
  const planCount = game.state.conversation.reactionPlans.length;
  await consumeLiveActionDisplay({
    game, action, consumerId: "acceptance-player", sinkType: "cli", bookkeeping: new Map(),
    writeStructured: async () => {}, writeLegacy: async () => {}
  });
  const input = { schemaVersion: 1, gameSessionId: game.state.gameSessionId, playerPublicationId: action.result.conversationCommitResult.playerPublicationId };
  const retry = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input);
  assert.equal(retry.deliveryStatus, "retry_required");
  const version = game.state.stateVersion;
  const delivered = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input);
  assert.equal(delivered.deliveryStatus, "delivered");
  assert.equal(npcDom.appendAttempts, 2);
  assert.equal(npcDom.container.children.length, 1);
  assert.equal(counters.candidate, 1);
  assert.equal(game.state.conversation.reactionPlans.length, planCount);
  assert.equal(game.state.stateVersion, version);
  game.destroy();
});

test("ACC-011 ack_only retains one sink effect while explicit completion retries acknowledgement", async () => {
  const observations = [];
  const counters = { candidate: 0, legacy: 0, npcWrites: 0, playerWrites: 0 };
  const { game } = createDeliveryAcceptanceGame({ counters, observer: (event) => observations.push(event) });
  const before = authoritativeSnapshot(game);
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Ack only?" });
  const afterCommit = authoritativeSnapshot(game);
  await consumeLiveActionDisplay({
    game, action, consumerId: "acceptance-player", sinkType: "cli", bookkeeping: new Map(),
    writeStructured: async () => {}, writeLegacy: async () => {}
  });
  const input = { schemaVersion: 1, gameSessionId: game.state.gameSessionId, playerPublicationId: action.result.conversationCommitResult.playerPublicationId };
  const fault = installOneShotAcknowledgementPublicationFault();
  try {
    assertPrivateFailureSource(fault.failureEvidence);
    const first = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input);
    const second = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input);
    const retryObservation = observations.find((event) => event.eventType === "npc_publication_delivery_orchestration"
      && event.resultType === "retry_required");
    assert.equal(first.deliveryStatus, "retry_required");
    assert.equal(second.deliveryStatus, "acknowledged_existing");
    assert.equal(retryObservation.retryMode, "ack_only");
    assert.equal(first.publicationId, second.publicationId);
    assert.equal(first.publicationId, action.result.structuredNpc.publicationId);
    assert.equal(fault.acknowledgementAttempts, 2);
    assert.equal(counters.npcWrites, 1);
    assert.equal(counters.candidate, 1);
    assert.equal(counters.legacy, 0);
    assert.equal(game.state.conversation.reactionPlans.length - before.conversation.reactionPlans.length, 1);
    assert.equal(game.state.conversation.publications.filter((entry) => entry.publicationId === input.playerPublicationId).length, 1);
    assert.deepEqual(authoritativeSnapshot(game), afterCommit);
    assertPrivacySafe(first, Object.values(fault.failureEvidence.markers));
    assertPrivacySafe(second, Object.values(fault.failureEvidence.markers));
    assertPrivacySafe(observations, Object.values(fault.failureEvidence.markers));
  } finally {
    fault.restore();
  }
  game.destroy();
});

test("ACC-012 unknown sink effect closes terminally without automatic redisplay", async () => {
  const counters = { candidate: 0, legacy: 0, npcWrites: 0, playerWrites: 0 };
  const { game } = createDeliveryAcceptanceGame({
    counters,
    npcWrite: async () => { throw new Error("ambiguous sink failure"); },
    failureGuarantee: "unknown_on_failure"
  });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Ambiguous?" });
  await consumeLiveActionDisplay({
    game, action, consumerId: "acceptance-player", sinkType: "cli", bookkeeping: new Map(),
    writeStructured: async () => {}, writeLegacy: async () => {}
  });
  const version = game.state.stateVersion;
  const input = { schemaVersion: 1, gameSessionId: game.state.gameSessionId, playerPublicationId: action.result.conversationCommitResult.playerPublicationId };
  const terminal = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input);
  assert.equal(["delivery_failed", "failed_terminal"].includes(terminal.deliveryStatus), true);
  const duplicate = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input);
  assert.deepEqual(duplicate, terminal);
  assert.equal(counters.npcWrites, 1);
  assert.equal(game.state.stateVersion, version);
  assert.equal(game.state.conversation.reactionPlans.length, 1);
  game.destroy();
});

test("ACC-025 ACC-026 ACC-027 ACC-028 public progression, dead NPC, bounded winner, and terminal no-ops", async () => {
  const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
  const allocatedIds = [];
  const interpreterObservations = [];
  const { game } = createAcceptanceGame({
    counters,
    allocatedIds,
    interpreterObserver: (observation) => interpreterObservations.push(observation)
  });
  for (const [targetId, input] of [["npc3", "Question one?"], ["npc1", "Question two?"]]) {
    const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId, input });
    await completePlayerAndNpc(game, action, { counters });
  }
  const candidateBeforeProgression = counters.candidate;
  const vote = await game.dispatchPlayerAction({ type: "advance_vote" });
  assert.ok(vote.result.executedId);
  const deadId = vote.result.executedId;
  const night = await game.dispatchPlayerAction({ type: "run_night" });
  assert.equal(night.ok, true);
  assert.equal(counters.candidate, candidateBeforeProgression);
  assert.equal(game.state.phase, "day_discussion");
  const deadState = authoritativeSnapshot(game);
  const deadCounters = structuredClone(counters);
  const deadAllocatedStart = allocatedIds.length;
  const deadInterpreterStart = interpreterObservations.length;
  const deadQuestion = await game.dispatchPlayerAction({ type: "ask_npc", targetId: deadId, input: "Can you answer?" });
  const deadAfter = authoritativeSnapshot(game);
  const deadAllocatedIds = allocatedIds.slice(deadAllocatedStart);
  assert.equal(deadQuestion.result.responded, false);
  assert.equal(deadQuestion.result.structuredNpc.resultType, "npc_structured_interpreter_outcome");
  assert.equal(deadQuestion.result.structuredNpc.outcomeCategory, "rejected");
  assert.equal(deadQuestion.result.structuredNpc.reasonCode, "target_not_alive");
  assert.equal(deadQuestion.result.structuredNpc.legacyUsed, false);
  assert.equal(deadQuestion.result.structuredNpc.legacySuppressed, true);
  assert.equal(deadAfter.phase, deadState.phase);
  assert.equal(deadAfter.stateVersion, deadState.stateVersion);
  assert.equal(deadAfter.turnOrder, deadState.turnOrder + 1);
  assert.notEqual(deadAfter.turnId, deadState.turnId);
  assert.equal(deadAllocatedIds.length, 4);
  assert.equal(new Set(deadAllocatedIds).size, deadAllocatedIds.length);
  assert.equal(deadAfter.turnId, `turn-${deadAllocatedIds[0]}`);
  assert.deepEqual(deadAfter, {
    ...deadState,
    turnOrder: deadState.turnOrder + 1,
    turnId: `turn-${deadAllocatedIds[0]}`
  });
  assert.deepEqual(counters, { ...deadCounters, ids: deadCounters.ids + 4 });
  assert.equal(interpreterObservations.length, deadInterpreterStart + 1);
  assert.equal(interpreterObservations.at(-1).outcomeCategory, "rejected");
  assert.equal(interpreterObservations.at(-1).reasonCode, "target_not_alive");
  assert.equal(interpreterObservations.at(-1).turnId, deadAfter.turnId);
  assert.equal(counters.candidate, candidateBeforeProgression);
  const aliveTarget = game.getPublicSnapshot().players.find((player) => player.alive && player.id.startsWith("npc"))?.id;
  assert.ok(aliveTarget);
  const aliveBefore = authoritativeSnapshot(game);
  const aliveCandidateBefore = counters.candidate;
  const third = await game.dispatchPlayerAction({ type: "ask_npc", targetId: aliveTarget, input: "Final suspicion?" });
  await completePlayerAndNpc(game, third, { counters });
  assert.equal(third.result.responded, true);
  assert.equal(counters.candidate, aliveCandidateBefore + 1);
  assert.equal(game.state.stateVersion, aliveBefore.stateVersion + 2);
  assert.equal(game.state.turnOrder, aliveBefore.turnOrder + 1);
  assert.notEqual(game.state.turnId, aliveBefore.turnId);
  assert.equal(game.state.phase, "day_discussion");
  await game.dispatchPlayerAction({ type: "advance_vote" });
  assert.equal(game.state.winner, "village");
  const terminal = authoritativeSnapshot(game);
  const calls = structuredClone(counters);
  const ask = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "After winner?" });
  assert.equal(ask.result.reason, "game_already_finished");
  for (let index = 0; index < 3; index += 1) {
    const postVote = await game.dispatchPlayerAction({ type: "advance_vote" });
    assert.equal(postVote.result, null);
  }
  const postNight = await game.dispatchPlayerAction({ type: "run_night" });
  assert.equal(postNight.result.reason, "game_already_finished");
  const read = await game.dispatchPlayerAction({ type: "get_state" });
  assert.equal(read.ok, true);
  assert.deepEqual(authoritativeSnapshot(game), terminal);
  assert.deepEqual(counters, calls);
  assertSafeIdentityShape(game.state);
  game.destroy();
});

test("ACC-029 fresh disabled instance is the rollback boundary", async () => {
  const enabledCounters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
  const { game: enabled } = createDeliveryAcceptanceGame({ counters: enabledCounters, idPrefix: "enabled-game" });
  const enabledAction = await enabled.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Enabled?" });
  await completePlayerAndNpc(enabled, enabledAction, { counters: enabledCounters });
  const oldSession = enabled.state.gameSessionId;
  enabled.destroy();

  const disabledCounters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
  const { game: disabled } = createDeliveryAcceptanceGame({
    counters: disabledCounters,
    idPrefix: "disabled-game",
    npcStructuredReactionEnabled: false
  });
  const disabledAction = await disabled.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Disabled?" });
  assert.notEqual(disabled.state.gameSessionId, oldSession);
  assert.equal(disabledAction.result.text, "legacy");
  assert.equal(disabledCounters.legacy, 1);
  assert.equal(disabledCounters.candidate, 0);
  assert.equal(disabled.state.conversation.reactionPlans.length, 0);
  disabled.destroy();
});

test("ACC-030 engine state, identities, immutability, and privacy remain closed", async () => {
  const observations = [];
  const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
  const pseudo = createPseudoNpcReactionCandidateInvoker();
  const failureEvidence = createPrivateFailureEvidence("ENGINE");
  let providerCalls = 0;
  let failedProjectionEvidence;
  let successfulProjectionEvidence;
  let successfulRequest;
  const { game } = createDeliveryAcceptanceGame({
    counters,
    observer: (event) => observations.push(event),
    invokeProvider: async (request, options) => {
      providerCalls += 1;
      counters.candidate += 1;
      const projectionEvidence = assertPrivateProjectionSource(request);
      if (providerCalls === 1) {
        failedProjectionEvidence = projectionEvidence;
        throw failureEvidence.error;
      }
      successfulProjectionEvidence = projectionEvidence;
      successfulRequest = request;
      return pseudo(request, options);
    }
  });
  assertPrivateFailureSource(failureEvidence);
  const rejected = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Private failure audit?" });
  assert.equal(rejected.result.structuredNpc.routeStatus, "exhausted");
  assert.ok(failedProjectionEvidence);
  assertPrivacySafe(rejected, Object.values(failureEvidence.markers));
  assertPrivateProjectionAbsent(rejected, failedProjectionEvidence);
  assertPrivacySafe(game.getPublicSnapshot(), Object.values(failureEvidence.markers));
  assertPrivateProjectionAbsent(game.getPublicSnapshot(), failedProjectionEvidence);
  assertPrivacySafe(observations, Object.values(failureEvidence.markers));
  assertPrivateProjectionAbsent(observations, failedProjectionEvidence);

  const before = authoritativeSnapshot(game);
  const observationStart = observations.length;
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Audit?" });
  const intermediate = authoritativeSnapshot(game);
  const { delivery, bookkeeping } = await completePlayerAndNpc(game, action, { counters });
  const after = authoritativeSnapshot(game);
  assertSafeIdentityShape(before);
  assertSafeIdentityShape(intermediate);
  assertSafeIdentityShape(game.state);
  assert.deepEqual(after, intermediate, "Delivery must not mutate canonical authority");
  assert.equal(intermediate.gameSessionId, before.gameSessionId);
  assert.equal(after.gameSessionId, before.gameSessionId);
  assert.equal(intermediate.stateVersion, before.stateVersion + 2);
  assert.equal(intermediate.turnOrder, before.turnOrder + 1);
  assert.notEqual(intermediate.turnId, before.turnId);

  const added = assertConversationAppendOnlyDeltas(before.conversation, intermediate.conversation);
  assertConversationRegistryIdentityUniqueness(intermediate.conversation);
  const [inputRecord] = added.inputRecords;
  const [acceptedSpeechAct] = added.acceptedSpeechActs;
  const [displayPlan] = added.displayPlans;
  const [plan] = added.reactionPlans;
  const [playerMapping] = added.playerLegacyDisplayCompatibilityRecords;
  const [playerIdempotency] = added.idempotencyRecords;
  const [npcIdempotency] = added.npcReactionCommitIdempotencyRecords;
  const [playerPublication] = added.publications.filter((entry) => entry.recordType === "player_utterance_published");
  const [npcPublication] = added.publications.filter((entry) => entry.recordType === "npc_canonical_published");
  const [playerResult] = added.commitResults.filter((entry) => entry.commitType === "player_conversation");
  const [npcResult] = added.commitResults.filter((entry) => entry.commitType === "npc_reaction");
  assert.equal(added.publications.filter((entry) => entry.recordType === "player_utterance_published").length, 1);
  assert.equal(added.publications.filter((entry) => entry.recordType === "npc_canonical_published").length, 1);
  assert.equal(added.commitResults.filter((entry) => entry.commitType === "player_conversation").length, 1);
  assert.equal(added.commitResults.filter((entry) => entry.commitType === "npc_reaction").length, 1);

  assert.deepEqual(action.result.conversationCommitResult, playerResult);
  assert.equal(inputRecord.requestId, playerResult.requestId);
  assert.equal(inputRecord.requestId, playerPublication.requestId);
  assert.equal(inputRecord.requestId, playerIdempotency.requestId);
  assert.equal(inputRecord.inputRecordId, playerResult.inputRecordId);
  assert.equal(inputRecord.inputRecordId, playerPublication.inputRecordId);
  assert.equal(playerResult.playerPublicationId, playerPublication.publicationId);
  assert.equal(displayPlan.displayPlanId, playerResult.displayPlanId);
  assert.equal(displayPlan.displayPlanId, playerPublication.displayPlanId);
  assert.equal(playerMapping.publicationId, playerPublication.publicationId);
  assert.equal(playerMapping.gameSessionId, intermediate.gameSessionId);
  assert.equal(playerMapping.displayPlanId, displayPlan.displayPlanId);
  assert.equal(playerMapping.inputRecordId, inputRecord.inputRecordId);
  assert.equal(playerMapping.requestId, inputRecord.requestId);
  assert.equal(action.deliveryPublicationIds.filter((id) => id === playerPublication.publicationId).length, 1);

  assert.equal(plan.originatingInputRecordId, inputRecord.inputRecordId);
  assert.equal(npcIdempotency.originatingInputRecordId, inputRecord.inputRecordId);
  assert.equal(npcIdempotency.gameSessionId, intermediate.gameSessionId);
  assert.equal(npcPublication.originatingInputRecordId, inputRecord.inputRecordId);
  assert.equal(plan.causationId, playerResult.requestId);
  assert.equal(npcIdempotency.causationId, playerResult.requestId);
  assert.equal(npcResult.reactionPlanId, plan.reactionPlanId);
  assert.equal(npcIdempotency.reactionPlanId, plan.reactionPlanId);
  assert.equal(npcPublication.reactionPlanId, plan.reactionPlanId);
  assert.equal(npcResult.requestId, plan.requestId);
  assert.equal(npcIdempotency.requestId, plan.requestId);
  assert.equal(npcIdempotency.commitResultRequestId, plan.requestId);
  assert.equal(npcPublication.reactionCommitRequestId, plan.requestId);
  assert.equal(npcResult.npcPublicationId, npcPublication.publicationId);
  assert.equal(npcIdempotency.npcPublicationId, npcPublication.publicationId);
  assert.equal(action.result.structuredNpc.publicationId, npcPublication.publicationId);
  assert.equal(delivery.publicationId, npcPublication.publicationId);
  assert.notEqual(playerPublication.publicationId, npcPublication.publicationId);
  assert.notEqual(playerResult.requestId, npcResult.requestId);

  assert.ok(successfulRequest);
  assert.ok(successfulProjectionEvidence);
  assert.equal(successfulRequest.gameSessionId, intermediate.gameSessionId);
  assert.equal(successfulRequest.originatingInputRecordId, inputRecord.inputRecordId);
  assert.equal(successfulRequest.causationId, playerResult.requestId);
  assert.equal(successfulRequest.reactionPlanId, plan.reactionPlanId);
  assert.equal(successfulRequest.requestId, plan.requestId);
  assert.equal(successfulRequest.reactionAttemptId, plan.successfulAttemptId);
  assert.equal(npcIdempotency.successfulAttemptId, plan.successfulAttemptId);
  assert.equal(successfulRequest.turnId, intermediate.turnId);
  assert.equal(successfulRequest.turnOrder, intermediate.turnOrder);
  assert.equal(inputRecord.turnId, intermediate.turnId);
  assert.equal(acceptedSpeechAct.acceptedTurnId, intermediate.turnId);
  assert.equal(playerPublication.turnId, intermediate.turnId);
  assert.equal(playerMapping.turnId, intermediate.turnId);
  assert.equal(plan.turnId, intermediate.turnId);
  assert.equal(npcIdempotency.turnId, intermediate.turnId);
  assert.equal(npcIdempotency.turnOrder, intermediate.turnOrder);
  assert.equal(npcPublication.turnId, intermediate.turnId);

  const successObservations = observations.slice(observationStart);
  const routeObservations = successObservations.filter((event) => event.observationType === "npc_structured_reaction_route");
  assert.ok(routeObservations.length > 0);
  for (const event of routeObservations) {
    assert.equal(event.gameSessionId, intermediate.gameSessionId);
    assert.equal(event.triggerRequestId, playerResult.requestId);
    assert.equal(event.originatingInputRecordId, inputRecord.inputRecordId);
    assert.equal(event.reactionPlanId, plan.reactionPlanId);
    if (event.reactionAttemptId !== null) assert.equal(event.reactionAttemptId, plan.successfulAttemptId);
  }
  const routeAttemptIds = routeObservations.map((event) => event.reactionAttemptId).filter((value) => value !== null);
  assert.ok(routeAttemptIds.length > 0);
  assert.deepEqual(new Set(routeAttemptIds), new Set([plan.successfulAttemptId]));

  const controllerObservations = successObservations.filter((event) => typeof event.deliveryAttemptId === "string");
  const orchestratorObservations = successObservations.filter((event) => event.eventType === "npc_publication_delivery_orchestration");
  assert.ok(controllerObservations.length > 0);
  assert.ok(orchestratorObservations.length > 0);
  for (const event of [...controllerObservations, ...orchestratorObservations]) {
    assert.equal(event.gameSessionId, intermediate.gameSessionId);
    assert.equal(event.publicationId, npcPublication.publicationId);
  }
  const controllerAttemptIds = new Set(controllerObservations.map((event) => event.deliveryAttemptId));
  const orchestratorDeliveryIds = new Set(orchestratorObservations.map((event) => event.deliveryId).filter((value) => value !== null));
  assert.equal(controllerAttemptIds.size, 1);
  assert.deepEqual(orchestratorDeliveryIds, controllerAttemptIds);

  const playerDeliveryEntries = [...bookkeeping.values()]
    .filter((entry) => entry.identity?.publicationId === playerPublication.publicationId);
  assert.equal(playerDeliveryEntries.length, 1);
  const [{ identity: playerDeliveryIdentity }] = playerDeliveryEntries;
  assert.equal(playerDeliveryIdentity.gameSessionId, intermediate.gameSessionId);
  assert.equal(playerDeliveryIdentity.publicationId, playerPublication.publicationId);
  assert.equal(typeof playerDeliveryIdentity.deliveryAttemptId, "string");
  assert.ok(playerDeliveryIdentity.deliveryAttemptId.length > 0);
  assert.equal(typeof playerDeliveryIdentity.receiptId, "string");
  assert.ok(playerDeliveryIdentity.receiptId.length > 0);

  assert.equal(Object.isFrozen(action.result.structuredNpc), true);
  assert.equal(Object.isFrozen(delivery), true);
  for (const publicValue of [action, delivery, game.getPublicSnapshot(), observations]) {
    assertPrivacySafe(publicValue, Object.values(failureEvidence.markers));
    assertPrivateProjectionAbsent(publicValue, failedProjectionEvidence);
    assertPrivateProjectionAbsent(publicValue, successfulProjectionEvidence);
  }
  assert.equal(counters.candidate, 2);
  assert.equal(counters.legacy, 0);
  assert.equal(counters.playerWrites, 2);
  assert.equal(counters.npcWrites, 1);
  game.destroy();
});

function assertConversationAppendOnlyDeltas(before, after) {
  const expectedDeltas = {
    inputRecords: 1,
    acceptedSpeechActs: 1,
    claims: 0,
    events: 2,
    displayPlans: 1,
    reactionPlans: 1,
    publications: 2,
    playerLegacyDisplayCompatibilityRecords: 1,
    commitResults: 2,
    idempotencyRecords: 1,
    npcReactionCommitIdempotencyRecords: 1
  };
  return Object.fromEntries(Object.entries(expectedDeltas).map(([registry, delta]) => {
    assert.equal(after[registry].length, before[registry].length + delta, `${registry} exact delta`);
    assert.deepEqual(after[registry].slice(0, before[registry].length), before[registry], `${registry} append-only prefix`);
    return [registry, after[registry].slice(before[registry].length)];
  }));
}

function assertConversationRegistryIdentityUniqueness(conversation) {
  const identities = [
    ["inputRecords", "inputRecordId"],
    ["inputRecords", "requestId"],
    ["acceptedSpeechActs", "speechActId"],
    ["claims", "claimId"],
    ["events", "eventId"],
    ["displayPlans", "displayPlanId"],
    ["reactionPlans", "reactionPlanId"],
    ["reactionPlans", "requestId"],
    ["reactionPlans", "successfulAttemptId"],
    ["publications", "publicationId"],
    ["playerLegacyDisplayCompatibilityRecords", "compatibilityMappingId"],
    ["commitResults", "requestId"],
    ["idempotencyRecords", "requestId"],
    ["npcReactionCommitIdempotencyRecords", "reactionPlanId"],
    ["npcReactionCommitIdempotencyRecords", "requestId"],
    ["npcReactionCommitIdempotencyRecords", "successfulAttemptId"]
  ];
  for (const [registry, field] of identities) {
    const values = conversation[registry].map((entry) => entry[field]);
    for (const value of values) {
      assert.equal(typeof value, "string", `${registry}.${field}`);
      assert.ok(value.length > 0, `${registry}.${field}`);
    }
    assert.equal(new Set(values).size, values.length, `${registry}.${field} must be unique`);
  }
  const playerRequestIds = new Set(conversation.idempotencyRecords.map((entry) => entry.requestId));
  for (const record of conversation.npcReactionCommitIdempotencyRecords) {
    assert.equal(playerRequestIds.has(record.requestId), false, "Player and NPC request IDs must be disjoint");
  }
}

function scheduleInMicrotask(callback, delayMs) {
  const handle = { callback, delayMs, cancelled: false };
  queueMicrotask(() => { if (!handle.cancelled) callback(); });
  return handle;
}
