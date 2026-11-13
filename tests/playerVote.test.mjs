import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { ROLES } from "../src/constants.mjs";

// Player vote (D-018): the player holds one vote equal to an NPC's,
// cast simultaneously — NPC votes are computed from their own suspicion
// scores exactly as before and never react to the player's vote. When a
// rescue claim (D-015) fires, resolution pauses so the player may change
// their vote before the re-cast.
//
// village9 fixed roles: npc1/npc2 werewolf, npc3 seer, npc4 medium,
// npc5 knight, npc6 madman, npc7/npc8/npc9 citizen.
function village9() {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false });
}

function forceVote(game, targetId, runnerUpId = null) {
  for (const voter of game.getAlivePlayers()) {
    const scores = { [targetId]: 3 };
    if (runnerUpId) scores[runnerUpId] = 2;
    voter.suspicionScores = scores;
  }
}

test("the player's vote is counted alongside the NPC votes", async () => {
  const game = village9();
  forceVote(game, "npc7");
  const vote = await game.dispatchPlayerAction({ type: "advance_vote", playerTargetId: "npc8" });

  assert.equal(vote.result.playerVoted, true);
  const round = game.state.voteHistory.at(-1);
  assert.equal(round.votes.length, 10);
  const playerEntry = round.votes.find((entry) => entry.voterId === "player");
  assert.equal(playerEntry.targetId, "npc8");
  assert.equal(playerEntry.voterName, "あなた");
  // The NPC tally is untouched: everyone else still executed npc7.
  assert.equal(round.executedId, "npc7");
  assert.equal(
    game.state.playerLog.some((entry) => entry.message.includes("あなた->Hana")),
    true
  );
});

test("the player's vote can tip a split vote, and NPC votes do not react to it", async () => {
  const control = village9();
  for (const voter of control.getAlivePlayers()) {
    voter.suspicionScores = voter.id === "npc1" || voter.id === "npc2" || voter.id === "npc3" || voter.id === "npc4"
      ? { npc7: 3 }
      : { npc8: 3 };
  }
  const controlVote = await control.dispatchPlayerAction({ type: "advance_vote" });
  // 4 vs 4 among NPCs (npc9's own top score is npc8 but npc9 cannot be
  // voted by itself; the self-exclusion leaves a 4-4 split plus npc9's
  // vote) — record the NPC-only outcome as the control.
  const controlNpcVotes = controlVote.result.votes.map((v) => `${v.voterId}->${v.targetId}`).sort();

  const game = village9();
  for (const voter of game.getAlivePlayers()) {
    voter.suspicionScores = voter.id === "npc1" || voter.id === "npc2" || voter.id === "npc3" || voter.id === "npc4"
      ? { npc7: 3 }
      : { npc8: 3 };
  }
  const vote = await game.dispatchPlayerAction({ type: "advance_vote", playerTargetId: "npc8" });
  const npcVotes = vote.result.votes.filter((v) => v.voterId !== "player").map((v) => `${v.voterId}->${v.targetId}`).sort();
  assert.deepEqual(npcVotes, controlNpcVotes);
  assert.equal(vote.result.votes.length, controlVote.result.votes.length + 1);
});

test("cast_player_vote validates its target", async () => {
  const game = village9();
  const cast = await game.dispatchPlayerAction({ type: "cast_player_vote", targetId: "npc5" });
  assert.equal(cast.result.cast, true);
  assert.equal(game.state.playerVoteTargetId, "npc5");
  await assert.rejects(
    game.dispatchPlayerAction({ type: "cast_player_vote", targetId: "nobody" }),
    /Unknown NPC/
  );
  // Execute the citizen npc7, then casting for the dead target is refused.
  forceVote(game, "npc7");
  await game.dispatchPlayerAction({ type: "advance_vote" });
  assert.equal(game.getPlayer("npc7").alive, false);
  const deadCast = await game.dispatchPlayerAction({ type: "cast_player_vote", targetId: "npc7" });
  assert.equal(deadCast.result.cast, false);
  assert.equal(deadCast.result.reason, "target_not_alive");
});

test("a rescue claim pauses the vote so the player can change their vote", async () => {
  const game = village9();
  forceVote(game, "npc3", "npc7");
  const first = await game.dispatchPlayerAction({ type: "advance_vote", playerTargetId: "npc7" });

  assert.equal(first.result.revoteRequired, true);
  assert.equal(first.result.claimedBy, "npc3");
  assert.equal(first.result.claimedRole, ROLES.SEER);
  assert.equal(game.state.voteResolutionPending, true);
  // Nobody was executed yet, and the claim is public.
  assert.equal(game.getPlayer("npc3").alive, true);
  assert.equal(game.state.voteHistory.length, 0);
  assert.equal(
    game.state.publicInfo.some((info) => info.type === "public_claim" && info.actorId === "npc3"),
    true
  );
  // The night cannot start mid-vote.
  const night = await game.dispatchPlayerAction({ type: "run_night" });
  assert.equal(night.result.skipped, true);
  assert.equal(night.result.reason, "vote_in_progress");

  // The player changes their vote to the runner-up alternative, then the
  // vote is re-cast and finalised.
  const recast = await game.dispatchPlayerAction({ type: "cast_player_vote", targetId: "npc9" });
  assert.equal(recast.result.cast, true);
  const second = await game.dispatchPlayerAction({ type: "advance_vote" });
  assert.equal(second.result.revoteRequired, undefined);
  assert.equal(game.state.voteResolutionPending, false);
  assert.equal(game.state.playerVoteTargetId, null);
  const round = game.state.voteHistory.at(-1);
  const playerEntry = round.votes.find((entry) => entry.voterId === "player");
  assert.equal(playerEntry.targetId, "npc9");
  assert.equal(game.getPlayer(second.result.executedId).alive, false);
});

test("keeping the same vote through the pause also finalises", async () => {
  const game = village9();
  forceVote(game, "npc3", "npc7");
  const first = await game.dispatchPlayerAction({ type: "advance_vote", playerTargetId: "npc7" });
  assert.equal(first.result.revoteRequired, true);
  const second = await game.dispatchPlayerAction({ type: "advance_vote" });
  assert.equal(second.result.executedId, "npc7");
  const playerEntry = game.state.voteHistory.at(-1).votes.find((entry) => entry.voterId === "player");
  assert.equal(playerEntry.targetId, "npc7");
});

test("without a player vote, rescue claims still resolve inside one call (legacy path)", async () => {
  const game = village9();
  forceVote(game, "npc3", "npc7");
  const vote = await game.dispatchPlayerAction({ type: "advance_vote" });
  assert.equal(vote.result.executedId, "npc7");
  assert.equal(vote.result.playerVoted, false);
  assert.equal(game.state.voteHistory.at(-1).votes.length, 9);
});
