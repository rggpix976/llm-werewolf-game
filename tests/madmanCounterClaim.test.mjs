import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

function gameWith(provider = new PseudoResponseProvider()) {
  const game = WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: provider });
  const seer = game.getPlayer("npc3");
  const madman = game.getPlayer("npc6");
  // The seer checks a living player and the first wolf attacks someone else.
  for (const player of game.state.players) {
    seer.suspicionScores[player.id] = player.id === "npc1" ? 100 : 0;
    game.getPlayer("npc1").suspicionScores[player.id] = player.id === "npc9" ? 100 : 0;
    madman.suspicionScores[player.id] = player.id === "npc8" ? 100 : 0;
  }
  return game;
}

test("pseudo choice registers a private-engine fabricated counter claim", async () => {
  const game = gameWith();
  await game.runNight();
  const madman = game.getPlayer("npc6");
  assert.equal(madman.publicClaims.length, 1);
  const claim = madman.publicClaims[0];
  assert.deepEqual(claim.results, [{ targetId: "npc1", result: "not_werewolf" }]);
  assert.equal(game.state.publicInfo.some((info) => info.type === "public_claim" && info.actorId === madman.id && info.claim.role === "seer"), true);
  assert.match(game.state.playerLog.find((entry) => entry.message.startsWith("Fumi: 占い師CO"))?.message ?? "", /Aoiは人狼ではない判定/);
  assert.equal(madman.privateMemory.at(-1).type, "fabricated_seer_claim");
  assert.equal(JSON.stringify(game.getPublicSnapshot()).includes("fabricated"), false);
});

test("decision request is frozen and contains only self-private role information", async () => {
  let captured;
  const provider = { name: "capture", async generateResponse() {}, async chooseAction(request) { captured = request; return { choiceId: "stay_silent" }; } };
  const game = gameWith(provider);
  await game.runNight();
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(captured.private.role, "madman");
  const serialized = JSON.stringify(captured);
  assert.equal(serialized.includes("hiddenInfo"), false);
  assert.equal(serialized.includes("knownInfo"), false);
  assert.equal(serialized.includes('"role":"werewolf"'), false);
  assert.equal(game.getPlayer("npc6").publicClaims.length, 0);
});

for (const [label, provider, reason] of [
  ["unknown choice", { name: "invalid", async chooseAction() { return { choiceId: "dance" }; } }, "invalid_choice"],
  ["provider error", { name: "throwing", async chooseAction() { throw new Error("no"); } }, "provider_error"],
  ["missing method", { name: "missing" }, "method_missing"]
]) {
  test(`${label} falls back to silence and keeps the game running`, async () => {
    const game = gameWith(provider);
    await game.runNight();
    assert.equal(game.getPlayer("npc6").publicClaims.length, 0);
    const log = game.state.developerLog.find((entry) => entry.kind === "madman_seer_decision");
    assert.equal(log.detail.choiceId, "stay_silent");
    assert.equal(log.detail.fallbackReason, reason);
  });
}

test("a later proactive result offers publication and adds exactly one result", async () => {
  const game = gameWith();
  await game.runNight();
  const madman = game.getPlayer("npc6");
  assert.equal(madman.publicClaims.length, 1);
  // Drive the day-start decision directly after registering the seer's next legal publication;
  // runNight itself uses this same pair after the next night resolves.
  const seer = game.getPlayer("npc3");
  seer.knownInfo.push({ day: 2, type: "seer_result", visibility: "private", shareable: false, targetId: "npc7", result: "not_werewolf" });
  const triggering = game.emitProactiveSeerClaim();
  await game.resolveMadmanSeerDecision(triggering);
  assert.equal(madman.publicClaims.length, 2);
  assert.equal(madman.publicClaims[1].results.length, 1);
  assert.equal(madman.publicClaims[1].results[0].targetId, "npc8");
  assert.equal(madman.publicClaims[1].results[0].result, "werewolf");
});
