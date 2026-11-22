import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

// D-029: claim maintenance on the ask path. A claimed player asked a
// role/result question never falls back to the pre-claim deflection:
// genuine claimants publish fresh results or restate the published
// ones, and fake claimants extend their fabrication with the same
// engine-owned rules the decision points use.
// Fixed village9 roles: npc1/npc2 werewolf, npc3 seer, npc4 medium,
// npc5 knight, npc6 madman, npc7 Gaku, npc8 Hana, npc9 Itsuki (citizens).

function village9() {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: new PseudoResponseProvider() });
}

function registerClaim(game, claimant, role, results, day = 1) {
  const claim = { day, actorId: claimant.id, actorName: claimant.name, role, results };
  claimant.publicClaims.push(claim);
  game.state.publicInfo.push({ type: "public_claim", actorId: claimant.id, actorName: claimant.name, text: `${claimant.name}がCOをした。`, claim });
  game.applyClaimToSuspicion(claim);
  return claim;
}

function attack(game, night, targetId, guarded) {
  game.state.developerLog.push({ day: night, phase: "werewolf_attack", kind: "werewolf_attack", detail: { werewolfId: "npc2", targetId, guarded } });
}

function guard(knight, day, targetId, targetName) {
  knight.knownInfo.push({ day, type: "knight_guard", visibility: "private", shareable: false, targetId, targetName, text: `護衛記録: ${targetName}を守った。` });
}

const DEFLECTION = /役職COを急ぎません/;

test("a fake knight publishes a fabricated entry for a fresh night when asked directly", async () => {
  const game = village9();
  const wolf = game.getPlayer("npc1");
  registerClaim(game, wolf, "knight", [{ night: 1, targetId: "npc3", targetName: "Chika", result: "guarded" }]);
  attack(game, 1, "npc8", true);
  attack(game, 2, "npc7", false);
  game.state.day = 3;

  const response = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "騎士さん、昨夜は誰を護衛したん？護衛履歴を全部教えて" });
  assert.doesNotMatch(response.result.text, DEFLECTION);
  assert.equal(wolf.publicClaims.length, 2);
  const results = wolf.publicClaims[1].results;
  assert.deepEqual(results.map(({ night }) => night), [1, 2]);
  // The published night-1 entry never changes, the fresh night never
  // names the attack target of an unguarded night, and the same player
  // is never guarded twice in a row.
  assert.equal(results[0].targetId, "npc3");
  assert.notEqual(results[1].targetId, "npc7");
  assert.notEqual(results[1].targetId, "npc3");
  assert.ok(game.state.playerLog.some((entry) => entry.message.includes("騎士COします")));
});

test("a fake knight names the real attack target for a guarded fresh night", async () => {
  const game = village9();
  const wolf = game.getPlayer("npc1");
  registerClaim(game, wolf, "knight", [{ night: 1, targetId: "npc3", targetName: "Chika", result: "guarded" }]);
  attack(game, 1, "npc8", true);
  attack(game, 2, "npc9", true);
  game.state.day = 3;

  const response = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "騎士さん、GJ先は誰だったん？" });
  assert.doesNotMatch(response.result.text, DEFLECTION);
  assert.equal(wolf.publicClaims.length, 2);
  assert.equal(wolf.publicClaims[1].results[1].targetId, "npc9");
});

test("a fake knight with nothing fresh restates the published history and registers nothing", async () => {
  const game = village9();
  const wolf = game.getPlayer("npc1");
  registerClaim(game, wolf, "knight", [{ night: 1, targetId: "npc3", targetName: "Chika", result: "guarded" }]);
  attack(game, 1, "npc8", true);
  game.state.day = 2;

  const response = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "騎士さん、護衛履歴を全部教えて" });
  assert.doesNotMatch(response.result.text, DEFLECTION);
  assert.match(response.result.text, /騎士COします/);
  assert.match(response.result.text, /Chika/);
  assert.equal(wolf.publicClaims.length, 1);
});

test("a genuine knight asked with a role keyword and nothing fresh restates instead of deflecting", async () => {
  const game = village9();
  const knight = game.getPlayer("npc5");
  guard(knight, 1, "npc8", "Hana");
  await game.dispatchPlayerAction({ type: "ask_npc", target: "npc5", input: "騎士COしてください" });
  assert.equal(knight.publicClaims.length, 1);

  const response = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc5", input: "騎士さん、護衛履歴を全部教えて" });
  assert.doesNotMatch(response.result.text, DEFLECTION);
  assert.match(response.result.text, /Hana/);
  assert.equal(knight.publicClaims.length, 1);
});

test("a fake seer extends its claim when asked after the genuine seer publishes a new result", async () => {
  const game = village9();
  // Timeline (D-031): both seers claimed on day 2 with one result
  // each; the genuine seer's second result arrives on day 3, so the
  // fake's night budget (day - 1 = 2) still has room to engage it.
  registerClaim(game, game.getPlayer("npc3"), "seer", [{ targetId: "npc7", result: "not_werewolf" }], 2);
  const madman = game.getPlayer("npc6");
  registerClaim(game, madman, "seer", [{ targetId: "npc8", result: "not_werewolf" }], 2);
  registerClaim(game, game.getPlayer("npc3"), "seer", [{ targetId: "npc9", result: "werewolf" }], 3);
  game.state.day = 3;

  const response = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc6", input: "占い師さん、最新の占い結果を教えて" });
  assert.doesNotMatch(response.result.text, DEFLECTION);
  assert.match(response.result.text, /占い結果を追加で公開します/);
  assert.equal(madman.publicClaims.length, 2);
  assert.deepEqual(madman.publicClaims[1].results, [{ targetId: "npc9", result: "not_werewolf" }]);
  assert.ok(madman.publicClaims.every((claim) => (claim.results ?? []).every((result) => result.targetId !== "npc6")));
});

test("a fake seer with nothing new to engage restates its published results", async () => {
  const game = village9();
  const madman = game.getPlayer("npc6");
  registerClaim(game, madman, "seer", [{ targetId: "npc8", result: "not_werewolf" }]);

  const response = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc6", input: "占い師さん、占い結果を全部教えて" });
  assert.doesNotMatch(response.result.text, DEFLECTION);
  assert.match(response.result.text, /占い師COします/);
  assert.match(response.result.text, /Hana/);
  assert.equal(madman.publicClaims.length, 1);
});

test("a fake medium extends after a new execution and the one-black cap still holds", async () => {
  const game = village9();
  const wolf = game.getPlayer("npc1");
  game.state.voteHistory.push({ day: 1, votes: [], executedId: "npc7", tie: false });
  registerClaim(game, wolf, "medium", [{ targetId: "npc7", result: "werewolf" }]);
  game.state.voteHistory.push({ day: 2, votes: [], executedId: "npc8", tie: false });
  game.state.day = 3;

  const response = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "霊媒師さん、Hanaの霊媒結果を教えて" });
  assert.doesNotMatch(response.result.text, DEFLECTION);
  assert.match(response.result.text, /霊媒結果を追加で公開します/);
  assert.equal(wolf.publicClaims.length, 2);
  // Hana was a citizen, so inverting the truth would give a second
  // black; the cap turns it white because the first black stands.
  assert.deepEqual(wolf.publicClaims[1].results, [{ targetId: "npc8", result: "not_werewolf" }]);
});

test("a genuine medium asked again with a role keyword restates the published results", async () => {
  const game = village9();
  game.killPlayer("npc7", "execution");
  game.recordMediumResults(game.getPlayer("npc7"));
  await game.dispatchPlayerAction({ type: "ask_npc", target: "npc4", input: "霊媒師COありますか？" });
  const medium = game.getPlayer("npc4");
  assert.equal(medium.publicClaims.length, 1);

  const response = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc4", input: "霊媒師さん、結果を全部教えて" });
  assert.doesNotMatch(response.result.text, DEFLECTION);
  assert.match(response.result.text, /Gakuは人狼ではありませんでした/);
  assert.equal(medium.publicClaims.length, 1);
});

test("an unclaimed player still answers a role question with the usual deflection", async () => {
  const game = village9();
  const response = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc7", input: "役職を教えて" });
  assert.match(response.result.text, DEFLECTION);
  assert.equal(game.getPlayer("npc7").publicClaims.length, 0);
});
