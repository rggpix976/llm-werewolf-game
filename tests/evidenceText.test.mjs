import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { buildNpcResponseRequest } from "../src/responseGenerator.mjs";
import { validateNpcResponseRequest } from "../src/validator.mjs";

// Regression coverage for the 2026-11-13 real-AI playtest: questions to
// the knight that mentioned a player he had guarded — and, by the same
// shape, questions to the medium mentioning an executed player — failed
// with "回答を得られませんでした". The knight_guard and medium_result
// knownInfo entries carried no `text`, so when one of them was selected
// as private stance evidence the server-side request validator rejected
// the whole NPC response request (bad_request:
// context.privateStanceEvidence[0].text must be a string).

function village9() {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false });
}

function forceVote(game, targetId) {
  for (const voter of game.getAlivePlayers()) {
    voter.suspicionScores = { [targetId]: 3 };
  }
}

// Plays day 1 + night 1 deterministically: npc7 is executed (the medium
// records a result for npc7), the knight guards npc9, the wolves kill
// npc8, the seer divines npc8.
async function gameAfterNight1() {
  const game = village9();
  forceVote(game, "npc7");
  await game.dispatchPlayerAction({ type: "advance_vote" });
  game.getPlayer("npc3").suspicionScores = { npc8: 9 };
  game.getPlayer("npc1").suspicionScores = { npc2: 5, npc3: 5, npc4: 5, npc5: 5, npc6: 5, npc8: 0, npc9: 5 };
  game.getPlayer("npc5").suspicionScores = { npc9: 0, npc1: 5, npc2: 5, npc3: 5, npc4: 5, npc6: 5, npc8: 5 };
  await game.dispatchPlayerAction({ type: "run_night" });
  return game;
}

test("a question to the knight mentioning his guarded target produces a valid response request", async () => {
  const game = await gameAfterNight1();
  const knight = game.getPlayer("npc5");
  const guardEntry = knight.knownInfo.find((info) => info.type === "knight_guard");
  assert.equal(guardEntry.targetId, "npc9");
  assert.equal(typeof guardEntry.text, "string");

  const { request } = buildNpcResponseRequest(knight, game.state, "Itsukiをどう思う？");
  assert.equal(request.context.privateStanceEvidence.length, 1);
  assert.doesNotThrow(() => validateNpcResponseRequest(request));
});

test("a question to the medium mentioning an executed player produces a valid response request", async () => {
  const game = await gameAfterNight1();
  const medium = game.getPlayer("npc4");
  const resultEntry = medium.knownInfo.find((info) => info.type === "medium_result");
  assert.equal(resultEntry.targetId, "npc7");
  assert.equal(typeof resultEntry.text, "string");

  const { request } = buildNpcResponseRequest(medium, game.state, "Gakuはどうだった？");
  assert.equal(request.context.privateStanceEvidence.length, 1);
  assert.doesNotThrow(() => validateNpcResponseRequest(request));
});
