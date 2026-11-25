import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { ROLES } from "../src/constants.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

// village9 fixed roles: npc1/npc2 werewolf, npc3 seer, npc4 medium,
// npc5 knight, npc6 madman, npc7/npc8/npc9 citizen.
function village9({ silenceFakeMedium = false } = {}) {
  const responseProvider = new PseudoResponseProvider();
  if (silenceFakeMedium) {
    const choose = responseProvider.chooseAction.bind(responseProvider);
    responseProvider.chooseAction = (request) => ["counter_claim", "preemptive_first_claim", "follow_up_publication", "rescue_counter_claim"].includes(request.decisionPoint)
      ? Promise.resolve({ choiceId: "stay_silent", providerName: "test" }) : choose(request);
  }
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider });
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
    game.state.playerLog.some((entry) => entry.message.includes("投票が固まる直前、冴島大河が名乗り出た。")),
    true
  );
  assert.equal(game.getPlayer("npc3").alive, true);
  assert.equal(vote.result.executedId, "npc7");
  // Only the final votes are recorded.
  assert.equal(game.state.voteHistory.length, 1);
  assert.equal(game.state.voteHistory[0].executedId, "npc7");
});

test("seer rescue claim with a result triggers the madman counter-claim decision before the re-vote", async () => {
  const game = village9({ silenceFakeMedium: true });
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
  // The werewolf counter-claim runs first, so its suspicion effects inform the
  // madman's later engine-fabricated target.
  assert.deepEqual(madmanClaims[0].claim.results, [{ targetId: "npc3", result: "werewolf" }]);
  const decisionKinds = game.state.developerLog.filter((entry) => entry.kind.endsWith("seer_decision")).map((entry) => entry.kind);
  assert.deepEqual(decisionKinds, ["werewolf_seer_decision", "madman_seer_decision"]);
  assert.equal(claimsBy(game, "npc1").length, 1);
  assert.equal(
    game.state.developerLog.some((entry) => entry.kind === "madman_seer_decision" && entry.detail?.choiceId === "counter_claim"),
    true
  );
  assert.equal(
    game.state.developerLog.some((entry) => entry.kind === "claim_suspicion_applied" && entry.detail?.contested === true),
    true
  );
  // Both engine-owned fake claims make this a three-way contested claim.
  assert.ok(observer.suspicionScores.npc3 > (before.npc3 ?? 0));
  assert.ok(observer.suspicionScores.npc6 > (before.npc6 ?? 0));
  // The re-vote still completes after both provider decisions.
  assert.equal(typeof game.state.voteHistory.at(-1).executedId, "string");
});

test("medium about to be executed rescue-claims with the privately known result", async () => {
  const game = village9({ silenceFakeMedium: true });
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
    game.state.playerLog.some((entry) => entry.message.includes("堂島大吾: 俺が霊媒師だ。結果を公表する。桐生一馬は人狼でした。")),
    true
  );
  assert.equal(game.getPlayer("npc4").alive, true);
  assert.equal(vote.result.executedId, "npc7");
});

test("medium rescue-counter decisions finish in werewolf-first order before the re-vote", async () => {
  const calls = [];
  let voteCollections = 0;
  const responseProvider = new PseudoResponseProvider();
  responseProvider.chooseAction = async (request) => {
    if (request.decisionPoint === "rescue_counter_claim") {
      calls.push({ actorId: request.npc.id, voteCollections });
      return { choiceId: "counter_claim", providerName: "test" };
    }
    return { choiceId: "stay_silent", providerName: "test" };
  };
  const game = WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider });
  game.killPlayer("npc1", "execution");
  game.state.voteHistory.push({ day: 1, votes: [], executedId: "npc1", tie: false });
  game.state.day = 2;
  game.getPlayer("npc4").knownInfo.push({
    day: 1,
    type: "medium_result",
    visibility: "private",
    shareable: false,
    targetId: "npc1",
    result: "werewolf"
  });
  forceVote(game, "npc4", "npc7");
  const collectVotes = game.collectVotes.bind(game);
  game.collectVotes = () => {
    voteCollections += 1;
    return collectVotes();
  };

  await game.runVote();

  assert.deepEqual(calls, [
    { actorId: "npc2", voteCollections: 1 },
    { actorId: "npc6", voteCollections: 1 }
  ]);
  assert.ok(voteCollections >= 2);
  assert.deepEqual(
    game.state.developerLog.filter((entry) => entry.kind.endsWith("medium_decision")).map((entry) => entry.kind),
    ["werewolf_medium_decision", "madman_medium_decision"]
  );
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
  // The pseudo werewolf and madman both counter-claim. The genuine black is
  // on the werewolf himself, so under D-021 the pseudo werewolf picks the
  // accuse shape and blacks the real seer instead of white-wrapping himself;
  // only the madman's white result on npc1 cancels part of the pressure.
  assert.equal(claimsBy(game, "npc6").length, 1);
  assert.equal(claimsBy(game, "npc1").length, 1);
  // D-037: the observer (npc9) is skeptical, so the genuine black lands
  // at +2, the madman's contested white at -1, and the wolf's contested
  // black on the seer at +1; the claimant/rival charges stay uniform.
  assert.equal(observer.suspicionScores.npc1, beforeWolf + 2 + 2 + 2 - 1);
  assert.equal(observer.suspicionScores.npc3, beforeSeer - 3 + 2 + 2 + 1);
});
