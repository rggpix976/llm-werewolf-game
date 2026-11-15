import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

function game() { return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: new PseudoResponseProvider() }); }
function claim(g, id, role, targetId, result) {
  const player = g.getPlayer(id); const value = { day: g.state.day, actorId: id, actorName: player.name, role, results: [{ targetId, result }] };
  player.publicClaims.push(value); g.state.publicInfo.push({ type: "public_claim", actorId: id, claim: value }); g.applyClaimToSuspicion(value); return value;
}
function score(g, observer, target) { return g.getPlayer(observer).suspicionScores[target] ?? 0; }

test("medium-seer contradiction charges both claimants once without reversing the seer result", () => {
  const g = game(); const baseSeer = score(g, "npc5", "npc3"); const baseMedium = score(g, "npc5", "npc4"); const baseTarget = score(g, "npc5", "npc7");
  claim(g, "npc3", "seer", "npc7", "werewolf");
  claim(g, "npc4", "medium", "npc7", "not_werewolf");
  assert.equal(score(g, "npc5", "npc3"), baseSeer + 1); // -3 credibility +4 dispute
  assert.equal(score(g, "npc5", "npc7"), baseTarget + 4); // original black remains
  assert.equal(score(g, "npc5", "npc4"), baseMedium + 1); // baseline 0, -3 +4
  claim(g, "npc4", "medium", "npc7", "not_werewolf");
  assert.equal(score(g, "npc5", "npc3"), baseSeer + 1);
  assert.equal(g.state.developerLog.filter((e) => e.kind === "claim_disproven").length, 0);
  assert.ok(g.state.developerLog.some((e) => e.kind === "claim_contradiction"));
  assert.ok(g.state.playerLog.some((e) => e.message.includes("食い違っている")));
  assert.ok(g.state.playerLog.every((e) => !e.message.includes("誤りと判明")));
});

test("medium-medium dispute charges each claimant and agreements do nothing", () => {
  const g = game(); const base = score(g, "npc5", "npc4");
  claim(g, "npc4", "medium", "npc7", "werewolf");
  claim(g, "npc6", "medium", "npc7", "werewolf");
  assert.equal(score(g, "npc5", "npc4"), base - 1); // contested adds two, but no dispute
  claim(g, "npc8", "medium", "npc7", "not_werewolf");
  assert.equal(score(g, "npc5", "npc4"), base + 5);
  assert.deepEqual(new Set(g.state.claimContradictions.npc7.chargedClaimantIds), new Set(["npc4", "npc6", "npc8"]));
});

test("a dead claimant is involved but not charged, and another target charges separately", () => {
  const g = game(); claim(g, "npc3", "seer", "npc7", "werewolf"); g.killPlayer("npc3", "execution");
  claim(g, "npc4", "medium", "npc7", "not_werewolf");
  assert.ok(g.state.claimContradictions.npc7.involvedClaimantIds.includes("npc3"));
  claim(g, "npc4", "medium", "npc8", "werewolf"); claim(g, "npc6", "seer", "npc8", "not_werewolf");
  assert.ok(g.state.claimContradictions.npc8.chargedClaimantIds.includes("npc4"));
});
