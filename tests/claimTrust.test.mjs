import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";
import { CAST_ROSTER } from "../src/cast.mjs";
import { claimTrustFor, claimResultStrengthFor } from "../src/personalityStrategy.mjs";

// D-037: a published seer result moves each observer's suspicion by an
// amount set by the observer's claimTrust (trusting 6 / standard 4 /
// skeptical 2, halved when the claim is contested). Every other claim
// effect — the claimant bonus/charge, rival charges, contradiction
// charges — stays uniform. NPCs without roster data stay "standard".
// Fixed village9 roles: npc1/npc2 werewolf, npc3 seer, npc4 medium,
// npc5 knight, npc6 madman, npc7/npc8/npc9 citizens.
// Roster trust: npc5/npc7/npc8 trusting, npc4 standard, npc2/npc6/npc9 skeptical.

function village9() {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: new PseudoResponseProvider() });
}

function registerClaim(game, claimant, role, results, day = 2) {
  const claim = { day, actorId: claimant.id, actorName: claimant.name, role, results };
  claimant.publicClaims.push(claim);
  game.state.publicInfo.push({ type: "public_claim", actorId: claimant.id, actorName: claimant.name, text: `${claimant.name}がCOをした。`, claim });
  game.applyClaimToSuspicion(claim);
  return claim;
}

function score(game, observerId, targetId) {
  return game.getPlayer(observerId).suspicionScores[targetId] ?? 0;
}

test("claim trust: the roster carries a 4/4/4 assignment and unset NPCs stay standard", () => {
  const counts = { trusting: 0, standard: 0, skeptical: 0 };
  for (const member of CAST_ROSTER) {
    assert.ok(member.claimTrust in counts, `${member.id} claimTrust`);
    counts[member.claimTrust] += 1;
  }
  assert.deepEqual(counts, { trusting: 4, standard: 4, skeptical: 4 });
  assert.equal(claimTrustFor({}), "standard");
  assert.equal(claimResultStrengthFor({}, false), 4);
  assert.equal(claimResultStrengthFor({ claimTrust: "trusting" }, true), 3);
  assert.equal(claimResultStrengthFor({ claimTrust: "skeptical" }, false), 2);
});

test("claim trust: an uncontested black result lands at 6/4/2 by observer", () => {
  const game = village9();
  const before = { npc5: score(game, "npc5", "npc1"), npc4: score(game, "npc4", "npc1"), npc2: score(game, "npc2", "npc1"), claimantForNpc5: score(game, "npc5", "npc3") };
  registerClaim(game, game.getPlayer("npc3"), "seer", [{ targetId: "npc1", result: "werewolf" }]);
  assert.equal(score(game, "npc5", "npc1") - before.npc5, 6, "trusting observer");
  assert.equal(score(game, "npc4", "npc1") - before.npc4, 4, "standard observer");
  assert.equal(score(game, "npc2", "npc1") - before.npc2, 2, "skeptical observer");
  // The claimant bonus is not a result effect: it stays -3 for everyone.
  assert.equal(score(game, "npc5", "npc3") - before.claimantForNpc5, -3);
});

test("claim trust: an uncontested white result lands at -6/-4/-2 by observer", () => {
  const game = village9();
  const before = { npc5: score(game, "npc5", "npc2"), npc4: score(game, "npc4", "npc2"), npc9: score(game, "npc9", "npc2") };
  registerClaim(game, game.getPlayer("npc3"), "seer", [{ targetId: "npc2", result: "not_werewolf" }]);
  assert.equal(score(game, "npc5", "npc2") - before.npc5, -6);
  assert.equal(score(game, "npc4", "npc2") - before.npc4, -4);
  assert.equal(score(game, "npc9", "npc2") - before.npc9, -2);
});

test("claim trust: contested results halve to 3/2/1 by observer", () => {
  const game = village9();
  registerClaim(game, game.getPlayer("npc3"), "seer", [{ targetId: "npc1", result: "werewolf" }]);
  const before = { npc5: score(game, "npc5", "npc1"), npc4: score(game, "npc4", "npc1"), npc2: score(game, "npc2", "npc1") };
  registerClaim(game, game.getPlayer("npc6"), "seer", [{ targetId: "npc1", result: "not_werewolf" }]);
  assert.equal(score(game, "npc5", "npc1") - before.npc5, -3, "trusting observer, contested");
  assert.equal(score(game, "npc4", "npc1") - before.npc4, -2, "standard observer, contested");
  assert.equal(score(game, "npc2", "npc1") - before.npc2, -1, "skeptical observer, contested");
});
