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
  assert.ok(game.state.playerLog.some((entry) => entry.message.includes("Hanaは人狼ではありませんでした")));
});

test("a claimed knight publishes new guard history when asked for the GJ target directly", async () => {
  const game = village9();
  const knight = game.getPlayer("npc5");
  guard(knight, 1, "npc8", "Hana");
  await game.dispatchPlayerAction({ type: "ask_npc", target: "npc5", input: "騎士COしてください" });
  assert.equal(knight.publicClaims.length, 1);

  guard(knight, 2, "npc1", "Aoi");
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
  seer.knownInfo.push({ day: 1, type: "seer_result", visibility: "private", shareable: false, targetId: "npc7", targetName: "Gaku", result: "not_werewolf", text: "占い結果: Gakuは人狼ではない。" });
  await game.dispatchPlayerAction({ type: "ask_npc", target: "npc3", input: "占い師COありますか？" });
  assert.equal(seer.publicClaims.length, 1);

  const response = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc3", input: "Gakuの結果についてどう思う？" });
  assert.doesNotMatch(response.result.text, /役職COを急ぎません/);
  assert.equal(seer.publicClaims.length, 1);
});

test("a medium white result undoes an uncontested fake seer claim's shifts", () => {
  const game = village9();
  const base6 = score(game, "npc3", "npc6");
  const base7 = score(game, "npc3", "npc7");
  const base4 = score(game, "npc3", "npc4");
  registerClaim(game, game.getPlayer("npc6"), "seer", [{ targetId: "npc7", result: "werewolf" }], 1);
  assert.equal(score(game, "npc3", "npc6"), base6 - 3);
  assert.equal(score(game, "npc3", "npc7"), base7 + 4);

  registerClaim(game, game.getPlayer("npc4"), "medium", [{ targetId: "npc7", result: "not_werewolf" }], 2);
  assert.equal(score(game, "npc3", "npc6"), base6);
  assert.equal(score(game, "npc3", "npc7"), base7);
  assert.equal(score(game, "npc3", "npc4"), base4 - 3);
  assert.equal(disproofs(game).length, 1);
  assert.ok(game.state.playerLog.some((entry) => entry.message.includes("誤りと判明した")));
});

test("a medium result that agrees with the seer claim changes nothing", () => {
  const game = village9();
  const base6 = score(game, "npc3", "npc6");
  const base7 = score(game, "npc3", "npc7");
  registerClaim(game, game.getPlayer("npc6"), "seer", [{ targetId: "npc7", result: "werewolf" }], 1);
  registerClaim(game, game.getPlayer("npc4"), "medium", [{ targetId: "npc7", result: "werewolf" }], 2);
  assert.equal(score(game, "npc3", "npc6"), base6 - 3);
  assert.equal(score(game, "npc3", "npc7"), base7 + 4);
  assert.equal(disproofs(game).length, 0);
});

test("a contested fake claim's shifts are undone while the genuine claim's stay", () => {
  const game = village9();
  const base3 = score(game, "npc1", "npc3");
  const base6 = score(game, "npc1", "npc6");
  const base7 = score(game, "npc1", "npc7");
  const base8 = score(game, "npc1", "npc8");
  registerClaim(game, game.getPlayer("npc3"), "seer", [{ targetId: "npc8", result: "not_werewolf" }], 1);
  registerClaim(game, game.getPlayer("npc6"), "seer", [{ targetId: "npc7", result: "werewolf" }], 1);
  assert.equal(score(game, "npc1", "npc3"), base3 - 3 + 2);
  assert.equal(score(game, "npc1", "npc6"), base6 + 2);
  assert.equal(score(game, "npc1", "npc7"), base7 + 2);
  assert.equal(score(game, "npc1", "npc8"), base8 - 4);

  registerClaim(game, game.getPlayer("npc4"), "medium", [{ targetId: "npc7", result: "not_werewolf" }], 2);
  assert.equal(score(game, "npc1", "npc6"), base6);
  assert.equal(score(game, "npc1", "npc3"), base3 - 3);
  assert.equal(score(game, "npc1", "npc7"), base7);
  assert.equal(score(game, "npc1", "npc8"), base8 - 4);
});

test("a disproven claim is reversed only once, even with two contradicted results", () => {
  const game = village9();
  const base6 = score(game, "npc3", "npc6");
  const base8 = score(game, "npc3", "npc8");
  registerClaim(game, game.getPlayer("npc6"), "seer", [
    { targetId: "npc7", result: "werewolf" },
    { targetId: "npc8", result: "werewolf" }
  ], 1);
  registerClaim(game, game.getPlayer("npc4"), "medium", [{ targetId: "npc7", result: "not_werewolf" }], 2);
  assert.equal(score(game, "npc3", "npc6"), base6);
  assert.equal(score(game, "npc3", "npc8"), base8);

  registerClaim(game, game.getPlayer("npc4"), "medium", [{ targetId: "npc8", result: "not_werewolf" }], 3);
  assert.equal(score(game, "npc3", "npc6"), base6);
  assert.equal(score(game, "npc3", "npc8"), base8);
  assert.equal(disproofs(game).length, 1);
});

test("the proactive medium publication also reverses a disproven claim", async () => {
  const game = village9();
  const base6 = score(game, "npc3", "npc6");
  const base7 = score(game, "npc3", "npc7");
  registerClaim(game, game.getPlayer("npc6"), "seer", [{ targetId: "npc7", result: "werewolf" }], 1);
  game.killPlayer("npc7", "execution");
  game.recordMediumResults(game.getPlayer("npc7"));
  game.state.day = 2;
  await game.resolveMediumClaimDecision();
  assert.equal(game.getPlayer("npc4").publicClaims.length, 1);
  assert.equal(score(game, "npc3", "npc6"), base6);
  assert.equal(score(game, "npc3", "npc7"), base7);
  assert.equal(disproofs(game).length, 1);
});
