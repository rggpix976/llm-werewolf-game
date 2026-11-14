import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

function village9(provider = new PseudoResponseProvider()) {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: provider });
}

function prepareProactive(game, seerTarget = "npc7") {
  const seer = game.getPlayer("npc3");
  const wolf = game.getPlayer("npc1");
  const knight = game.getPlayer("npc5");
  seer.suspicionScores = { [seerTarget]: 100 };
  wolf.suspicionScores = { npc9: 100 };
  knight.suspicionScores = { npc8: 100 };
}

function decisions(game, kind = "werewolf_seer_decision") {
  return game.state.developerLog.filter((entry) => entry.kind === kind);
}

test("W-A precedes the madman decision and both counter-claims are registered", async () => {
  const game = village9();
  prepareProactive(game, "npc1");
  await game.runNight();

  const kinds = game.state.developerLog.map((entry) => entry.kind);
  assert.ok(kinds.indexOf("werewolf_seer_decision") < kinds.indexOf("madman_seer_decision"));
  assert.equal(game.getPlayer("npc1").publicClaims[0].role, "seer");
  assert.equal(game.getPlayer("npc6").publicClaims[0].role, "seer");
  assert.deepEqual(game.getPlayer("npc1").publicClaims[0].results, [{ targetId: "npc1", result: "not_werewolf" }]);
});

test("werewolf black fabrication skips the other werewolf for the next eligible player", async () => {
  const game = village9();
  prepareProactive(game);
  const wolf = game.getPlayer("npc1");
  wolf.suspicionScores = { npc2: 100, npc8: 90, npc9: 80 };
  await game.runNight();
  assert.deepEqual(wolf.publicClaims[0].results, [{ targetId: "npc8", result: "werewolf" }]);
});

test("W-B offers the living claimant a one-result follow-up before the madman", async () => {
  const game = village9();
  prepareProactive(game);
  await game.runNight();
  const wolf = game.getPlayer("npc1");
  const seer = game.getPlayer("npc3");
  seer.knownInfo.push({ day: 2, type: "seer_result", visibility: "private", shareable: false, targetId: "npc8", result: "not_werewolf" });
  const claim = game.emitProactiveSeerClaim();
  await game.resolveWerewolfSeerDecision(claim);
  await game.resolveMadmanSeerDecision(claim);
  assert.equal(wolf.publicClaims.length, 2);
  assert.equal(wolf.publicClaims[1].results.length, 1);
  assert.equal(decisions(game).at(-1).detail.decisionPoint, "follow_up_publication");
});

test("W-C claims after the seer dies before day start and fabricates D-1 results", async () => {
  const game = village9();
  const seer = game.getPlayer("npc3");
  seer.suspicionScores = { npc7: 100 };
  game.getPlayer("npc1").suspicionScores = { npc3: -100, npc8: 90 };
  game.getPlayer("npc5").suspicionScores = { npc8: 100 };
  await game.runNight();

  assert.equal(seer.alive, false);
  const wolfClaim = game.getPlayer("npc1").publicClaims[0];
  assert.equal(wolfClaim.results.length, game.state.day - 1);
  assert.deepEqual(wolfClaim.results.at(-1), { targetId: "npc8", result: "werewolf" });
  assert.equal(decisions(game)[0].detail.decisionPoint, "uncontested_first_claim");
  assert.equal(decisions(game, "madman_seer_decision").length, 0);
});

test("W-C request contains only public context and the acting werewolf's own private role", async () => {
  let captured;
  const provider = { name: "capture", async chooseAction(request) { captured = request; return { choiceId: "stay_silent" }; } };
  const game = village9(provider);
  game.state.day = 2;
  await game.resolveWerewolfSeerDecision(null);
  const serialized = JSON.stringify(captured);
  assert.equal(captured.private.role, "werewolf");
  assert.equal(captured.context.publicSituation, "no seer claim has been made yet");
  assert.equal("triggeringClaim" in captured.context, false);
  assert.equal(serialized.includes("hiddenInfo"), false);
  assert.equal(serialized.includes("knownInfo"), false);
  assert.equal(serialized.includes("seer is dead"), false);
  assert.equal(serialized.includes("npc2\""), false);
});

for (const [label, provider, reason] of [
  ["explicit silence", { name: "silent", async chooseAction() { return { choiceId: "stay_silent" }; } }, null],
  ["unknown choice", { name: "invalid", async chooseAction() { return { choiceId: "dance" }; } }, "invalid_choice"],
  ["provider error", { name: "throwing", async chooseAction() { throw new Error("no"); } }, "provider_error"],
  ["missing method", { name: "missing" }, "method_missing"]
]) {
  test(`W-C ${label} safely stays silent`, async () => {
    const game = village9(provider);
    game.state.day = 2;
    await game.resolveWerewolfSeerDecision(null);
    assert.equal(game.getPlayer("npc1").publicClaims.length, 0);
    assert.equal(decisions(game)[0].detail.choiceId, "stay_silent");
    assert.equal(decisions(game)[0].detail.fallbackReason, reason);
  });
}

test("only the first living werewolf is offered and no second claim follows", async () => {
  const offered = [];
  const provider = { name: "capture", async chooseAction(request) { offered.push(request.npc.id); return { choiceId: "claim_seer" }; } };
  const game = village9(provider);
  game.getPlayer("npc1").alive = false;
  game.state.alivePlayers = game.state.alivePlayers.filter((id) => id !== "npc1");
  game.state.deadPlayers.push("npc1");
  game.state.day = 2;
  await game.resolveWerewolfSeerDecision(null);
  await game.resolveWerewolfSeerDecision(null);
  assert.deepEqual(offered, ["npc2"]);
  assert.equal(game.getPlayer("npc2").publicClaims.length, 1);
  assert.equal(game.getPlayer("npc1").publicClaims.length, 0);
});

test("an existing public seer claim suppresses W-C and day one has no decision", async () => {
  const game = village9();
  assert.equal(decisions(game).length, 0);
  game.getPlayer("npc6").publicClaims.push({ day: 1, actorId: "npc6", role: "seer", results: [] });
  game.state.day = 2;
  if (!game.hasPublicSeerClaim()) await game.resolveWerewolfSeerDecision(null);
  assert.equal(decisions(game).length, 0);
});

test("a madman fake claim does not itself trigger a werewolf decision", async () => {
  const game = village9();
  game.state.day = 2;
  await game.resolveMadmanSeerDecision({ results: [{ targetId: "npc7", result: "not_werewolf" }] });
  assert.equal(decisions(game).length, 0);
});

test("default five-player games never offer werewolf decisions", async () => {
  const game = WerewolfGame.create({ seed: 9, shuffleRoles: false });
  await game.runNight();
  assert.equal(decisions(game).length, 0);
});
