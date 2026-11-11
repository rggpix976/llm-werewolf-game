import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { ROLES } from "../src/constants.mjs";

// village9 fixed roles: npc1/npc2 werewolf, npc3 seer, npc4 medium,
// npc5 knight, npc6 madman, npc7/npc8/npc9 citizen.
function village9() {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false });
}

// Make every alive voter rank `targetId` first (3) and `runnerUpId` second
// (2) so the provisional execution target is deterministic.
function forceVote(game, targetId, runnerUpId = null) {
  for (const voter of game.getAlivePlayers()) {
    const scores = { [targetId]: 3 };
    if (runnerUpId) scores[runnerUpId] = 2;
    voter.suspicionScores = scores;
  }
}

function claimsBy(game, actorId) {
  return game.state.publicInfo.filter((info) => info.type === "public_claim" && info.actorId === actorId);
}

test("seer about to be executed on day 1 rescue-claims with no results yet and survives the re-vote", async () => {
  const game = village9();
  forceVote(game, "npc3", "npc7");
  const vote = await game.dispatchPlayerAction({ type: "advance_vote" });

  const claims = claimsBy(game, "npc3");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim.role, ROLES.SEER);
  assert.deepEqual(claims[0].claim.results, []);
  assert.equal(
    game.state.playerLog.some((entry) => entry.message.includes("投票が固まる直前、Chikaが名乗り出た。")),
    true
  );
  assert.equal(game.getPlayer("npc3").alive, true);
  assert.equal(vote.result.executedId, "npc7");
  // Only the final votes are recorded.
  assert.equal(game.state.voteHistory.length, 1);
  assert.equal(game.state.voteHistory[0].executedId, "npc7");
});

test("seer rescue claim with a result triggers the madman counter-claim decision before the re-vote", async () => {
  const game = village9();
  // Day 1: execute the citizen npc7.
  forceVote(game, "npc7");
  await game.dispatchPlayerAction({ type: "advance_vote" });
  assert.equal(game.getPlayer("npc7").alive, false);

  // Night 1: the seer divines npc8, the wolves kill npc8, the knight guards npc9.
  game.getPlayer("npc3").suspicionScores = { npc8: 9 };
  game.getPlayer("npc1").suspicionScores = { npc2: 5, npc3: 5, npc4: 5, npc5: 5, npc6: 5, npc8: 0, npc9: 5 };
  game.getPlayer("npc5").suspicionScores = { npc9: 0, npc1: 5, npc2: 5, npc3: 5, npc4: 5, npc6: 5, npc8: 5 };
  await game.dispatchPlayerAction({ type: "run_night" });
  assert.equal(game.getPlayer("npc8").alive, false);
  // The only seer result is about a dead player, so no proactive claim fired.
  assert.equal(claimsBy(game, "npc3").length, 0);

  // Day 2: the village turns on the seer; she rescue-claims and the madman
  // (pseudo provider) counter-claims before the re-vote.
  forceVote(game, "npc3", "npc9");
  const observer = game.getPlayer("npc4");
  const before = { ...observer.suspicionScores };
  await game.dispatchPlayerAction({ type: "advance_vote" });

  const seerClaims = claimsBy(game, "npc3");
  assert.equal(seerClaims.length, 1);
  assert.deepEqual(seerClaims[0].claim.results, [{ targetId: "npc8", result: "not_werewolf" }]);

  const madmanClaims = claimsBy(game, "npc6");
  assert.equal(madmanClaims.length, 1);
  assert.equal(madmanClaims[0].claim.role, ROLES.SEER);
  // The fabricated claim flips the real result's verdict onto the madman's
  // most-suspected living player (npc9 after the real claim's effects).
  assert.deepEqual(madmanClaims[0].claim.results, [{ targetId: "npc9", result: "werewolf" }]);
  assert.equal(
    game.state.developerLog.some((entry) => entry.kind === "madman_seer_decision" && entry.detail?.choiceId === "counter_claim"),
    true
  );
  assert.equal(
    game.state.developerLog.some((entry) => entry.kind === "claim_suspicion_applied" && entry.detail?.contested === true),
    true
  );
  // Contested math for a neutral observer: real claimant 3 - 3 (believed)
  // + 2 (contested) = 2; fake claimant 0 + 2 (contested) = 2.
  assert.equal(observer.suspicionScores.npc3, (before.npc3 ?? 0) - 3 + 2);
  assert.equal(observer.suspicionScores.npc6, (before.npc6 ?? 0) + 2);
  // The re-vote follows the shifted suspicion: the fake claim's fabricated
  // werewolf result makes npc9 the execution target.
  assert.equal(game.state.voteHistory.at(-1).executedId, "npc9");
});

test("medium about to be executed rescue-claims with the privately known result", async () => {
  const game = village9();
  // Day 1: execute a werewolf so the medium learns a result.
  forceVote(game, "npc1");
  await game.dispatchPlayerAction({ type: "advance_vote" });
  assert.equal(game.getPlayer("npc4").knownInfo.some((info) => info.type === "medium_result" && info.targetId === "npc1"), true);

  // Night 1: keep the setup quiet; the seer divines npc9 and the wolves kill npc9.
  game.getPlayer("npc3").suspicionScores = { npc9: 9 };
  game.getPlayer("npc2").suspicionScores = { npc3: 5, npc4: 5, npc5: 5, npc6: 5, npc7: 5, npc8: 5, npc9: 0 };
  game.getPlayer("npc5").suspicionScores = { npc7: 0, npc2: 5, npc3: 5, npc4: 5, npc6: 5, npc8: 5, npc9: 5 };
  await game.dispatchPlayerAction({ type: "run_night" });
  assert.equal(game.getPlayer("npc9").alive, false);

  // Day 2: the village turns on the medium.
  forceVote(game, "npc4", "npc7");
  const vote = await game.dispatchPlayerAction({ type: "advance_vote" });

  const claims = claimsBy(game, "npc4");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim.role, ROLES.MEDIUM);
  assert.deepEqual(claims[0].claim.results, [{ targetId: "npc1", result: "werewolf" }]);
  assert.equal(
    game.state.playerLog.some((entry) => entry.message.includes("Daichi: 霊媒師COします。Aoiは人狼でした。")),
    true
  );
  assert.equal(game.getPlayer("npc4").alive, true);
  assert.equal(vote.result.executedId, "npc7");
});

test("knight about to be executed rescue-claims and survives the re-vote", async () => {
  const game = village9();
  forceVote(game, "npc5", "npc7");
  const vote = await game.dispatchPlayerAction({ type: "advance_vote" });

  const claims = claimsBy(game, "npc5");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim.role, ROLES.KNIGHT);
  assert.deepEqual(claims[0].claim.results, []);
  assert.equal(game.getPlayer("npc5").alive, true);
  assert.equal(vote.result.executedId, "npc7");
});

test("citizens, werewolves and the madman get no rescue claim", async () => {
  for (const targetId of ["npc7", "npc1", "npc6"]) {
    const game = village9();
    forceVote(game, targetId);
    const vote = await game.dispatchPlayerAction({ type: "advance_vote" });
    assert.equal(vote.result.executedId, targetId);
    assert.equal(claimsBy(game, targetId).length, 0);
  }
});

test("an already-claimed seer does not rescue-claim again and can still be executed", async () => {
  const game = village9();
  forceVote(game, "npc7");
  await game.dispatchPlayerAction({ type: "advance_vote" });

  // Night 1: the seer divines the living werewolf npc1; she will claim
  // proactively on day 2. The knight's guard keeps her alive either way.
  game.getPlayer("npc3").suspicionScores = { npc1: 9 };
  game.getPlayer("npc1").suspicionScores = { npc8: 0, npc2: 5, npc3: 5, npc4: 5, npc5: 5, npc6: 5, npc9: 5 };
  game.getPlayer("npc5").suspicionScores = { npc9: 0, npc1: 5, npc2: 5, npc3: 5, npc4: 5, npc6: 5, npc8: 5 };
  await game.dispatchPlayerAction({ type: "run_night" });
  assert.equal(claimsBy(game, "npc3").length, 1);

  forceVote(game, "npc3", "npc9");
  // Overwhelming suspicion (9) is more than a claim can erase: she is
  // executed without a second claim.
  for (const voter of game.getAlivePlayers()) voter.suspicionScores = { npc3: 9, npc9: 2 };
  const vote = await game.dispatchPlayerAction({ type: "advance_vote" });
  assert.equal(claimsBy(game, "npc3").length, 1);
  assert.equal(vote.result.executedId, "npc3");
});

test("a proactive seer claim shifts other NPCs' suspicion toward the published result", async () => {
  const game = village9();
  forceVote(game, "npc7");
  await game.dispatchPlayerAction({ type: "advance_vote" });

  const observer = game.getPlayer("npc9");
  const beforeWolf = observer.suspicionScores.npc1 ?? 0;
  const beforeSeer = observer.suspicionScores.npc3 ?? 0;

  game.getPlayer("npc3").suspicionScores = { npc1: 9 };
  game.getPlayer("npc1").suspicionScores = { npc8: 0, npc2: 5, npc3: 5, npc4: 5, npc5: 5, npc6: 5, npc9: 5 };
  game.getPlayer("npc5").suspicionScores = { npc9: 0, npc1: 5, npc2: 5, npc3: 5, npc4: 5, npc6: 5, npc8: 5 };
  await game.dispatchPlayerAction({ type: "run_night" });

  assert.equal(claimsBy(game, "npc3").length, 1);
  // The pseudo madman counter-claims against the morning claim, so the net
  // effect on the observer is the uncontested shift plus the contested one:
  // published werewolf target +4 then -2, claimant -3 then +2.
  assert.equal(claimsBy(game, "npc6").length, 1);
  assert.equal(observer.suspicionScores.npc1, beforeWolf + 4 - 2);
  assert.equal(observer.suspicionScores.npc3, beforeSeer - 3 + 2);
});
