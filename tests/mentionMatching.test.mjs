import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { extractMentionedPlayerIds } from "../src/textUtils.mjs";

// Regression coverage for the 2026-11-11 playtest defect: asking Itsuki
// "hanaと対決するか？" produced an answer about Aoi, because Aoi's
// one-letter alias "A" substring-matched the "a" inside "hana" and Aoi
// comes first in roster order.
function roster() {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false }).state.players;
}

test("a romaji name does not mention the one-letter alias inside it", () => {
  const players = roster();
  assert.deepEqual(extractMentionedPlayerIds("hanaと対決するか？", players), ["npc8"]);
  assert.deepEqual(extractMentionedPlayerIds("Emaは人狼だと思う？", players), ["npc5"]);
  assert.deepEqual(extractMentionedPlayerIds("aoiをどう思う？", players), ["npc1"]);
});

test("a standalone one-letter alias still mentions its player", () => {
  const players = roster();
  assert.deepEqual(extractMentionedPlayerIds("Aはどう思う？", players), ["npc1"]);
  assert.deepEqual(extractMentionedPlayerIds("AとB、どっちが怪しい？", players), ["npc1", "npc2"]);
});

test("the longest mention wins the first position", () => {
  const players = roster();
  const mentions = extractMentionedPlayerIds("hanaとAoiどっちが怪しい？", players);
  assert.equal(mentions[0], "npc8");
  assert.deepEqual(new Set(mentions), new Set(["npc8", "npc1"]));
});

test("katakana aliases still match", () => {
  const players = roster();
  assert.deepEqual(extractMentionedPlayerIds("ハナはどう？", players), ["npc8"]);
});

test("an NPC asked about Hana in romaji answers about Hana, not Aoi", async () => {
  const game = WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false });
  const action = await game.dispatchPlayerAction({ type: "ask_npc", target: "npc9", input: "hanaと対決するか？" });
  assert.ok(action.result.evidenceUsed.includes("suspicionScores:npc8"));
  assert.equal(action.result.evidenceUsed.includes("suspicionScores:npc1"), false);
});

test("question pressure from a romaji accusation lands only on the intended NPC", async () => {
  const game = WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false });
  await game.dispatchPlayerAction({ type: "ask_npc", target: "npc9", input: "Hanaが怪しいと思う" });
  const beni = game.getPlayer("npc2");
  assert.equal(beni.suspicionScores.npc8, 1);
  assert.equal(beni.suspicionScores.npc1 ?? 0, 0);
});
