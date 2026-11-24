import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { extractMentionedPlayerIds } from "../src/textUtils.mjs";

// Preserve mention isolation, specificity and pressure coverage with the D-034 cast.
function roster() {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false }).state.players;
}

test("cast names mention only the intended participant; single-letter aliases need boundaries", () => {
  const players = roster();
  assert.deepEqual(extractMentionedPlayerIds("向田紗栄子と対決するか？", players), ["npc8"]);
  assert.deepEqual(extractMentionedPlayerIds("春日一番は人狼だと思う？", players), ["npc5"]);
  assert.deepEqual(extractMentionedPlayerIds("桐生一馬をどう思う？", players), ["npc1"]);
  const custom = [{ id: "short", name: "Short", aliases: ["T"] }, { id: "long", name: "Test" }];
  assert.deepEqual(extractMentionedPlayerIds("Testはどう？", custom), ["long"]);
  assert.deepEqual(extractMentionedPlayerIds("Tはどう？", custom), ["short"]);
});

test("a standalone cast alias still mentions its player", () => {
  const players = roster();
  assert.deepEqual(extractMentionedPlayerIds("桐生はどう思う？", players), ["npc1"]);
  assert.deepEqual(extractMentionedPlayerIds("桐生と真島、どっちが怪しい？", players), ["npc1", "npc2"]);
});

test("the longest mention wins the first position", () => {
  const players = roster();
  const mentions = extractMentionedPlayerIds("向田紗栄子と桐生一馬どっちが怪しい？", players);
  assert.equal(mentions[0], "npc8");
  assert.deepEqual(new Set(mentions), new Set(["npc8", "npc1"]));
});

test("katakana aliases still match", () => {
  const players = roster();
  assert.deepEqual(extractMentionedPlayerIds("サエコはどう？", players), ["npc8"]);
});

test("an NPC asked about 紗栄子 answers about her, not 桐生", async () => {
  const game = WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc9", input: "向田紗栄子と対決するか？" });
  assert.ok(action.result.evidenceUsed.includes("suspicionScores:npc8"));
  assert.equal(action.result.evidenceUsed.includes("suspicionScores:npc1"), false);
});

test("question pressure from a cast-name accusation lands only on the intended NPC", async () => {
  const game = WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false });
  await game.dispatchPlayerAction({ type: "ask_npc", target: "npc9", input: "向田紗栄子が怪しいと思う" });
  const observer = game.getPlayer("npc2");
  assert.equal(observer.suspicionScores.npc8, 1);
  assert.equal(observer.suspicionScores.npc1 ?? 0, 0);
});
