import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";
import { addressFormsFor } from "../src/cast.mjs";

// D-036: a claim prepared on the ask path is announced verbatim as
// engine-published text (the claimant's set phrases) and never routed
// through provider composition, so registration can never diverge from
// the announcement (playtest 26, 2026-11-25: the genuine medium's
// claim registered behind a composed answer that never mentioned it).
// Also covers the fabricated-medium suffix grammar fix and Daigo's
// superior address exceptions from the same playtest.

class UnrelatedProvider {
  constructor() {
    this.calls = 0;
  }
  async generateResponse() {
    this.calls += 1;
    return { text: "全然関係のない返事です。", providerName: "unrelated-stub" };
  }
  async chooseAction() {
    return { choiceId: "stay_silent", providerName: "unrelated-stub" };
  }
}

test("an ask-path claim is delivered verbatim even when the provider would say something else", async () => {
  const provider = new UnrelatedProvider();
  const game = WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: provider });
  const medium = game.getPlayer("npc4"); // 堂島大吾, genuine medium in the fixed layout
  game.state.day = 2;
  const executed = game.getPlayer("npc1");
  executed.alive = false;
  game.state.voteHistory.push({ day: 1, votes: [], executedId: "npc1", tie: false });
  medium.knownInfo.push({ day: 2, type: "medium_result", visibility: "private", shareable: false, targetId: "npc1", result: "werewolf", text: "霊媒結果: 桐生一馬は人狼だった。" });

  const response = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc4", input: "霊媒師COして" });
  assert.equal(provider.calls, 0, "the provider must not be consulted for a claim announcement");
  assert.ok(response.result.text.includes("俺が霊媒師だ。結果を公表する。"), response.result.text);
  assert.ok(response.result.text.includes("桐生一馬は人狼でした"), response.result.text);
  assert.equal(medium.publicClaims.length, 1);
  assert.ok(game.state.playerLog.some((entry) => entry.message.includes("俺が霊媒師だ。結果を公表する。")));
});

test("a fabricated medium claim never puts a sentence ending after ではない", () => {
  const castIds = ["npc1", "npc2", "npc3", "npc5", "npc6", "npc4", "npc7", "npc8", "npc9"];
  // Daigo (npc4, resultEnding だ) sits in the madman slot here.
  const whiteGame = WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, castIds, responseProvider: new PseudoResponseProvider() });
  whiteGame.state.voteHistory.push({ day: 1, votes: [], executedId: "npc1", tie: false }); // a werewolf: inverted to white
  const whiteClaim = whiteGame.registerFabricatedMediumClaim(whiteGame.getPlayer("npc4"));
  assert.ok(whiteClaim);
  const whiteText = whiteGame.state.playerLog.at(-1).message;
  assert.ok(whiteText.includes("桐生一馬は人狼ではない。"), whiteText);
  assert.ok(!whiteText.includes("ではないだ"), whiteText);

  const blackGame = WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, castIds, responseProvider: new PseudoResponseProvider() });
  blackGame.state.voteHistory.push({ day: 1, votes: [], executedId: "npc7", tie: false }); // a citizen: inverted to black
  const blackClaim = blackGame.registerFabricatedMediumClaim(blackGame.getPlayer("npc4"));
  assert.ok(blackClaim);
  const blackText = blackGame.state.playerLog.at(-1).message;
  assert.ok(blackText.includes("足立宏一は人狼だ。"), blackText);
});

test("Daigo addresses his superiors with さん", () => {
  const game = WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: new PseudoResponseProvider() });
  const daigo = game.getPlayer("npc4");
  const forms = addressFormsFor(daigo, game.state.players);
  assert.equal(forms.npc1, "桐生さん");
  assert.equal(forms.npc2, "真島さん");
  assert.equal(forms.npc3, "冴島さん");
  assert.equal(forms.npc5, "春日");
});
