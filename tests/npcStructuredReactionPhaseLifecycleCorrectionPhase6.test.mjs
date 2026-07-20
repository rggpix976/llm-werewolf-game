import assert from "node:assert/strict";
import test from "node:test";

import { createPseudoNpcReactionCandidateInvoker } from "../src/npcReactionCandidateUpstream.mjs";
import { askAndComplete, createLifecycleGame } from "./helpers/npcStructuredReactionLifecycleCorrectionHarness.mjs";

test("RC-001 consecutive structured questions return to the stable phase without legacy fallback", async () => {
  const counters = { candidate: 0, legacy: 0 };
  const { game } = createLifecycleGame({ counters });

  const first = await askAndComplete(game, "Who do you suspect first?");
  const firstFinalPhase = game.state.phase;
  assert.equal(first.result.structuredNpc.routeStatus, "committed");

  const second = await askAndComplete(game, "Who do you suspect next?");
  assert.equal(counters.legacy, 0);
  assert.equal(counters.candidate, 2);
  assert.equal(firstFinalPhase, "day_discussion");
  assert.equal(second.result.structuredNpc.routeStatus, "committed");
  assert.equal(game.state.phase, "day_discussion");
  assert.equal(game.state.conversation.reactionPlans.length, 2);
});

test("RC-002 successful lifecycle exposes only the in-flight player_question phase", async () => {
  let release;
  let started;
  const pending = new Promise((resolve) => { release = resolve; });
  const invoked = new Promise((resolve) => { started = resolve; });
  const pseudo = createPseudoNpcReactionCandidateInvoker();
  const { game } = createLifecycleGame({
    invokeProvider: async (request, options) => {
      started();
      await pending;
      return pseudo(request, options);
    }
  });
  const initialVersion = game.state.stateVersion;
  const dispatch = game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Who do you suspect?" });
  await invoked;
  assert.equal(game.state.phase, "player_question");
  assert.equal(game.state.stateVersion, initialVersion + 1);
  assert.equal(game.state.conversation.reactionPlans.length, 0);
  release();
  const action = await dispatch;
  assert.equal(action.result.structuredNpc.routeStatus, "committed");
  assert.equal(game.state.phase, "day_discussion");
  assert.equal(game.state.stateVersion, initialVersion + 2);
});

test("RC-003 successful NPC commit closes phase with its one atomic graph version", async () => {
  const { game } = createLifecycleGame();
  const gameplay = gameplaySnapshot(game.state);
  const action = await game.dispatchPlayerAction({
    type: "ask_npc",
    targetId: "npc1",
    input: "Who do you suspect?"
  });
  const plan = game.state.conversation.reactionPlans[0];
  const input = game.state.conversation.inputRecords.find((entry) =>
    entry.inputRecordId === action.result.conversationCommitResult.inputRecordId);
  assert.equal(plan.preconditionStateVersion, 1);
  assert.equal(plan.resultingStateVersion, 2);
  assert.equal(input.capturedStateVersion, 0);
  assert.equal(game.state.phase, "day_discussion");
  assert.equal(game.state.stateVersion, 2);
  assert.equal(game.state.conversation.reactionPlans.length, 1);
  assert.equal(game.state.developerLog.filter((entry) => entry.kind === "phase_change").length, 1);
  assert.equal(game.state.developerLog.some((entry) =>
    entry.kind === "phase_change" && entry.detail?.phase === "day_discussion"), false);
  assert.deepEqual(gameplaySnapshot(game.state), gameplay);
});

test("RC-004 consecutive questions work with the Player structured consumer off and on", async () => {
  for (const playerStructuredConsumerEnabled of [false, true]) {
    const counters = { candidate: 0, legacy: 0 };
    const { game } = createLifecycleGame({ counters, playerStructuredConsumerEnabled });
    await askAndComplete(game, "Question A?");
    assert.equal(game.state.phase, "day_discussion");
    await askAndComplete(game, "Question B?");
    assert.equal(game.state.phase, "day_discussion");
    assert.equal(counters.candidate, 2);
    assert.equal(counters.legacy, 0);
    assert.equal(game.state.conversation.reactionPlans.length, 2);
    assert.equal(game.state.conversation.commitResults.filter((entry) => entry.commitType === "player_conversation").length, 2);
  }
});

test("RC-009 terminal Provider exhaustion retains Player commit and settles the lifecycle", async () => {
  const counters = { candidate: 0, legacy: 0 };
  const { game } = createLifecycleGame({
    counters,
    invokeProvider: async () => {
      counters.candidate += 1;
      const error = new Error("private upstream detail");
      error.code = "provider_unavailable";
      throw error;
    }
  });
  const failed = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "First?" });
  assert.notEqual(failed.result.structuredNpc.routeStatus, "committed");
  assert.equal(game.state.phase, "day_discussion");
  assert.equal(game.state.stateVersion, 2);
  assert.equal(game.state.conversation.commitResults.filter((entry) => entry.commitType === "player_conversation").length, 1);
  assert.equal(game.state.conversation.reactionPlans.length, 0);
  assert.equal(counters.legacy, 0);
  assert.equal(JSON.stringify(failed).includes("private upstream detail"), false);
});

test("RC-010 invalid candidate settles without NPC graph and permits the next valid question", async () => {
  let invocation = 0;
  const pseudo = createPseudoNpcReactionCandidateInvoker();
  const counters = { candidate: 0, legacy: 0 };
  const { game } = createLifecycleGame({
    counters,
    invokeProvider: async (request, options) => {
      counters.candidate += 1;
      invocation += 1;
      const result = await pseudo(request, options);
      if (invocation === 1) return { ...result, candidate: { schemaVersion: 1, proposals: [{ proposalType: "decline" }] } };
      return result;
    }
  });
  const first = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "First?" });
  assert.equal(first.result.structuredNpc.routeStatus, "rejected");
  assert.equal(game.state.phase, "day_discussion");
  assert.equal(game.state.stateVersion, 2);
  assert.equal(game.state.conversation.reactionPlans.length, 0);
  const second = await askAndComplete(game, "Second?");
  assert.equal(second.result.structuredNpc.routeStatus, "committed");
  assert.equal(game.state.phase, "day_discussion");
  assert.equal(game.state.stateVersion, 4);
  assert.equal(counters.legacy, 0);
});

test("RC-011 stale settlement owner never overwrites intervening authority", async (t) => {
  const cases = [
    ["session", (game) => { game.state.gameSessionId = "other-session"; }],
    ["turn", (game) => { game.state.turnId = "other-turn"; }],
    ["turn order", (game) => { game.state.turnOrder += 1; }],
    ["version", (game) => { game.state.stateVersion += 1; }],
    ["phase", (game) => { game.state.phase = "night"; }],
    ["same-version root", (game) => { game.state.day += 1; }],
    ["destroy", (game) => { game.destroy(); }]
  ];
  for (const [name, intervene] of cases) await t.test(name, async () => {
    let game;
    let interveningState;
    const integration = () => Object.freeze({
      async executeNpcReaction() { return Object.freeze({ routeStatus: "route_failed" }); },
      async pumpNpcPublicationAfterPlayerDisplay() { return Object.freeze({ deliveryStatus: "pending_none" }); },
      reset() {}
    });
    ({ game } = createLifecycleGame({
      createNpcStructuredProductionIntegration: integration,
      npcAuthorityFaultInjector(stage) {
        if (stage === "lifecycle_settlement_before_final_replacement") {
          intervene(game);
          interveningState = authoritativeComparable(game.state);
        }
      }
    }));
    let result;
    let publicError;
    try { result = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Question?" }); }
    catch (error) { publicError = error; }
    if (["session", "destroy"].includes(name)) assert.ok(publicError);
    else assert.equal(result.result.structuredNpc.routeStatus, "route_failed");
    assert.deepEqual(authoritativeComparable(game.state), interveningState);
    assert.equal(game.state.conversation.reactionPlans.length, 0);
  });
});

test("terminal integration throw keeps its identity after a successful lifecycle settlement", async () => {
  const original = Object.assign(new Error("private integration failure"), { code: "integration_invariant" });
  const integration = () => Object.freeze({
    async executeNpcReaction() { throw original; },
    async pumpNpcPublicationAfterPlayerDisplay() { return Object.freeze({ deliveryStatus: "pending_none" }); },
    reset() {}
  });
  const { game } = createLifecycleGame({ createNpcStructuredProductionIntegration: integration });
  await assert.rejects(
    () => game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Question?" }),
    (error) => error === original
  );
  assert.equal(game.state.phase, "day_discussion");
  assert.equal(game.state.stateVersion, 2);
  assert.equal(game.state.conversation.reactionPlans.length, 0);
});

test("RC-015 live phase closes before Delivery while the handoff gate still blocks mutation", async () => {
  const { game } = createLifecycleGame();
  const first = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "First?" });
  assert.equal(first.result.structuredNpc.deliveryStatus, "pending_player_display");
  assert.equal(game.state.phase, "day_discussion");
  const before = authoritativeComparable(game.state);
  await assert.rejects(
    () => game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Blocked?" }),
    (error) => error.code === "input_in_progress"
  );
  assert.deepEqual(authoritativeComparable(game.state), before);
  await askAndCompletePending(game, first);
  const second = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Allowed?" });
  assert.equal(second.result.structuredNpc.routeStatus, "committed");
});

async function askAndCompletePending(game, action) {
  const { consumeLiveActionDisplay } = await import("../src/playerDisplaySink.mjs");
  await consumeLiveActionDisplay({
    game,
    action,
    consumerId: "player-consumer",
    sinkType: "cli",
    bookkeeping: new Map(),
    writeStructured: async () => {},
    writeLegacy: async () => {}
  });
  await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId: action.result.conversationCommitResult.playerPublicationId
  });
}

function gameplaySnapshot(state) {
  return structuredClone({
    gameSessionId: state.gameSessionId,
    day: state.day,
    alivePlayers: state.alivePlayers,
    deadPlayers: state.deadPlayers,
    voteHistory: state.voteHistory,
    winner: state.winner,
    config: state.config,
    rngState: state.rng.state
  });
}

function authoritativeComparable(state) {
  const { rng, ...plain } = state;
  return structuredClone({ ...plain, rngState: rng.state });
}
