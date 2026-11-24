import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

// D-024: direct result questions to an already-claimed player reach the
// claim path even without a role keyword.
// D-025: a medium result that disproves a public seer claim undoes the
// suspicion shifts that claim applied when it registered.
// Fixed village9 roles: npc3 seer, npc4 medium, npc5 knight, npc6 madman.

function village9() {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: new PseudoResponseProvider() });
}

function guard(knight, day, targetId, targetName) {
  knight.knownInfo.push({ day, type: "knight_guard", visibility: "private", shareable: false, targetId, targetName, text: `護衛記録: ${targetName}を守った。` });
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

test("a claimed medium publishes a fresh result when asked for the result directly", async () => {
  const game = village9();
  game.killPlayer("npc7", "execution");
  game.recordMediumResults(game.getPlayer("npc7"));
  await game.dispatchPlayerAction({ type: "ask_npc", target: "npc4", input: "霊媒師COありますか？" });
  assert.equal(game.getPlayer("npc4").publicClaims.length, 1);

  game.killPlayer("npc8", "execution");
  game.recordMediumResults(game.getPlayer("npc8"));
  await game.dispatchPlayerAction({ type: "ask_npc", target: "npc4", input: "霊能結果を教えて" });
  const claims = game.getPlayer("npc4").publicClaims;
  assert.equal(claims.length, 2);
  assert.deepEqual(claims[1].results, [{ targetId: "npc8", result: "not_werewolf" }]);
  assert.ok(game.state.playerLog.some((entry) => entry.message.includes("向田紗栄子は人狼ではありませんでした")));
});

test("a claimed knight publishes new guard history when asked for the GJ target directly", async () => {
  const game = village9();
  const knight = game.getPlayer("npc5");
  guard(knight, 1, "npc8", "向田紗栄子");
  await game.dispatchPlayerAction({ type: "ask_npc", target: "npc5", input: "騎士COしてください" });
  assert.equal(knight.publicClaims.length, 1);

  guard(knight, 2, "npc1", "桐生一馬");
  await game.dispatchPlayerAction({ type: "ask_npc", target: "npc5", input: "GJ先教えて" });
  assert.equal(knight.publicClaims.length, 2);
  assert.equal(knight.publicClaims[1].results.length, 2);
});

test("an unclaimed medium does not claim on a direct result question", async () => {
  const game = village9();
  game.killPlayer("npc7", "execution");
  game.recordMediumResults(game.getPlayer("npc7"));
  await game.dispatchPlayerAction({ type: "ask_npc", target: "npc4", input: "霊能結果を教えて" });
  assert.equal(game.getPlayer("npc4").publicClaims.length, 0);
});

test("a claimed seer with nothing fresh answers a result question normally", async () => {
  const game = village9();
  const seer = game.getPlayer("npc3");
  seer.knownInfo.push({ day: 1, type: "seer_result", visibility: "private", shareable: false, targetId: "npc7", targetName: "足立宏一", result: "not_werewolf", text: "占い結果: 足立宏一は人狼ではない。" });
  await game.dispatchPlayerAction({ type: "ask_npc", target: "npc3", input: "占い師COありますか？" });
  assert.equal(seer.publicClaims.length, 1);

  const response = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc3", input: "足立宏一の結果についてどう思う？" });
  assert.doesNotMatch(response.result.text, /役職COを急ぎません/);
  assert.equal(seer.publicClaims.length, 1);
});
