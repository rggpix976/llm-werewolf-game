import assert from "node:assert/strict";
import test from "node:test";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { buildProactiveSeerClaim } from "../src/responseGenerator.mjs";

const PLAYERS = [
  { id: "npc1", name: "Aoi", alive: true },
  { id: "npc2", name: "Beni", alive: true },
  { id: "npc3", name: "Chika", alive: false },
  { id: "npc4", name: "Daichi", alive: true },
  { id: "npc5", name: "Ema", alive: true }
];

function seerNpc(overrides = {}) {
  return {
    id: "npc2",
    name: "Beni",
    role: "seer",
    alive: true,
    knownInfo: [],
    publicClaims: [],
    conversationPolicy: { roleClaim: "claim_when_directly_asked_after_result" },
    ...overrides
  };
}

function state(overrides = {}) {
  return { day: 2, phase: "day_discussion", players: PLAYERS, ...overrides };
}

function seerResult(targetId, result) {
  return { day: 1, type: "seer_result", visibility: "private", shareable: false, targetId, result };
}

test("proactive claim: non-seer and policy-gated NPCs stay silent", () => {
  const citizen = seerNpc({ role: "citizen", knownInfo: [seerResult("npc5", "not_werewolf")] });
  assert.equal(buildProactiveSeerClaim(citizen, state()), null);

  const gated = seerNpc({
    conversationPolicy: { roleClaim: "avoid_unnecessary_claim" },
    knownInfo: [seerResult("npc5", "not_werewolf")]
  });
  assert.equal(buildProactiveSeerClaim(gated, state()), null);
});

test("proactive claim: no results, dead-only results, and fully claimed results stay silent", () => {
  assert.equal(buildProactiveSeerClaim(seerNpc(), state()), null);

  const deadOnly = seerNpc({ knownInfo: [seerResult("npc3", "not_werewolf")] });
  assert.equal(buildProactiveSeerClaim(deadOnly, state()), null);

  const claimed = seerNpc({
    knownInfo: [seerResult("npc5", "not_werewolf")],
    publicClaims: [{ day: 1, actorId: "npc2", actorName: "Beni", role: "seer", results: [{ targetId: "npc5", result: "not_werewolf" }] }]
  });
  assert.equal(buildProactiveSeerClaim(claimed, state()), null);
});

test("proactive claim: first claim announces only unclaimed results about living players", () => {
  const npc = seerNpc({
    knownInfo: [seerResult("npc3", "werewolf"), seerResult("npc5", "not_werewolf")]
  });
  const claim = buildProactiveSeerClaim(npc, state());
  assert.ok(claim);
  assert.ok(claim.text.startsWith("占い師COします。"));
  assert.ok(claim.text.includes("Emaは人狼ではない判定"));
  assert.ok(!claim.text.includes("Chika"));
  assert.deepEqual(claim.publicClaim.results, [{ targetId: "npc5", result: "not_werewolf" }]);
  assert.equal(claim.publicClaim.day, 2);
  assert.equal(claim.publicClaim.actorId, "npc2");
});

test("proactive claim: follow-up announcement does not repeat the CO wording", () => {
  const npc = seerNpc({
    knownInfo: [seerResult("npc5", "not_werewolf"), seerResult("npc4", "werewolf")],
    publicClaims: [{ day: 1, actorId: "npc2", actorName: "Beni", role: "seer", results: [{ targetId: "npc5", result: "not_werewolf" }] }]
  });
  const claim = buildProactiveSeerClaim(npc, state({ day: 3 }));
  assert.ok(claim);
  assert.ok(!claim.text.includes("占い師COします"));
  assert.ok(claim.text.includes("追加で公開します"));
  assert.ok(claim.text.includes("Daichiは人狼判定"));
  assert.deepEqual(claim.publicClaim.results, [{ targetId: "npc4", result: "werewolf" }]);
});

// Engine integration. With shuffleRoles: false the roles are fixed:
// npc1 Aoi = werewolf, npc2 Beni = seer, npc3..npc5 = citizens.
function arrangedGame() {
  const game = WerewolfGame.create({ seed: 1, shuffleRoles: false });
  const seer = game.getPlayer("npc2");
  const werewolf = game.getPlayer("npc1");
  seer.suspicionScores = { npc1: 0, npc3: 0, npc4: 0, npc5: 5 };
  werewolf.suspicionScores = { npc2: 0, npc3: -5, npc4: 0, npc5: 0 };
  return game;
}

function claimLines(game) {
  return game.state.playerLog.map((entry) => entry.message).filter((line) => line.includes("占い"));
}

test("engine: the seer claims proactively at the start of day 2", () => {
  const game = arrangedGame();
  game.runNight();

  assert.equal(game.state.day, 2);
  assert.equal(game.getPlayer("npc3").alive, false);
  assert.equal(game.getPlayer("npc5").alive, true);

  const lines = claimLines(game);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith("Beni: 占い師COします。"));
  assert.ok(lines[0].includes("Emaは人狼ではない判定"));

  const seer = game.getPlayer("npc2");
  assert.equal(seer.publicClaims.length, 1);
  assert.deepEqual(seer.publicClaims[0].results, [{ targetId: "npc5", result: "not_werewolf" }]);

  const claimInfo = game.state.publicInfo.find((info) => info.type === "public_claim");
  assert.equal(claimInfo.actorId, "npc2");

  const messages = game.state.playerLog.map((entry) => entry.message);
  const dayStartIndex = messages.findIndex((line) => line.includes("2日目の昼"));
  const claimIndex = messages.findIndex((line) => line.includes("占い師COします"));
  assert.ok(dayStartIndex >= 0 && claimIndex > dayStartIndex);
});

test("engine: a follow-up result is announced once, then silence", () => {
  const game = arrangedGame();
  game.runNight();
  const seer = game.getPlayer("npc2");
  assert.equal(seer.publicClaims.length, 1);

  seer.knownInfo.push({ day: 2, type: "seer_result", visibility: "private", shareable: false, targetId: "npc4", result: "werewolf" });
  const claim = game.emitProactiveSeerClaim();
  assert.ok(claim);
  assert.deepEqual(claim.results, [{ targetId: "npc4", result: "werewolf" }]);
  const lines = claimLines(game);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes("追加で公開します"));
  assert.ok(lines[1].includes("Daichiは人狼判定"));

  assert.equal(game.emitProactiveSeerClaim(), null);
  assert.equal(seer.publicClaims.length, 2);
});

test("engine: a result about the player killed that night is not announced", () => {
  const game = WerewolfGame.create({ seed: 1, shuffleRoles: false });
  const seer = game.getPlayer("npc2");
  const werewolf = game.getPlayer("npc1");
  seer.suspicionScores = { npc1: 0, npc3: 5, npc4: 0, npc5: 0 };
  werewolf.suspicionScores = { npc2: 0, npc3: -5, npc4: 0, npc5: 0 };
  game.runNight();

  assert.equal(game.getPlayer("npc3").alive, false);
  assert.ok(seer.knownInfo.some((info) => info.type === "seer_result" && info.targetId === "npc3"));
  assert.equal(seer.publicClaims.length, 0);
  assert.equal(claimLines(game).length, 0);
  assert.equal(game.emitProactiveSeerClaim(), null);
});
