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
  const 桐生一馬 = subject.getPlayer("npc1");
  桐生一馬.suspicionScores = { npc5: 3, npc2: 6 };
  const response = await subject.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "春日一番をどう思う？" });
  assert.match(response.result.text, /春日一番は怪しいと思っています/);
  assert.match(response.result.text, /今いちばん気になるのは真島吾朗です/);
  // The named top suspect is exactly who 桐生一馬 would vote for.
  assert.equal(subject.chooseVote(桐生一馬).targetId, "npc2");
});

test("an answer about the top suspect itself is not doubled", async () => {
  const subject = game();
  subject.getPlayer("npc1").suspicionScores = { npc5: 3, npc2: 6 };
  const response = await subject.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "真島吾朗をどう思う？" });
  assert.match(response.result.text, /真島吾朗は怪しいと思っています/);
  assert.doesNotMatch(response.result.text, /気になるのは真島吾朗です/);
});

test("a mild suspicion answer still names a stronger top suspect", async () => {
  const subject = game();
  subject.getPlayer("npc1").suspicionScores = { npc5: 1, npc2: 4 };
  const response = await subject.dispatchPlayerAction({ type: "ask_npc", target: "npc1", input: "春日一番をどう思う？" });
  assert.match(response.result.text, /春日一番は少し気になります/);
  assert.match(response.result.text, /今いちばん気になるのは真島吾朗です/);
});

test("broadcast answers name the top suspect too", async () => {
  const subject = game();
  subject.getPlayer("npc1").suspicionScores = { npc5: 3, npc2: 6 };
  await subject.dispatchPlayerAction({ type: "ask_all", input: "春日一番は真でも吊りやろ" });
  const aoiLine = subject.state.playerLog.map((entry) => entry.message).find((message) => message.startsWith("桐生一馬: "));
  assert.match(aoiLine, /春日一番は怪しい/);
  assert.match(aoiLine, /真島吾朗/);
});

test("the OpenAI provider instructions carry the vote-intention rule", () => {
  const provider = new OpenAIResponseProvider({ apiKey: "dummy" });
  const instructions = provider._getFixedInstructions();
  assert.match(instructions, /VOTE INTENTION/);
  assert.match(instructions, /topSuspect/);
});
