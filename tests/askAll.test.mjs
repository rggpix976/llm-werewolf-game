import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { ROLES } from "../src/constants.mjs";

// village9 fixed roles: npc1/npc2 werewolf, npc3 seer, npc4 medium,
// npc5 knight, npc6 madman, npc7/npc8/npc9 citizen.
function village9() {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false });
}

function playerMessages(game) {
  return game.state.playerLog.map((entry) => entry.message);
}

test("ask_all asks every alive NPC once and logs the question once", async () => {
  const game = village9();
  const action = await game.dispatchPlayerAction({ type: "ask_all", input: "みんな、今の状況をどう思う？" });

  assert.equal(action.result.broadcast, true);
  assert.equal(action.result.responses.length, 9);
  assert.equal(action.result.responses.every((response) => response.responded), true);

  const messages = playerMessages(game);
  assert.equal(messages.filter((message) => message.startsWith("あなた -> 全員:")).length, 1);
  const names = game.state.players.map((player) => player.name);
  const responseLines = messages.filter((message) => names.some((name) => message.startsWith(`${name}: `)));
  assert.equal(responseLines.length, 9);
});

test("ask_all applies question pressure once, not once per NPC", async () => {
  const question = "Chikaは人狼だと思う？";
  const single = village9();
  await single.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: question });

  const broadcast = village9();
  await broadcast.dispatchPlayerAction({ type: "ask_all", input: question });

  const scoresOf = (game) => Object.fromEntries(game.state.players.map((player) => [player.id, player.suspicionScores]));
  assert.deepEqual(scoresOf(broadcast), scoresOf(single));
  // The comparison must not be vacuous: the accusation really moved scores.
  assert.equal(broadcast.getPlayer("npc1").suspicionScores.npc3, 1);
});

test("ask_all skips dead NPCs", async () => {
  const game = village9();
  for (const voter of game.getAlivePlayers()) {
    voter.suspicionScores = { npc7: 3 };
  }
  await game.dispatchPlayerAction({ type: "advance_vote" });
  assert.equal(game.getPlayer("npc7").alive, false);
  await game.dispatchPlayerAction({ type: "run_night" });

  const aliveCount = game.getAlivePlayers().length;
  const action = await game.dispatchPlayerAction({ type: "ask_all", input: "昨夜のこと、どう思う？" });
  assert.equal(action.result.responses.length, aliveCount);
  assert.equal(action.result.responses.some((response) => response.npcId === "npc7"), false);
});

test("ask_all question can trigger ask-path claims", async () => {
  const game = village9();
  // Day 1: execute npc7 so the medium (npc4) holds an unpublished result.
  for (const voter of game.getAlivePlayers()) {
    voter.suspicionScores = { npc7: 3 };
  }
  await game.dispatchPlayerAction({ type: "advance_vote" });
  // Keep the medium alive through the night: make npc9 the wolves' target.
  for (const wolf of [game.getPlayer("npc1"), game.getPlayer("npc2")]) {
    wolf.suspicionScores = { npc9: -5 };
  }
  await game.dispatchPlayerAction({ type: "run_night" });
  assert.equal(game.getPlayer("npc4").alive, true);

  await game.dispatchPlayerAction({ type: "ask_all", input: "COある？" });

  const claims = game.state.publicInfo.filter((info) => info.type === "public_claim");
  const mediumClaim = claims.find((info) => info.actorId === "npc4");
  assert.ok(mediumClaim);
  assert.equal(mediumClaim.claim.role, ROLES.MEDIUM);
  assert.deepEqual(mediumClaim.claim.results, [{ targetId: "npc7", result: "not_werewolf" }]);
});

test("ask_all with empty input is rejected", async () => {
  const game = village9();
  await assert.rejects(
    game.dispatchPlayerAction({ type: "ask_all", input: "   " }),
    TypeError
  );
});

test("ask_all after the game ends does not respond", async () => {
  const game = WerewolfGame.create({ seed: 3 });
  for (let round = 0; round < 12 && !game.state.winner; round += 1) {
    await game.dispatchPlayerAction({ type: "advance_vote" });
    if (!game.state.winner) {
      await game.dispatchPlayerAction({ type: "run_night" });
    }
  }
  assert.ok(game.state.winner);

  const action = await game.dispatchPlayerAction({ type: "ask_all", input: "まだ聞ける？" });
  assert.equal(action.result.responded, false);
  assert.equal(action.result.reason, "game_already_finished");
});
