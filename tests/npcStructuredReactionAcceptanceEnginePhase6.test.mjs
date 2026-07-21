import assert from "node:assert/strict";
import test from "node:test";

import { createPseudoNpcReactionCandidateInvoker } from "../src/npcReactionCandidateUpstream.mjs";
import { consumeLiveActionDisplay } from "../src/playerDisplaySink.mjs";
import {
  assertPrivacySafe,
  assertSafeMonotonicIdentityState,
  authoritativeSnapshot,
  completePlayerAndNpc,
  createAcceptanceGame,
  createDeferred,
  createDeliveryAcceptanceGame,
  createFailingNpcDom
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
    assertSafeMonotonicIdentityState(game.state);
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
  const results = [integrationResult("retry_required", "acceptance-retry"), integrationResult("acknowledged_existing")];
  let executeCalls = 0;
  let pumpCalls = 0;
  const { game } = createAcceptanceGame({
    createNpcStructuredProductionIntegration: () => Object.freeze({
      async executeNpcReaction() { executeCalls += 1; return integrationResult("pending_player_display", null, "committed"); },
      async pumpNpcPublicationAfterPlayerDisplay() { return results[pumpCalls++]; },
      reset() {}
    })
  });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Ack only?" });
  await consumeLiveActionDisplay({
    game, action, consumerId: "acceptance-player", sinkType: "cli", bookkeeping: new Map(),
    writeStructured: async () => {}, writeLegacy: async () => {}
  });
  const input = { schemaVersion: 1, gameSessionId: game.state.gameSessionId, playerPublicationId: action.result.conversationCommitResult.playerPublicationId };
  assert.equal((await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input)).deliveryStatus, "retry_required");
  assert.equal((await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input)).deliveryStatus, "acknowledged_existing");
  assert.equal(executeCalls, 1);
  assert.equal(pumpCalls, 2);
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
  const { game } = createAcceptanceGame({ counters });
  for (const [targetId, input] of [["npc3", "Question one?"], ["npc1", "Question two?"]]) {
    const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId, input });
    await completePlayerAndNpc(game, action, { counters });
  }
  const candidateBeforeProgression = counters.candidate;
  const vote = await game.dispatchPlayerAction({ type: "advance_vote" });
  assert.ok(vote.result.executedId);
  const deadId = vote.result.executedId;
  const deadVersion = game.state.stateVersion;
  const deadQuestion = await game.dispatchPlayerAction({ type: "ask_npc", targetId: deadId, input: "Can you answer?" });
  assert.equal(deadQuestion.result.responded, false);
  assert.equal(counters.candidate, candidateBeforeProgression);
  assert.equal(game.state.stateVersion, deadVersion);
  const night = await game.dispatchPlayerAction({ type: "run_night" });
  assert.equal(night.ok, true);
  assert.equal(counters.candidate, candidateBeforeProgression);
  const aliveTarget = game.getPublicSnapshot().players.find((player) => player.alive && player.id.startsWith("npc"))?.id;
  assert.ok(aliveTarget);
  const third = await game.dispatchPlayerAction({ type: "ask_npc", targetId: aliveTarget, input: "Final suspicion?" });
  await completePlayerAndNpc(game, third, { counters });
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
  assertSafeMonotonicIdentityState(game.state);
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
  const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
  const { game } = createAcceptanceGame({ counters });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Audit?" });
  const { delivery } = await completePlayerAndNpc(game, action, { counters });
  assertSafeMonotonicIdentityState(game.state);
  assert.equal(Object.isFrozen(action.result.structuredNpc), true);
  assert.equal(Object.isFrozen(delivery), true);
  assertPrivacySafe(action);
  assertPrivacySafe(delivery);
  assertPrivacySafe(game.getPublicSnapshot());
  assert.equal(counters.candidate, 1);
  assert.equal(counters.legacy, 0);
  assert.equal(counters.playerWrites, 1);
  assert.equal(counters.npcWrites, 1);
  game.destroy();
});

function integrationResult(deliveryStatus, retryId = null, routeStatus = "committed") {
  return Object.freeze({
    schemaVersion: 1,
    resultType: "npc_structured_production_integration",
    enabled: true,
    routeStatus,
    deliveryStatus,
    publicationId: null,
    retryId,
    errorCode: null,
    legacyUsed: false,
    legacySuppressed: true
  });
}

function scheduleInMicrotask(callback, delayMs) {
  const handle = { callback, delayMs, cancelled: false };
  queueMicrotask(() => { if (!handle.cancelled) callback(); });
  return handle;
}
