import assert from "node:assert/strict";
import test from "node:test";

import { TEAMS } from "../src/constants.mjs";
import { WerewolfGame } from "../src/gameEngine.mjs";

const FEATURE_MATRIX = Object.freeze([
  Object.freeze({
    name: "all structured features disabled",
    interpreterValidationEnabled: false,
    playerConversationCommitEnabled: false,
    playerStructuredConsumerEnabled: false,
    npcStructuredReactionEnabled: false
  }),
  Object.freeze({
    name: "player commit enabled with legacy Player consumer",
    interpreterValidationEnabled: true,
    playerConversationCommitEnabled: true,
    playerStructuredConsumerEnabled: false,
    npcStructuredReactionEnabled: false
  }),
  Object.freeze({
    name: "NPC Structured Route enabled with legacy Player consumer",
    interpreterValidationEnabled: true,
    playerConversationCommitEnabled: true,
    playerStructuredConsumerEnabled: false,
    npcStructuredReactionEnabled: true
  }),
  Object.freeze({
    name: "NPC Structured Route and structured Player consumer enabled",
    interpreterValidationEnabled: true,
    playerConversationCommitEnabled: true,
    playerStructuredConsumerEnabled: true,
    npcStructuredReactionEnabled: true
  })
]);

test("PW-001 winner advance_vote is a complete authoritative no-op", async () => {
  const fixture = terminalGame();
  const { game, counters } = fixture;
  const before = authoritativeSnapshot(game);
  const baseline = counterSnapshot(counters);
  const originalWorkingCopy = game._workingCopy.bind(game);
  const originalExecute = game._executeCompatibilityAction.bind(game);
  const originalRunVote = game.runVote.bind(game);
  game._workingCopy = (...args) => {
    counters.workingCopy += 1;
    return originalWorkingCopy(...args);
  };
  game._executeCompatibilityAction = async (...args) => {
    counters.compatibilityExecution += 1;
    return originalExecute(...args);
  };
  game.runVote = (...args) => {
    counters.runVote += 1;
    return originalRunVote(...args);
  };

  const action = await game.dispatchPlayerAction({
    type: "advance_vote",
    logCursor: game.state.playerLog.length
  });

  assert.equal(action.ok, true);
  assert.equal(action.actionType, "advance_vote");
  assert.equal(action.result, null);
  assert.deepEqual(authoritativeSnapshot(game), before);
  assert.equal(game.state.stateVersion, before.stateVersion);
  assert.equal(game.state.turnOrder, before.turnOrder);
  assert.equal(game.state.turnId, before.turnId);
  assert.deepEqual(counterDelta(counters, baseline), zeroCounterDelta());
  assert.equal(game._commandInProgress, false);
});

test("PW-002 repeated winner advance_vote calls remain exact no-ops", async () => {
  const { game, counters } = terminalGame();
  const before = authoritativeSnapshot(game);
  const baseline = counterSnapshot(counters);

  for (let iteration = 0; iteration < 10; iteration += 1) {
    const action = await game.dispatchPlayerAction({ type: "advance_vote" });
    assert.equal(action.result, null);
    assert.deepEqual(authoritativeSnapshot(game), before);
  }

  assert.deepEqual(counterDelta(counters, baseline), zeroCounterDelta());
  assert.equal(game._commandInProgress, false);
});

test("PW-003 concurrent terminal commands do not acquire the mutation lock", async () => {
  const { game, counters } = terminalGame();
  const before = authoritativeSnapshot(game);
  const baseline = counterSnapshot(counters);

  const sameTurn = await Promise.all([
    game.dispatchPlayerAction({ type: "advance_vote" }),
    game.dispatchPlayerAction({ type: "advance_vote" })
  ]);
  assert.deepEqual(sameTurn.map(({ result }) => result), [null, null]);
  assert.deepEqual(authoritativeSnapshot(game), before);

  const [voteWithRead, read] = await Promise.all([
    game.dispatchPlayerAction({ type: "advance_vote" }),
    game.dispatchPlayerAction({ type: "get_state" })
  ]);
  assert.equal(voteWithRead.result, null);
  assert.equal(read.result, null);
  assert.deepEqual(authoritativeSnapshot(game), before);

  const [voteWithNight, night] = await Promise.all([
    game.dispatchPlayerAction({ type: "advance_vote" }),
    game.dispatchPlayerAction({ type: "run_night" })
  ]);
  assert.equal(voteWithNight.result, null);
  assert.deepEqual(night.result, {
    skipped: true,
    reason: "game_already_finished"
  });
  assert.deepEqual(authoritativeSnapshot(game), before);
  assert.deepEqual(counterDelta(counters, baseline), zeroCounterDelta());
  assert.equal(game._commandInProgress, false);
});

test("PW-004 winner advance_vote is a no-op across the exact feature matrix", async () => {
  for (const matrix of FEATURE_MATRIX) {
    const { game, counters } = terminalGame(matrix);
    const before = authoritativeSnapshot(game);
    const baseline = counterSnapshot(counters);

    const action = await game.dispatchPlayerAction({
      type: "advance_vote",
      logCursor: game.state.playerLog.length
    });

    assert.equal(action.result, null, matrix.name);
    assert.deepEqual(authoritativeSnapshot(game), before, matrix.name);
    assert.deepEqual(counterDelta(counters, baseline), zeroCounterDelta(), matrix.name);
    assert.deepEqual(action.playerLogEntries, [], matrix.name);
    assert.deepEqual(action.structuredPlayerEntries, [], matrix.name);
    assert.deepEqual(action.livePlayerDisplayEntries, [], matrix.name);
    assert.deepEqual(action.deliveryPublicationIds, [], matrix.name);
  }
});

test("PW-005 other winner commands preserve their public contracts and state", async () => {
  const { game, counters } = terminalGame(FEATURE_MATRIX.at(-1));
  const before = authoritativeSnapshot(game);
  const baseline = counterSnapshot(counters);

  const ask = await game.dispatchPlayerAction({
    type: "ask_npc",
    targetId: "npc1",
    input: "Who do you suspect?"
  });
  assert.deepEqual(ask.result, {
    responded: false,
    reason: "game_already_finished"
  });
  assert.deepEqual(authoritativeSnapshot(game), before);

  const night = await game.dispatchPlayerAction({ type: "run_night" });
  assert.deepEqual(night.result, {
    skipped: true,
    reason: "game_already_finished"
  });
  assert.deepEqual(authoritativeSnapshot(game), before);

  const state = await game.dispatchPlayerAction({ type: "get_state" });
  assert.equal(state.result, null);
  assert.deepEqual(authoritativeSnapshot(game), before);
  assert.deepEqual(counterDelta(counters, baseline), zeroCounterDelta());
});

test("PW-006 unknown commands preserve the existing error and authoritative state", async () => {
  const { game, counters } = terminalGame();
  const before = authoritativeSnapshot(game);
  const baseline = counterSnapshot(counters);

  await assert.rejects(
    () => game.dispatchPlayerAction({ type: "unknown_action" }),
    /Unknown player action type: unknown_action/
  );

  assert.deepEqual(authoritativeSnapshot(game), before);
  assert.deepEqual(counterDelta(counters, baseline), zeroCounterDelta());
});

test("PW-007 normal pre-winner advance_vote retains its mutation contract", async () => {
  const { game, counters } = createGame();
  assert.equal(game.state.winner, null);
  const before = authoritativeSnapshot(game);
  const baseline = counterSnapshot(counters);

  const action = await game.dispatchPlayerAction({ type: "advance_vote" });

  assert.equal(action.ok, true);
  assert.ok(action.result?.executedId);
  assert.equal(game.state.stateVersion, before.stateVersion + 1);
  assert.equal(game.state.turnOrder, before.turnOrder + 1);
  assert.notEqual(game.state.turnId, before.turnId);
  assert.equal(counters.createId - baseline.createId, 1);
  assert.equal(game.state.voteHistory.length, before.voteHistory.length + 1);
});

test("PW-008 terminal no-op returns an empty live projection at the current cursor", async () => {
  const { game, counters } = terminalGame(FEATURE_MATRIX.at(-1));
  assert.equal(game.state.conversation.publications.length, 0);
  const before = authoritativeSnapshot(game);
  const baseline = counterSnapshot(counters);
  const logCursor = game.state.playerLog.length;

  const action = await game.dispatchPlayerAction({
    type: "advance_vote",
    logCursor
  });

  assert.equal(action.ok, true);
  assert.equal(action.actionType, "advance_vote");
  assert.equal(action.result, null);
  assert.equal(action.nextLogCursor, logCursor);
  assert.deepEqual(action.playerLogEntries, []);
  assert.deepEqual(action.structuredPlayerEntries, []);
  assert.deepEqual(action.livePlayerDisplayEntries, []);
  assert.deepEqual(action.deliveryPublicationIds, []);
  assert.deepEqual(action.publicSnapshot, game.getPublicSnapshot());
  assert.deepEqual(authoritativeSnapshot(game), before);
  assert.deepEqual(counterDelta(counters, baseline), zeroCounterDelta());
});

test("PW-011 an invalid internal command decision fails closed before mutation", async () => {
  const { game, counters } = createGame();
  const before = authoritativeSnapshot(game);
  const baseline = counterSnapshot(counters);
  game._validateCommand = () => ({ disposition: "unknown" });

  await assert.rejects(
    () => game.dispatchPlayerAction({ type: "advance_vote" }),
    (error) => error?.code === "invalid_command_decision"
      && error.message === "invalid_command_decision"
  );

  assert.deepEqual(authoritativeSnapshot(game), before);
  assert.deepEqual(counterDelta(counters, baseline), zeroCounterDelta());
  assert.equal(game._commandInProgress, false);
});

function terminalGame(options = {}) {
  const fixture = createGame(options);
  fixture.game.killPlayer("npc3", "test");
  assert.equal(fixture.game.checkWin("test"), TEAMS.VILLAGE);
  assert.equal(fixture.game.state.winner, TEAMS.VILLAGE);
  assert.equal(fixture.game.state.conversation.publications.length, 0);
  return fixture;
}

function createGame(options = {}) {
  const counters = {
    createId: 0,
    interpreter: 0,
    provider: 0,
    structuredExecute: 0,
    structuredPump: 0,
    structuredReset: 0,
    playerObserver: 0,
    workingCopy: 0,
    compatibilityExecution: 0,
    runVote: 0
  };
  const createId = () => `post-winner-${++counters.createId}`;
  const game = WerewolfGame.create({
    seed: 20260613,
    scenario: "sample",
    shuffleRoles: false,
    createId,
    interpreterValidationEnabled: options.interpreterValidationEnabled === true,
    playerConversationCommitEnabled: options.playerConversationCommitEnabled === true,
    playerStructuredConsumerEnabled: options.playerStructuredConsumerEnabled === true,
    npcStructuredReactionEnabled: options.npcStructuredReactionEnabled === true,
    interpreterProvider: {
      async interpretPlayerInput() {
        counters.interpreter += 1;
        throw new Error("terminal command must not invoke the Interpreter");
      }
    },
    responseProvider: {
      async generateResponse() {
        counters.provider += 1;
        throw new Error("terminal command must not invoke the Provider");
      }
    },
    playerStructuredConsumerObserver: () => {
      counters.playerObserver += 1;
    },
    createNpcStructuredProductionIntegration: options.npcStructuredReactionEnabled === true
      ? () => Object.freeze({
          async executeNpcReaction() {
            counters.structuredExecute += 1;
            throw new Error("terminal command must not invoke Structured Route");
          },
          async pumpNpcPublicationAfterPlayerDisplay() {
            counters.structuredPump += 1;
            throw new Error("terminal command must not invoke Delivery");
          },
          reset() {
            counters.structuredReset += 1;
          }
        })
      : undefined
  });
  return { game, counters };
}

function authoritativeSnapshot(game) {
  return structuredClone(game.state);
}

function counterSnapshot(counters) {
  return structuredClone(counters);
}

function counterDelta(counters, baseline) {
  return Object.fromEntries(
    Object.keys(baseline).map((key) => [key, counters[key] - baseline[key]])
  );
}

function zeroCounterDelta() {
  return {
    createId: 0,
    interpreter: 0,
    provider: 0,
    structuredExecute: 0,
    structuredPump: 0,
    structuredReset: 0,
    playerObserver: 0,
    workingCopy: 0,
    compatibilityExecution: 0,
    runVote: 0
  };
}
