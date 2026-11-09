import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { buildNpcResponseRequest } from "../src/responseGenerator.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

// Regression tests for the role-leak found in the 2026-11-09 playtest:
// the werewolf-only phrasings of the identity denial and the role-claim
// deflection let a player identify the werewolves just by asking. Both
// wordings are now identical for every role.

function newGame() {
  return WerewolfGame.create({
    seed: 9,
    scenario: "village9",
    shuffleRoles: false,
    responseProvider: new PseudoResponseProvider()
  });
}

test("werewolf-identity denial uses the same wording for every role", () => {
  const game = newGame();
  // npc1 = werewolf, npc3 = seer, npc6 = madman, npc7 = citizen.
  for (const id of ["npc1", "npc3", "npc6", "npc7"]) {
    const npc = game.getPlayer(id);
    const { request } = buildNpcResponseRequest(npc, game.state, "あなたは人狼ですか？");
    assert.ok(
      request.responsePlan.baseText.includes("私は人狼ではありません。ただ、口だけでは証明にならないので発言と投票で見てください。"),
      `${id} (${npc.role}) should use the shared denial wording`
    );
    assert.ok(
      !request.responsePlan.baseText.includes("疑い先を一つずつ"),
      `${id} (${npc.role}) must not use the old werewolf-only wording`
    );
  }
});

test("role-claim deflection uses the same wording for every role", () => {
  const game = newGame();
  // Day 1 before any night: the seer has no results yet, so nobody can
  // claim here and every role takes the deflection branch.
  // npc1 = werewolf, npc3 = seer, npc5 = knight, npc6 = madman, npc7 = citizen.
  for (const id of ["npc1", "npc3", "npc5", "npc6", "npc7"]) {
    const npc = game.getPlayer(id);
    const { request } = buildNpcResponseRequest(npc, game.state, "役職COはある？");
    assert.ok(
      request.responsePlan.baseText.includes("今は役職COを急ぎません。公開されている発言と投票から考えます。"),
      `${id} (${npc.role}) should use the shared deflection wording`
    );
    assert.ok(
      !request.responsePlan.baseText.includes("役職COはしません"),
      `${id} (${npc.role}) must not use the old werewolf-only wording`
    );
    assert.ok(
      !request.responsePlan.baseText.includes("投票理由を見たいです"),
      `${id} (${npc.role}) must not use the old werewolf-only wording`
    );
  }
});
