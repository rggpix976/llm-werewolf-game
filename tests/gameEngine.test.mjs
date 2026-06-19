import assert from "node:assert/strict";
import test from "node:test";

import { ROLES, TEAMS } from "../src/constants.mjs";
import { WerewolfGame } from "../src/gameEngine.mjs";

function createSampleGame() {
  return WerewolfGame.create({
    seed: 20260613,
    scenario: "sample",
    shuffleRoles: false
  });
}

function collectObjectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectObjectKeys(item, keys);
    }
    return keys;
  }

  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectObjectKeys(child, keys);
    }
  }

  return keys;
}

test("initializes a five-player village with the expected role counts", () => {
  const game = createSampleGame();
  const roleCounts = game.state.players.reduce((counts, player) => {
    counts[player.role] = (counts[player.role] ?? 0) + 1;
    return counts;
  }, {});

  assert.equal(game.state.players.length, 5);
  assert.equal(roleCounts[ROLES.WEREWOLF], 1);
  assert.equal(roleCounts[ROLES.SEER], 1);
  assert.equal(roleCounts[ROLES.CITIZEN], 3);
  assert.equal(game.state.alivePlayers.length, 5);
  assert.deepEqual(game.state.deadPlayers, []);
  assert.equal(game.state.winner, null);
});

test("dispatchPlayerAction returns a public snapshot and incremental player logs", () => {
  const game = createSampleGame();
  const logCursor = game.state.playerLog.length;

  const action = game.dispatchPlayerAction({
    type: "ask_npc",
    target: "npc2",
    input: "What do you think?",
    logCursor
  });

  assert.equal(action.ok, true);
  assert.equal(action.actionType, "ask_npc");
  assert.equal(action.result.responded, true);
  assert.equal(action.playerLogEntries.length, 2);
  assert.equal(action.nextLogCursor, logCursor + 2);
  assert.equal(action.publicSnapshot.phase, "npc_response");
  assert.equal(action.publicSnapshot.playerLog.length, action.nextLogCursor);
});

test("public snapshots do not expose private player state", () => {
  const game = createSampleGame();
  const snapshot = game.getPublicSnapshot();
  const keys = collectObjectKeys(snapshot);
  const forbiddenKeys = [
    "role",
    "team",
    "knownInfo",
    "hiddenInfo",
    "suspicionScores",
    "privateMemory",
    "conversationPolicy",
    "reasonDeveloper",
    "developerLog"
  ];

  for (const key of forbiddenKeys) {
    assert.equal(keys.has(key), false, `public snapshot exposed ${key}`);
  }
});

test("living NPCs respond while dead NPCs are blocked", () => {
  const game = createSampleGame();
  const livingResponse = game.dispatchPlayerAction({
    type: "ask_npc",
    target: "npc2",
    input: "Are you alive?"
  });

  assert.equal(livingResponse.result.responded, true);

  const vote = game.dispatchPlayerAction({ type: "advance_vote" });
  const executedId = vote.result.executedId;
  const responseLogCount = game.state.developerLog.filter(
    (entry) => entry.kind === "npc_response_generated" && entry.detail.npcId === executedId
  ).length;

  const deadResponse = game.dispatchPlayerAction({
    type: "ask_npc",
    target: executedId,
    input: "Can you still speak?"
  });

  assert.deepEqual(deadResponse.result, {
    responded: false,
    reason: "dead_npc"
  });
  assert.equal(
    game.state.developerLog.filter(
      (entry) => entry.kind === "npc_response_generated" && entry.detail.npcId === executedId
    ).length,
    responseLogCount
  );
  assert.equal(
    game.state.developerLog.some(
      (entry) => entry.kind === "dead_npc_blocked" && entry.detail.targetId === executedId
    ),
    true
  );
});

test("werewolf identity questions are denied and response evidence is logged", () => {
  const game = createSampleGame();
  const action = game.dispatchPlayerAction({
    type: "ask_npc",
    target: "npc3",
    input: "Are you a werewolf?"
  });
  const responseLog = game.state.developerLog.find(
    (entry) => entry.kind === "npc_response_generated" && entry.detail.npcId === "npc3"
  );

  assert.equal(action.result.responded, true);
  assert.equal(action.result.disclosedHiddenInfo, false);
  assert.equal(
    action.result.evidenceUsed.includes("conversationPolicy: werewolf denies identity and redirects"),
    true
  );
  assert.ok(responseLog);
  assert.deepEqual(responseLog.detail.evidenceUsed, action.result.evidenceUsed);
  assert.match(responseLog.detail.promptPreview, /never confess/i);
});

test("votes target living opponents and execution updates life state", () => {
  const game = createSampleGame();
  const aliveBeforeVote = new Set(game.state.alivePlayers);
  const action = game.dispatchPlayerAction({ type: "advance_vote" });
  const { votes, executedId } = action.result;

  assert.equal(votes.length, aliveBeforeVote.size);
  for (const vote of votes) {
    assert.equal(aliveBeforeVote.has(vote.voterId), true);
    assert.equal(aliveBeforeVote.has(vote.targetId), true);
    assert.notEqual(vote.voterId, vote.targetId);
  }

  assert.equal(game.getPlayer(executedId).alive, false);
  assert.equal(game.state.alivePlayers.includes(executedId), false);
  assert.equal(game.state.deadPlayers.includes(executedId), true);
  assert.equal(game.state.voteHistory.at(-1).executedId, executedId);
});

test("seer results remain private until the seer explicitly claims", () => {
  const game = createSampleGame();

  game.dispatchPlayerAction({ type: "advance_vote" });
  const night = game.dispatchPlayerAction({ type: "run_night" });
  const seer = game.state.players.find((player) => player.role === ROLES.SEER);
  const privateResult = seer.knownInfo.find((info) => info.type === "seer_result");

  assert.ok(night.result.seerResult);
  assert.ok(privateResult);
  assert.equal(privateResult.visibility, "private");
  assert.equal(privateResult.shareable, false);
  assert.equal(
    game.state.publicInfo.some(
      (info) => info.type === "seer_action" || info.type === "public_claim"
    ),
    false
  );

  const claim = game.dispatchPlayerAction({
    type: "ask_npc",
    target: seer.id,
    input: "占い師ならCOしてください"
  });

  assert.equal(claim.result.responded, true);
  assert.equal(claim.result.publicClaim?.role, ROLES.SEER);
  assert.equal(seer.publicClaims.length, 1);
  assert.equal(
    game.state.publicInfo.some(
      (info) => info.type === "public_claim" && info.actorId === seer.id
    ),
    true
  );
});

test("werewolf attacks only a living non-werewolf target", () => {
  const game = createSampleGame();

  game.dispatchPlayerAction({ type: "advance_vote" });
  const aliveBeforeNight = new Set(game.state.alivePlayers);
  const werewolf = game.state.players.find((player) => player.role === ROLES.WEREWOLF);
  const night = game.dispatchPlayerAction({ type: "run_night" });
  const attack = night.result.attackResult;

  assert.ok(attack);
  assert.equal(attack.werewolfId, werewolf.id);
  assert.notEqual(attack.targetId, werewolf.id);
  assert.equal(aliveBeforeNight.has(attack.targetId), true);
  assert.equal(game.getPlayer(attack.targetId).alive, false);
  assert.equal(game.state.deadPlayers.includes(attack.targetId), true);
});

test("win checks recognize village and werewolf victories", () => {
  const villageGame = createSampleGame();
  villageGame.killPlayer("npc3", "test");

  assert.equal(villageGame.checkWin("test"), TEAMS.VILLAGE);
  assert.equal(villageGame.state.winner, TEAMS.VILLAGE);

  const werewolfGame = createSampleGame();
  werewolfGame.killPlayer("npc1", "test");
  werewolfGame.killPlayer("npc2", "test");
  werewolfGame.killPlayer("npc4", "test");

  assert.equal(werewolfGame.checkWin("test"), TEAMS.WEREWOLF);
  assert.equal(werewolfGame.state.winner, TEAMS.WEREWOLF);
});

test("finished games reject further vote and night progression", () => {
  const game = createSampleGame();
  game.killPlayer("npc3", "test");
  game.checkWin("test");

  const stateBefore = {
    day: game.state.day,
    phase: game.state.phase,
    alivePlayers: [...game.state.alivePlayers],
    deadPlayers: [...game.state.deadPlayers],
    voteRounds: game.state.voteHistory.length,
    playerLogs: game.state.playerLog.length
  };

  const vote = game.dispatchPlayerAction({ type: "advance_vote" });
  const night = game.dispatchPlayerAction({ type: "run_night" });

  assert.equal(vote.result, null);
  assert.deepEqual(night.result, {
    skipped: true,
    reason: "game_already_finished"
  });
  assert.deepEqual(
    {
      day: game.state.day,
      phase: game.state.phase,
      alivePlayers: game.state.alivePlayers,
      deadPlayers: game.state.deadPlayers,
      voteRounds: game.state.voteHistory.length,
      playerLogs: game.state.playerLog.length
    },
    stateBefore
  );
});
