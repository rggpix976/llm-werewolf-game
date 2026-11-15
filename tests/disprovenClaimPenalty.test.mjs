import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

// D-027: when a medium result proves a seer claim fabricated, undoing
// that claim's suspicion shifts (D-025) is not enough — the proven liar
// returned to their pre-claim standing and was treated as an ordinary
// gray. The disproof now also adds a fixed suspicion penalty toward
// the claimant in every living observer's scores.
// Fixed village9 roles: npc1/npc2 werewolf, npc3 seer, npc4 medium.

function village9() {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: new PseudoResponseProvider() });
}

function registerClaim(game, claimant, role, results, day) {
  const claim = { day, actorId: claimant.id, actorName: claimant.name, role, results };
  claimant.publicClaims.push(claim);
  game.state.publicInfo.push({ type: "public_claim", actorId: claimant.id, actorName: claimant.name, text: `${claimant.name}がCOをした。`, claim });
  game.applyClaimToSuspicion(claim);
  return claim;
}

function score(game, observerId, targetId) {
  return game.getPlayer(observerId).suspicionScores[targetId] ?? 0;
}

function disproofs(game) {
  return game.state.developerLog.filter((entry) => entry.kind === "claim_disproven");
}

// npc1 (werewolf) fake-claims seer with a black on npc7; npc7 is
// executed; the medium (npc4) then publishes npc7 = not_werewolf.
function disproveFakeClaim(game) {
  registerClaim(game, game.getPlayer("npc1"), "seer", [{ targetId: "npc7", result: "werewolf" }], 2);
  game.killPlayer("npc7", "execution");
  registerClaim(game, game.getPlayer("npc4"), "medium", [{ targetId: "npc7", result: "not_werewolf" }], 3);
}

test("a disproven claimant gains suspicion on top of the reversal", () => {
  const game = village9();
  const baseClaimant = score(game, "npc3", "npc1");
  const baseTarget = score(game, "npc3", "npc7");
  disproveFakeClaim(game);
  // The claim's own shifts are undone (target back to baseline) and the
  // claimant ends up ABOVE baseline by the penalty, not merely restored.
  assert.equal(score(game, "npc3", "npc7"), baseTarget);
  assert.equal(score(game, "npc3", "npc1"), baseClaimant + 4);
  assert.equal(disproofs(game).length, 1);
  assert.equal(disproofs(game)[0].detail.liarPenalty, 4);
});

test("the penalty is applied exactly once per disproven claim", () => {
  const game = village9();
  const baseClaimant = score(game, "npc3", "npc1");
  disproveFakeClaim(game);
  // A second medium publication repeating the same result cannot
  // disprove (and penalise) the same claim record again.
  registerClaim(game, game.getPlayer("npc4"), "medium", [{ targetId: "npc7", result: "not_werewolf" }], 3);
  assert.equal(score(game, "npc3", "npc1"), baseClaimant + 4);
  assert.equal(disproofs(game).length, 1);
});

test("dead observers gain no penalty, and the claimant is not self-penalised", () => {
  const game = village9();
  const deadObserverBase = score(game, "npc2", "npc1");
  registerClaim(game, game.getPlayer("npc1"), "seer", [{ targetId: "npc7", result: "werewolf" }], 2);
  game.killPlayer("npc7", "execution");
  game.killPlayer("npc2", "execution");
  const afterClaim = score(game, "npc2", "npc1");
  registerClaim(game, game.getPlayer("npc4"), "medium", [{ targetId: "npc7", result: "not_werewolf" }], 3);
  // The dead observer keeps the claim's shift (reversal also skips the
  // dead), and the claimant's own scores are untouched.
  assert.equal(score(game, "npc2", "npc1"), afterClaim);
  assert.notEqual(afterClaim, deadObserverBase);
  assert.equal(score(game, "npc1", "npc1"), 0);
});

test("after a disproof the proven liar becomes the observers' vote target", () => {
  const game = village9();
  disproveFakeClaim(game);
  // npc3's top score is now the disproven claimant, so that is where
  // their vote goes — the playtest-12 gap, closed.
  assert.equal(game.chooseVote(game.getPlayer("npc3")).targetId, "npc1");
  assert.equal(game.chooseVote(game.getPlayer("npc4")).targetId, "npc1");
});
