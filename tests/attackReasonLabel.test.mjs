import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

// Regression: the developer log's werewolf_attack reason was computed
// after the kill, when the claimed seer was already dead, so a kill of
// the claimed seer was always mislabelled as a lowest-suspicion kill.
// The reason must reflect the state before the kill. Fixed village9
// roles: npc1/npc2 werewolf, npc3 seer, npc5 knight.

function village9() {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: new PseudoResponseProvider() });
}

function addSeerClaim(game, player) {
  const claim = { day: game.state.day, actorId: player.id, actorName: player.name, role: "seer", results: [] };
  player.publicClaims.push(claim);
  game.state.publicInfo.push({ type: "public_claim", actorId: player.id, actorName: player.name, text: `${player.name}がCOをした。`, claim });
}

function kills(game) {
  return game.state.developerLog.filter((entry) => entry.kind === "werewolf_attack" && entry.detail?.targetId && !entry.detail?.guarded);
}

test("a kill of the claimed seer is logged as attacked_public_seer_claim", async () => {
  const game = village9();
  addSeerClaim(game, game.getPlayer("npc3"));
  game.getPlayer("npc3").suspicionScores = { npc7: 100 };
  game.getPlayer("npc5").suspicionScores = { npc1: -5 };
  // Night 1: the knight guards the claimed seer, so the attack is a GJ.
  await game.runNight();
  assert.equal(game.getPlayer("npc3").alive, true);
  // Night 2: the knight cannot guard the same target twice running, so
  // the claimed seer dies — and the log must say why she was chosen.
  await game.runNight();
  assert.equal(game.getPlayer("npc3").alive, false);
  const kill = kills(game).find((entry) => entry.detail.targetId === "npc3");
  assert.equal(kill.detail.reason, "attacked_public_seer_claim");
});

test("a kill with no seer claim keeps the lowest-suspicion label", async () => {
  const game = village9();
  game.getPlayer("npc3").suspicionScores = { npc7: 100 };
  game.getPlayer("npc1").suspicionScores = { npc9: -5 };
  game.getPlayer("npc5").suspicionScores = { npc1: -5 };
  await game.runNight();
  const kill = kills(game)[0];
  assert.equal(kill.detail.targetId, "npc9");
  assert.equal(kill.detail.reason, "lowest_suspicion_target_to_keep_suspects_alive");
});
