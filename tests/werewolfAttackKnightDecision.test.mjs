import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

// D-022: on a night when a knight claim is public, the acting werewolf
// chooses between attacking a knight claimant and attacking as usual
// (claimed seer first, else lowest suspicion). Any provider failure falls
// back to the usual rule. Fixed village9 roles: npc1/npc2 werewolf,
// npc3 seer, npc5 knight, npc6 madman.

function village9(provider) {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: provider });
}

function addClaim(game, player, role, results = []) {
  const claim = { day: game.state.day, actorId: player.id, actorName: player.name, role, results };
  player.publicClaims.push(claim);
  game.state.publicInfo.push({ type: "public_claim", actorId: player.id, actorName: player.name, text: `${player.name}がCOをした。`, claim });
  return claim;
}

function setupNight(game) {
  game.getPlayer("npc3").suspicionScores = { npc7: 100 }; // seer divines Gaku (white)
  game.getPlayer("npc1").suspicionScores = { npc9: -5 }; // wolf's usual target is Itsuki
  game.getPlayer("npc5").suspicionScores = { npc1: -5 }; // knight guards Aoi when no seer is claimed
}

function attackStub(choiceForAttack, captured) {
  return {
    name: "stub",
    async chooseAction(request) {
      captured?.push(request);
      if (request.decisionPoint === "night_attack_target") return { choiceId: choiceForAttack };
      return { choiceId: "stay_silent" };
    }
  };
}

function decisions(game) {
  return game.state.developerLog.filter((entry) => entry.kind === "werewolf_attack_decision");
}

function attacks(game) {
  return game.state.developerLog.filter((entry) => entry.kind === "werewolf_attack" && !entry.detail?.skipped);
}

test("pseudo provider attacks the claimed knight, who cannot guard himself", async () => {
  const game = village9(new PseudoResponseProvider());
  setupNight(game);
  addClaim(game, game.getPlayer("npc5"), "knight");
  await game.runNight();
  assert.equal(game.getPlayer("npc5").alive, false);
  assert.equal(decisions(game)[0].detail.choiceId, "attack_knight_npc5");
  assert.equal(decisions(game)[0].detail.targetId, "npc5");
  assert.equal(attacks(game)[0].detail.targetId, "npc5");
  assert.equal(attacks(game)[0].detail.reason, "attacked_public_knight_claim");
});

test("choosing attack_as_usual keeps the previous targeting", async () => {
  const game = village9(attackStub("attack_as_usual"));
  setupNight(game);
  addClaim(game, game.getPlayer("npc5"), "knight");
  await game.runNight();
  assert.equal(game.getPlayer("npc5").alive, true);
  assert.equal(game.getPlayer("npc9").alive, false);
  assert.equal(decisions(game)[0].detail.choiceId, "attack_as_usual");
  assert.equal(decisions(game)[0].detail.targetId, null);
  assert.equal(decisions(game)[0].detail.fallbackReason, null);
  assert.equal(attacks(game)[0].detail.reason, "lowest_suspicion_target_to_keep_suspects_alive");
});

test("a provider error falls back to the usual targeting", async () => {
  const provider = {
    name: "throwing",
    async chooseAction(request) {
      if (request.decisionPoint === "night_attack_target") throw new Error("no");
      return { choiceId: "stay_silent" };
    }
  };
  const game = village9(provider);
  setupNight(game);
  addClaim(game, game.getPlayer("npc5"), "knight");
  await game.runNight();
  assert.equal(decisions(game)[0].detail.fallbackReason, "provider_error");
  assert.equal(decisions(game)[0].detail.targetId, null);
  assert.equal(game.getPlayer("npc5").alive, true);
  assert.equal(game.getPlayer("npc9").alive, false);
});

test("no knight claim means no attack decision", async () => {
  const game = village9(attackStub("attack_knight_npc5"));
  setupNight(game);
  await game.runNight();
  assert.equal(decisions(game).length, 0);
  assert.equal(game.getPlayer("npc9").alive, false);
});

test("the acting wolf is never offered himself as a knight target", async () => {
  const game = village9(attackStub("attack_knight_npc1"));
  setupNight(game);
  addClaim(game, game.getPlayer("npc1"), "knight");
  await game.runNight();
  assert.equal(decisions(game).length, 0);
  assert.equal(game.getPlayer("npc1").alive, true);
  assert.equal(game.getPlayer("npc9").alive, false);
});

test("two knight claimants produce two attack candidates and either can be chosen", async () => {
  const captured = [];
  const game = village9(attackStub("attack_knight_npc2", captured));
  setupNight(game);
  addClaim(game, game.getPlayer("npc5"), "knight");
  addClaim(game, game.getPlayer("npc2"), "knight");
  await game.runNight();
  const request = captured.find((entry) => entry.decisionPoint === "night_attack_target");
  assert.deepEqual(request.candidates.map(({ id }) => id), ["attack_knight_npc5", "attack_knight_npc2", "attack_as_usual"]);
  // The wolves do not know each other, so the partner who fake-claimed can be bitten.
  assert.equal(game.getPlayer("npc2").alive, false);
  assert.equal(game.getPlayer("npc5").alive, true);
});

test("attacking the knight instead of the claimed seer leaves the seer alive", async () => {
  const game = village9(attackStub("attack_knight_npc5"));
  setupNight(game);
  addClaim(game, game.getPlayer("npc3"), "seer");
  addClaim(game, game.getPlayer("npc5"), "knight");
  await game.runNight();
  assert.equal(game.getPlayer("npc5").alive, false);
  assert.equal(game.getPlayer("npc3").alive, true);
  assert.equal(attacks(game)[0].detail.targetId, "npc5");
});

test("attacking as usual against a claimed seer is stopped by the knight's guard", async () => {
  const game = village9(attackStub("attack_as_usual"));
  setupNight(game);
  addClaim(game, game.getPlayer("npc3"), "seer");
  addClaim(game, game.getPlayer("npc5"), "knight");
  await game.runNight();
  assert.equal(attacks(game)[0].detail.targetId, "npc3");
  assert.equal(attacks(game)[0].detail.guarded, true);
  assert.equal(game.getPlayer("npc3").alive, true);
  assert.equal(game.getPlayer("npc5").alive, true);
});

test("the attack decision request carries public claims and only the wolf's own role", async () => {
  const captured = [];
  const game = village9(attackStub("attack_as_usual", captured));
  setupNight(game);
  addClaim(game, game.getPlayer("npc5"), "knight");
  await game.runNight();
  const request = captured.find((entry) => entry.decisionPoint === "night_attack_target");
  assert.equal(request.private.role, "werewolf");
  const serialized = JSON.stringify(request);
  assert.equal(serialized.includes("hiddenInfo"), false);
  assert.equal(serialized.includes("knownInfo"), false);
  // The knight's private guard choice for the night is never part of the request.
  assert.equal(serialized.includes("knight_guard"), false);
});

test("default five-player games never offer the attack decision", async () => {
  const game = WerewolfGame.create({ seed: 9, responseProvider: attackStub("attack_knight_npc5") });
  assert.equal(await game.resolveWerewolfAttackDecision(), null);
  assert.equal(decisions(game).length, 0);
});
