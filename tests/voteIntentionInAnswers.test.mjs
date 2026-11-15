import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";
import { OpenAIResponseProvider } from "../src/openaiProvider.mjs";

// D-026: an answer about one player also names the NPC's actual vote
// intention (their top suspect, ranked exactly as the vote itself is
// chosen) when it is someone else, so statements and votes cannot drift
// apart. Fixed village9 roles do not matter here; suspicion scores do.

function game() {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: new PseudoResponseProvider() });
}

test("an answer about a non-top suspect also names the top suspect", async () => {
  const subject = game();
  const aoi = subject.getPlayer("npc1");
  aoi.suspicionScores = { npc5: 3, npc2: 6 };
  const response = await subject.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "Emaをどう思う？" });
  assert.match(response.result.text, /Emaは怪しいと思っています/);
  assert.match(response.result.text, /今いちばん気になるのはBeniです/);
  // The named top suspect is exactly who Aoi would vote for.
  assert.equal(subject.chooseVote(aoi).targetId, "npc2");
});

test("an answer about the top suspect itself is not doubled", async () => {
  const subject = game();
  subject.getPlayer("npc1").suspicionScores = { npc5: 3, npc2: 6 };
  const response = await subject.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "Beniをどう思う？" });
  assert.match(response.result.text, /Beniは怪しいと思っています/);
  assert.doesNotMatch(response.result.text, /気になるのはBeniです/);
});

test("a mild suspicion answer still names a stronger top suspect", async () => {
  const subject = game();
  subject.getPlayer("npc1").suspicionScores = { npc5: 1, npc2: 4 };
  const response = await subject.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "Emaをどう思う？" });
  assert.match(response.result.text, /Emaは少し気になります/);
  assert.match(response.result.text, /今いちばん気になるのはBeniです/);
});

test("broadcast answers name the top suspect too", async () => {
  const subject = game();
  subject.getPlayer("npc1").suspicionScores = { npc5: 3, npc2: 6 };
  await subject.dispatchPlayerAction({ type: "ask_all", input: "Emaは真でも吊りやろ" });
  const aoiLine = subject.state.playerLog.map((entry) => entry.message).find((message) => message.startsWith("Aoi: "));
  assert.match(aoiLine, /Emaは怪しい/);
  assert.match(aoiLine, /Beni/);
});

test("the OpenAI provider instructions carry the vote-intention rule", () => {
  const provider = new OpenAIResponseProvider({ apiKey: "dummy" });
  const instructions = provider._getFixedInstructions();
  assert.match(instructions, /VOTE INTENTION/);
  assert.match(instructions, /topSuspect/);
});
