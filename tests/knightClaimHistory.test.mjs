import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

function game(provider = new PseudoResponseProvider()) {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: provider });
}

function guard(knight, day, targetId, targetName) {
  knight.knownInfo.push({ day, type: "knight_guard", visibility: "private", shareable: false, targetId, targetName, text: `護衛記録: ${targetName}を守った。` });
}

function forceVote(subject, targetId, runnerUpId = "npc7") {
  for (const voter of subject.getAlivePlayers()) {
    voter.suspicionScores = { [targetId]: 10, [runnerUpId]: 2 };
  }
}

function knightDecisions(subject) {
  return subject.state.developerLog.filter((entry) => entry.kind === "werewolf_knight_decision");
}

test("genuine knight rescue and ask claims publish complete guard history", async () => {
  const rescue = game();
  guard(rescue.getPlayer("npc5"), 1, "npc7", "Goro");
  const claim = rescue.registerRescueClaim(rescue.getPlayer("npc5"));
  assert.deepEqual(claim.results, [{ night: 1, targetId: "npc7", targetName: "Goro", result: "guarded" }]);
  assert.match(rescue.state.playerLog.at(-1).message, /1日目の夜はGoroを護衛/);

  const asked = game();
  guard(asked.getPlayer("npc5"), 1, "npc8", "向田紗栄子");
  await asked.dispatchPlayerAction({ type: "ask_npc", target: "npc5", input: "騎士COしてください" });
  assert.equal(asked.getPlayer("npc5").publicClaims[0].role, "knight");
  assert.equal(asked.getPlayer("npc5").publicClaims[0].results[0].targetId, "npc8");
});

test("unclaimed knight does not disclose a private guard target in an ordinary answer", async () => {
  const subject = game();
  guard(subject.getPlayer("npc5"), 1, "npc8", "向田紗栄子");
  const response = await subject.dispatchPlayerAction({ type: "ask_npc", target: "npc5", input: "昨夜は誰を守りましたか" });
  assert.doesNotMatch(response.result.text, /向田紗栄子|npc8|護衛記録/);
  assert.equal(subject.getPlayer("npc5").publicClaims.length, 0);
});

test("GJ morning fake knight claim uses the actual attack target and triggers a privacy-safe real-knight counter offer", async () => {
  const requests = [];
  const provider = {
    name: "knight-test",
    async generateResponse(request) { return new PseudoResponseProvider().generateResponse(request); },
    async chooseAction(request) {
      requests.push(request);
      if (request.candidates.some((c) => c.id === "claim_knight")) return { choiceId: "claim_knight" };
      if (request.decisionPoint === "real_knight_counter_claim") return { choiceId: "stay_silent" };
      return { choiceId: "stay_silent" };
    }
  };
  const subject = game(provider);
  // Wolf attacks npc7 and knight guards npc7.
  subject.getPlayer("npc1").suspicionScores = { npc7: -20 };
  subject.getPlayer("npc5").suspicionScores = { npc7: -20 };
  await subject.runNight();
  const fake = subject.getPlayer("npc1").publicClaims.find((c) => c.role === "knight");
  assert.equal(fake.results[0].targetId, "npc7");
  const counter = requests.find((r) => r.decisionPoint === "real_knight_counter_claim");
  assert.ok(counter);
  assert.equal(counter.context.triggeringClaim.role, "knight");
  assert.deepEqual(Object.keys(counter.private), ["role", "goals"]);
  assert.equal(counter.private.role, "knight");
});

test("contested knight claims add suspicion to both claimants without guard-target shifts", () => {
  const subject = game();
  const wolf = subject.getPlayer("npc1");
  const knight = subject.getPlayer("npc5");
  const observer = subject.getPlayer("npc7");
  const targetBefore = observer.suspicionScores.npc8;
  const wolfBefore = observer.suspicionScores[wolf.id];
  const knightBefore = observer.suspicionScores[knight.id];
  const fake = { day: 2, actorId: wolf.id, actorName: wolf.name, role: "knight", results: [{ night: 1, targetId: "npc8", result: "guarded" }] };
  wolf.publicClaims.push(fake); subject.addPublicInfo({ type: "public_claim", actorId: wolf.id, claim: fake }); subject.applyClaimToSuspicion(fake);
  const real = { day: 2, actorId: knight.id, actorName: knight.name, role: "knight", results: [{ night: 1, targetId: "npc7", result: "guarded" }] };
  knight.publicClaims.push(real); subject.addPublicInfo({ type: "public_claim", actorId: knight.id, claim: real }); subject.applyClaimToSuspicion(real);
  assert.equal(observer.suspicionScores[knight.id] - knightBefore, 2);
  assert.equal(observer.suspicionScores[wolf.id] - wolfBefore, -1); // -3 uncontested, then +2 contested.
  assert.equal(observer.suspicionScores.npc8, targetBefore);
});

test("K-A registers a werewolf knight counterclaim before the rescue revote completes", async () => {
  const provider = {
    name: "counter",
    async chooseAction(request) {
      return { choiceId: request.candidates.some(({ id }) => id === "counter_claim") ? "counter_claim" : "stay_silent" };
    }
  };
  const subject = game(provider);
  guard(subject.getPlayer("npc5"), 1, "npc8", "向田紗栄子");
  subject.state.day = 2;
  subject.addDeveloperLog("werewolf_attack", { targetId: "npc7", guarded: false });
  forceVote(subject, "npc5");

  const vote = await subject.runVote();
  const claims = subject.state.developerLog.filter((entry) => entry.kind === "public_claim_registered");
  const decisionIndex = subject.state.developerLog.findIndex((entry) => entry.kind === "werewolf_knight_decision");
  const voteIndex = subject.state.developerLog.findIndex((entry) => entry.kind === "vote_resolved");
  assert.deepEqual(claims.map((entry) => entry.detail.role), ["knight", "knight"]);
  assert.ok(decisionIndex >= 0 && decisionIndex < voteIndex);
  assert.equal(typeof vote.executedId, "string");
  assert.equal(subject.state.voteHistory.length, 1);
});

test("knight claim caps select the first living unclaimed wolf and exclude other public roles", async () => {
  const offered = [];
  const provider = { name: "caps", async chooseAction(request) { offered.push(request.npc.id); return { choiceId: "claim_knight" }; } };
  const subject = game(provider);
  subject.state.day = 2;
  subject.addDeveloperLog("werewolf_attack", { targetId: "npc7", guarded: true });
  await subject.resolveWerewolfKnightDecision(null, "gj_morning_first_claim");
  await subject.resolveWerewolfKnightDecision(null, "gj_morning_first_claim");
  assert.deepEqual(offered, ["npc1"]);
  assert.equal(knightDecisions(subject).length, 1);

  const seerWolf = game(provider);
  seerWolf.state.day = 2;
  seerWolf.addDeveloperLog("werewolf_attack", { targetId: "npc7", guarded: true });
  seerWolf.getPlayer("npc1").publicClaims.push({ role: "seer", results: [] });
  await seerWolf.resolveWerewolfKnightDecision(null, "gj_morning_first_claim");
  assert.equal(knightDecisions(seerWolf)[0].detail.werewolfId, "npc2");

  const knightWolf = game({ name: "silent", async chooseAction() { return { choiceId: "stay_silent" }; } });
  knightWolf.getPlayer("npc1").publicClaims.push({ role: "knight", results: [] });
  knightWolf.state.day = 2;
  await knightWolf.resolveWerewolfSeerDecision(null);
  assert.equal(knightWolf.state.developerLog.some((entry) => entry.kind === "werewolf_seer_decision" && entry.detail.werewolfId === "npc1"), false);
});

for (const [label, provider, reason] of [
  ["missing chooseAction", { name: "missing" }, "method_missing"],
  ["provider error", { name: "error", async chooseAction() { throw new Error("boom"); } }, "provider_error"],
  ["unknown choice", { name: "invalid", async chooseAction() { return { choiceId: "dance" }; } }, "invalid_choice"]
]) {
  test(`new knight decision points safely stay silent on ${label}`, async () => {
    const morning = game(provider);
    morning.state.day = 2;
    morning.addDeveloperLog("werewolf_attack", { targetId: "npc7", guarded: true });
    assert.equal(await morning.resolveWerewolfKnightDecision(null, "gj_morning_first_claim"), null);
    assert.equal(knightDecisions(morning)[0].detail.fallbackReason, reason);

    const counter = game(provider);
    guard(counter.getPlayer("npc5"), 1, "npc7", "Goro");
    const fake = { role: "knight", actorId: "npc1", results: [{ night: 1, targetId: "npc7", result: "guarded" }] };
    assert.equal(await counter.resolveRealKnightCounterDecision(fake), null);
    assert.equal(counter.state.developerLog.at(-1).detail.fallbackReason, reason);

    const rescue = game(provider);
    rescue.state.day = 2;
    rescue.addDeveloperLog("werewolf_attack", { targetId: "npc7", guarded: false });
    assert.equal(await rescue.resolveWerewolfKnightDecision(fake, "rescue_counter_claim"), null);
    assert.equal(knightDecisions(rescue)[0].detail.fallbackReason, reason);
  });
}

test("K-C is suppressed on day one, victim mornings, and after a public knight claim", async () => {
  const requests = [];
  const provider = { name: "capture", async chooseAction(request) { requests.push(request); return { choiceId: "stay_silent" }; } };
  const dayOne = game(provider);
  assert.equal(requests.length, 0);

  const victim = game(provider);
  victim.getPlayer("npc1").suspicionScores = { npc7: -20 };
  victim.getPlayer("npc5").suspicionScores = { npc8: -20 };
  await victim.runNight();
  assert.equal(requests.some((request) => request.decisionPoint === "gj_morning_first_claim"), false);

  const claimed = game(provider);
  claimed.getPlayer("npc5").publicClaims.push({ role: "knight", results: [] });
  claimed.getPlayer("npc1").suspicionScores = { npc7: -20 };
  claimed.getPlayer("npc5").suspicionScores = { npc7: -20 };
  await claimed.runNight();
  assert.equal(requests.some((request) => request.decisionPoint === "gj_morning_first_claim"), false);
  assert.equal(dayOne.state.day, 1);
});

test("multi-night fabrication obeys victim, self, and consecutive-target exclusions", () => {
  const subject = game();
  const wolf = subject.getPlayer("npc1");
  subject.state.day = 3;
  wolf.suspicionScores = { npc8: -10, npc9: -9 };
  subject.addDeveloperLog("werewolf_attack", { targetId: "npc7", guarded: false });
  subject.state.developerLog.at(-1).day = 1;
  subject.addDeveloperLog("werewolf_attack", { targetId: "npc9", guarded: true });
  subject.state.developerLog.at(-1).day = 2;
  const claim = subject.registerFabricatedKnightClaim(wolf);
  assert.deepEqual(claim.results, [
    { night: 1, targetId: "npc8", result: "guarded" },
    { night: 2, targetId: "npc9", result: "guarded" }
  ]);
  assert.notEqual(claim.results[0].targetId, "npc1");
  assert.notEqual(claim.results[0].targetId, "npc7");
  assert.notEqual(claim.results[0].targetId, claim.results[1].targetId);
});

test("madman decision requests retain wolf-aligned goals", async () => {
  let captured;
  const subject = game({ name: "capture", async chooseAction(request) { captured = request; return { choiceId: "stay_silent" }; } });
  await subject.resolveMadmanSeerDecision({ role: "seer", actorId: "npc3", results: [] });
  assert.equal(captured.private.role, "madman");
  assert.deepEqual(captured.private.goals, ["村を混乱させる", "人狼をかばう"]);
});

test("five-player games never offer knight decisions", async () => {
  let calls = 0;
  const subject = WerewolfGame.create({ seed: 9, shuffleRoles: false, responseProvider: { name: "capture", async chooseAction() { calls += 1; return { choiceId: "claim_knight" }; } } });
  await subject.resolveWerewolfKnightDecision(null, "gj_morning_first_claim");
  assert.equal(calls, 0);
  assert.equal(knightDecisions(subject).length, 0);
});
