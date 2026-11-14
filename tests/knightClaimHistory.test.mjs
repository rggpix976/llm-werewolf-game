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

test("genuine knight rescue and ask claims publish complete guard history", async () => {
  const rescue = game();
  guard(rescue.getPlayer("npc5"), 1, "npc7", "Goro");
  const claim = rescue.registerRescueClaim(rescue.getPlayer("npc5"));
  assert.deepEqual(claim.results, [{ night: 1, targetId: "npc7", targetName: "Goro", result: "guarded" }]);
  assert.match(rescue.state.playerLog.at(-1).message, /1日目の夜はGoroを護衛/);

  const asked = game();
  guard(asked.getPlayer("npc5"), 1, "npc8", "Hana");
  await asked.dispatchPlayerAction({ type: "ask_npc", target: "npc5", input: "騎士COしてください" });
  assert.equal(asked.getPlayer("npc5").publicClaims[0].role, "knight");
  assert.equal(asked.getPlayer("npc5").publicClaims[0].results[0].targetId, "npc8");
});

test("unclaimed knight does not disclose a private guard target in an ordinary answer", async () => {
  const subject = game();
  guard(subject.getPlayer("npc5"), 1, "npc8", "Hana");
  const response = await subject.dispatchPlayerAction({ type: "ask_npc", target: "npc5", input: "昨夜は誰を守りましたか" });
  assert.doesNotMatch(response.result.text, /Hana|npc8|護衛記録/);
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
