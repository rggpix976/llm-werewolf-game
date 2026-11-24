import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

// D-031: fabricated results never exceed the nights that have passed.
// A fake seer publishes at most (day - 1) results in total — the same
// count a genuine seer can hold — no matter how often the ask path or
// a follow-up decision tries to add one. The 2026-11-22 playtest
// showed a madman publishing three seer results on day 2, when only
// one night had passed. Medium and knight fabrications are bounded
// by executions / attacked nights by construction; these tests pin
// the same invariant for all three roles.
// Fixed village9 roles: npc1/npc2 werewolf, npc3 seer, npc4 medium,
// npc5 knight, npc6 madman, npc7 足立宏一, npc8 向田紗栄子, npc9 趙天佑 (citizens).

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

function publishedResults(player, role) {
  return player.publicClaims.filter((claim) => claim.role === role).flatMap((claim) => claim.results ?? []);
}

const DEFLECTION = /役職COを急ぎません/;

test("ask path: a fake seer at the night budget restates instead of minting a second result on day 2", async () => {
  const game = village9();
  game.state.day = 2;
  // The genuine seer's day-2 black is still unanswered, so without
  // the cap the extension would engage it with a fresh result.
  registerClaim(game, game.getPlayer("npc3"), "seer", [{ targetId: "npc9", result: "werewolf" }]);
  const madman = game.getPlayer("npc6");
  registerClaim(game, madman, "seer", [{ targetId: "npc7", result: "not_werewolf" }]);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc6", input: "占い師さん、最新の占い結果を教えて" });
    assert.doesNotMatch(response.result.text, DEFLECTION);
    assert.doesNotMatch(response.result.text, /追加で公開します/);
    assert.match(response.result.text, /占い師COします/);
    assert.equal(madman.publicClaims.length, 1);
    assert.equal(publishedResults(madman, "seer").length, 1);
  }
});

test("ask path: the budget grows by one per night, then caps again", async () => {
  const game = village9();
  game.state.day = 2;
  registerClaim(game, game.getPlayer("npc3"), "seer", [{ targetId: "npc9", result: "werewolf" }]);
  const madman = game.getPlayer("npc6");
  registerClaim(game, madman, "seer", [{ targetId: "npc7", result: "not_werewolf" }]);

  game.state.day = 3;
  registerClaim(game, game.getPlayer("npc3"), "seer", [{ targetId: "npc8", result: "werewolf" }], 3);
  const extended = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc6", input: "占い師さん、最新の占い結果を教えて" });
  assert.match(extended.result.text, /追加で公開します/);
  assert.equal(madman.publicClaims.length, 2);
  assert.deepEqual(publishedResults(madman, "seer"), [
    { targetId: "npc7", result: "not_werewolf" },
    { targetId: "npc8", result: "not_werewolf" }
  ]);

  registerClaim(game, game.getPlayer("npc3"), "seer", [{ targetId: "npc5", result: "werewolf" }], 3);
  const capped = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc6", input: "占い師さん、最新の占い結果を教えて" });
  assert.doesNotMatch(capped.result.text, /追加で公開します/);
  assert.equal(madman.publicClaims.length, 2);
  assert.equal(publishedResults(madman, "seer").length, 2);
});

test("decision path: a follow-up publication on the same day is refused, and allowed the next day", () => {
  const game = village9();
  game.state.day = 2;
  const madman = game.getPlayer("npc6");
  const firstTrigger = { day: 2, actorId: "npc3", actorName: "冴島大河", role: "seer", results: [{ targetId: "npc7", result: "werewolf" }] };
  const first = game.registerFabricatedSeerClaim(madman, firstTrigger, false);
  assert.ok(first);
  assert.equal(publishedResults(madman, "seer").length, 1);

  const sameDayTrigger = { day: 2, actorId: "npc3", actorName: "冴島大河", role: "seer", results: [{ targetId: "npc9", result: "werewolf" }] };
  assert.equal(game.registerFabricatedSeerClaim(madman, sameDayTrigger, true), null);
  assert.equal(madman.publicClaims.length, 1);
  assert.equal(publishedResults(madman, "seer").length, 1);

  game.state.day = 3;
  const nextDay = game.registerFabricatedSeerClaim(madman, sameDayTrigger, true);
  assert.ok(nextDay);
  assert.equal(publishedResults(madman, "seer").length, 2);
});

test("medium fabrication stays within the executions that have happened", () => {
  const game = village9();
  game.state.day = 2;
  game.state.voteHistory.push({ day: 1, votes: [], executedId: "npc7", tie: false });
  const wolf = game.getPlayer("npc1");
  const claim = game.registerFabricatedMediumClaim(wolf);
  assert.equal(claim.results.length, 1);
  assert.equal(publishedResults(wolf, "medium").length, 1);

  game.state.day = 3;
  game.state.voteHistory.push({ day: 2, votes: [], executedId: "npc8", tie: false });
  const followUp = game.registerFabricatedMediumClaim(wolf);
  assert.equal(followUp.results.length, 1);
  assert.equal(publishedResults(wolf, "medium").length, 2);
});

test("knight fabrication stays within the nights that have happened", () => {
  const game = village9();
  game.state.day = 2;
  game.state.developerLog.push({ day: 1, phase: "werewolf_attack", kind: "werewolf_attack", detail: { werewolfId: "npc2", targetId: "npc7", guarded: true } });
  const wolf = game.getPlayer("npc1");
  const claim = game.registerFabricatedKnightClaim(wolf);
  assert.deepEqual(claim.results.map(({ night }) => night), [1]);
  assert.equal(publishedResults(wolf, "knight").length, 1);
});
