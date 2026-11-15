import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

const makeGame = (responseProvider = new PseudoResponseProvider()) => WerewolfGame.create({
  seed: 9,
  scenario: "village9",
  shuffleRoles: false,
  responseProvider
});

function execute(game, ...ids) {
  game.state.voteHistory.push(...ids.map((executedId, index) => ({ day: index + 1, votes: [], executedId, tie: false })));
}

function publicClaim(game, actorId, role, results) {
  const actor = game.getPlayer(actorId);
  const claim = { day: game.state.day, actorId, actorName: actor.name, role, results };
  actor.publicClaims.push(claim);
  game.state.publicInfo.push({ type: "public_claim", actorId, actorName: actor.name, claim });
  game.applyClaimToSuspicion(claim);
  return claim;
}

function decisions(game, kind) {
  return game.state.developerLog.filter((entry) => entry.kind === kind);
}

test("werewolf counters a genuine medium, then publishes after a later execution", async () => {
  const game = makeGame();
  execute(game, "npc7");
  const genuine = publicClaim(game, "npc4", "medium", [{ targetId: "npc7", result: "not_werewolf" }]);
  await game.resolveWerewolfMediumDecision(genuine);
  assert.equal(decisions(game, "werewolf_medium_decision")[0].detail.decisionPoint, "counter_claim");
  assert.deepEqual(game.getPlayer("npc1").publicClaims[0].results, [{ targetId: "npc7", result: "werewolf" }]);

  execute(game, "npc8");
  await game.resolveWerewolfMediumDecision(null);
  assert.equal(decisions(game, "werewolf_medium_decision").at(-1).detail.decisionPoint, "follow_up_publication");
  assert.deepEqual(game.getPlayer("npc1").publicClaims[1].results, [{ targetId: "npc8", result: "not_werewolf" }]);
});

test("werewolf makes a pre-emptive medium claim and the one-per-game cap prevents another wolf", async () => {
  const offered = [];
  const provider = { name: "capture", async chooseAction(request) { offered.push(request.npc.id); return { choiceId: request.candidates[0].id }; } };
  const game = makeGame(provider);
  execute(game, "npc7");
  await game.resolveWerewolfMediumDecision(null);
  await game.resolveWerewolfMediumDecision(null);
  assert.deepEqual(offered, ["npc1"]);
  assert.equal(decisions(game, "werewolf_medium_decision")[0].detail.decisionPoint, "preemptive_first_claim");
  assert.equal(game.getPlayer("npc1").publicClaims.length, 1);
  assert.equal(game.getPlayer("npc2").publicClaims.length, 0);
});

for (const [label, provider, reason] of [
  ["provider failure", { name: "throwing", async chooseAction() { throw new Error("offline"); } }, "provider_error"],
  ["invalid choice", { name: "invalid", async chooseAction() { return { choiceId: "invent_results" }; } }, "invalid_choice"]
]) {
  test(`werewolf fake-medium ${label} safely falls back to silence`, async () => {
    const game = makeGame(provider);
    execute(game, "npc7");
    await game.resolveWerewolfMediumDecision(null);
    assert.equal(game.getPlayer("npc1").publicClaims.length, 0);
    assert.equal(decisions(game, "werewolf_medium_decision")[0].detail.choiceId, "stay_silent");
    assert.equal(decisions(game, "werewolf_medium_decision")[0].detail.fallbackReason, reason);
  });
}

test("werewolves cannot fake medium after seer or knight, or fake seer/knight after medium", async () => {
  for (const role of ["seer", "knight"]) {
    const game = makeGame();
    execute(game, "npc7");
    publicClaim(game, "npc1", role, []);
    publicClaim(game, "npc2", role, []);
    await game.resolveWerewolfMediumDecision(null);
    assert.equal(decisions(game, "werewolf_medium_decision").length, 0);
  }

  const offered = [];
  const provider = { name: "capture", async chooseAction(request) { offered.push(request.npc.id); return { choiceId: "stay_silent" }; } };
  const game = makeGame(provider);
  execute(game, "npc7");
  game.registerFabricatedMediumClaim(game.getPlayer("npc1"));
  await game.resolveWerewolfSeerDecision({ results: [{ targetId: "npc8", result: "not_werewolf" }] });
  await game.resolveWerewolfKnightDecision(null, "gj_morning_first_claim");
  assert.deepEqual(offered, ["npc2", "npc2"]);
});

test("madman handles pre-emptive, counter, and follow-up points after the werewolf decision", async () => {
  const calls = [];
  const provider = { name: "capture", async chooseAction(request) { calls.push(`${request.npc.id}:${request.decisionPoint}`); return { choiceId: request.candidates[0].id }; } };
  const game = makeGame(provider);
  execute(game, "npc7");
  await game.resolveWerewolfMediumDecision(null);
  await game.resolveMadmanMediumDecision(null);
  assert.deepEqual(calls, ["npc1:preemptive_first_claim", "npc6:counter_claim"]);
  execute(game, "npc8");
  await game.resolveMadmanMediumDecision(null);
  assert.equal(calls.at(-1), "npc6:follow_up_publication");
  assert.equal(game.getPlayer("npc6").publicClaims.length, 2);
});

test("madman counterclaims a genuine medium and fake seer/medium claims are mutually exclusive", async () => {
  const game = makeGame();
  execute(game, "npc7");
  const genuine = publicClaim(game, "npc4", "medium", [{ targetId: "npc7", result: "not_werewolf" }]);
  await game.resolveMadmanMediumDecision(genuine);
  assert.equal(decisions(game, "madman_medium_decision")[0].detail.decisionPoint, "counter_claim");

  const seerFirst = makeGame();
  execute(seerFirst, "npc7");
  publicClaim(seerFirst, "npc6", "seer", [{ targetId: "npc8", result: "not_werewolf" }]);
  await seerFirst.resolveMadmanMediumDecision(null);
  assert.equal(decisions(seerFirst, "madman_medium_decision").length, 0);

  await game.resolveMadmanSeerDecision({ results: [{ targetId: "npc8", result: "not_werewolf" }] });
  assert.equal(decisions(game, "madman_seer_decision").length, 0);
});

test("fabrication contradicts the earliest public seer result and covers every execution", () => {
  const game = makeGame();
  execute(game, "npc7", "npc8", "npc2");
  publicClaim(game, "npc3", "seer", [{ targetId: "npc7", result: "not_werewolf" }]);
  publicClaim(game, "npc6", "seer", [{ targetId: "npc7", result: "werewolf" }]);
  const claim = game.registerFabricatedMediumClaim(game.getPlayer("npc1"));
  assert.deepEqual(claim.results, [
    { targetId: "npc7", result: "werewolf" },
    { targetId: "npc8", result: "not_werewolf" },
    { targetId: "npc2", result: "not_werewolf" }
  ]);
});

test("one-black priority favors contradiction, then earliest inversion, and follow-ups preserve old results", () => {
  const game = makeGame();
  execute(game, "npc7", "npc8", "npc9");
  publicClaim(game, "npc3", "seer", [{ targetId: "npc8", result: "not_werewolf" }]);
  const first = game.registerFabricatedMediumClaim(game.getPlayer("npc1"));
  assert.deepEqual(first.results, [
    { targetId: "npc7", result: "not_werewolf" },
    { targetId: "npc8", result: "werewolf" },
    { targetId: "npc9", result: "not_werewolf" }
  ]);
  execute(game, "npc2");
  const followUp = game.registerFabricatedMediumClaim(game.getPlayer("npc1"));
  assert.deepEqual(followUp.results, [{ targetId: "npc2", result: "not_werewolf" }]);
  assert.deepEqual(game.getPlayer("npc1").publicClaims[0].results, first.results);

  const inversionsOnly = makeGame();
  execute(inversionsOnly, "npc7", "npc8");
  assert.deepEqual(inversionsOnly.registerFabricatedMediumClaim(inversionsOnly.getPlayer("npc1")).results, [
    { targetId: "npc7", result: "werewolf" },
    { targetId: "npc8", result: "not_werewolf" }
  ]);
});

test("the second medium claimant gets +2 and gives the first claimant a +2 rival bump", () => {
  const game = makeGame();
  const observer = game.getPlayer("npc5");
  const firstBefore = observer.suspicionScores.npc4 ?? 0;
  const secondBefore = observer.suspicionScores.npc6 ?? 0;
  publicClaim(game, "npc4", "medium", []);
  assert.equal(observer.suspicionScores.npc4, firstBefore - 3);
  publicClaim(game, "npc6", "medium", []);
  assert.equal(observer.suspicionScores.npc4, firstBefore - 1);
  assert.equal(observer.suspicionScores.npc6, secondBefore + 2);
});

test("a seer registered after a medium creates a contradiction, but seer-vs-seer does not", () => {
  const game = makeGame();
  publicClaim(game, "npc4", "medium", [{ targetId: "npc7", result: "not_werewolf" }]);
  publicClaim(game, "npc3", "seer", [{ targetId: "npc7", result: "werewolf" }]);
  assert.deepEqual(new Set(game.state.claimContradictions.npc7.chargedClaimantIds), new Set(["npc4", "npc3"]));

  const seers = makeGame();
  publicClaim(seers, "npc3", "seer", [{ targetId: "npc7", result: "werewolf" }]);
  publicClaim(seers, "npc6", "seer", [{ targetId: "npc7", result: "not_werewolf" }]);
  assert.equal(seers.state.claimContradictions.npc7, undefined);
  assert.equal(decisions(seers, "claim_contradiction").length, 0);
});

test("fake-medium request exposes only the actor role and public evidence", async () => {
  let request;
  const provider = { name: "capture", async chooseAction(value) { request = value; return { choiceId: "stay_silent" }; } };
  const game = makeGame(provider);
  execute(game, "npc7");
  game.getPlayer("npc4").knownInfo.push({ type: "medium_result", targetId: "npc7", result: "not_werewolf" });
  game.getPlayer("npc3").knownInfo.push({ type: "seer_result", targetId: "npc8", result: "werewolf" });
  await game.resolveWerewolfMediumDecision(null);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(request.private.role, "werewolf");
  const serialized = JSON.stringify(request);
  assert.equal(serialized.includes("knownInfo"), false);
  assert.equal(serialized.includes("medium_result"), false);
  assert.equal(serialized.includes("seer_result"), false);
  assert.equal(serialized.includes('"role":"medium"'), false);
  assert.equal(serialized.includes('"role":"seer"'), false);
});
