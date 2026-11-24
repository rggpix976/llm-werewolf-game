import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

// D-023: the medium proactively publishes only in a decisive situation —
// an executed player who had been blacked by a public seer claim while the
// medium still holds that result unpublished. Fixed village9 roles:
// npc1/npc2 werewolf, npc3 seer, npc4 medium, npc7 citizen.

function village9(provider) {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: provider });
}

function addSeerClaim(game, results, day = 1) {
  const seer = game.getPlayer("npc3");
  const claim = { day, actorId: "npc3", actorName: "冴島大河", role: "seer", results };
  seer.publicClaims.push(claim);
  game.state.publicInfo.push({ type: "public_claim", actorId: "npc3", actorName: "冴島大河", text: "冴島大河が占い師COをした。", claim });
  return claim;
}

function executeAndRecord(game, playerId) {
  const executed = game.getPlayer(playerId);
  game.killPlayer(playerId, "execution");
  game.recordMediumResults(executed);
}

function stub(choiceId, captured) {
  return {
    name: "stub",
    async chooseAction(request) {
      captured?.push(request);
      return { choiceId };
    }
  };
}

function decisions(game) {
  return game.state.developerLog.filter((entry) => entry.kind === "medium_claim_decision");
}

test("a white result on a seer-blacked executee is published proactively", async () => {
  const game = village9(new PseudoResponseProvider());
  addSeerClaim(game, [{ targetId: "npc7", result: "werewolf" }]);
  executeAndRecord(game, "npc7");
  game.state.day = 2;
  const claim = await game.resolveMediumClaimDecision();
  assert.equal(claim.role, "medium");
  assert.deepEqual(claim.results, [{ targetId: "npc7", result: "not_werewolf" }]);
  assert.equal(game.getPlayer("npc4").publicClaims.length, 1);
  const line = game.state.playerLog.find((entry) => entry.message.startsWith("堂島大吾: 霊媒師CO"))?.message ?? "";
  assert.match(line, /足立宏一は人狼ではありませんでした/);
  assert.equal(decisions(game)[0].detail.choiceId, "claim_medium");
  assert.equal(decisions(game)[0].detail.fallbackReason, null);
});

test("a black result corroborating the seer claim is published proactively", async () => {
  const game = village9(new PseudoResponseProvider());
  addSeerClaim(game, [{ targetId: "npc1", result: "werewolf" }]);
  executeAndRecord(game, "npc1");
  game.state.day = 2;
  const claim = await game.resolveMediumClaimDecision();
  assert.deepEqual(claim.results, [{ targetId: "npc1", result: "werewolf" }]);
  const line = game.state.playerLog.find((entry) => entry.message.startsWith("堂島大吾: 霊媒師CO"))?.message ?? "";
  assert.match(line, /桐生一馬は人狼でした/);
});

test("no decision when the executee was never blacked by a seer claim", async () => {
  const captured = [];
  const game = village9(stub("claim_medium", captured));
  addSeerClaim(game, [{ targetId: "npc8", result: "werewolf" }]);
  executeAndRecord(game, "npc7");
  game.state.day = 2;
  assert.equal(await game.resolveMediumClaimDecision(), null);
  assert.equal(captured.length, 0);
  assert.equal(decisions(game).length, 0);
  assert.equal(game.getPlayer("npc4").publicClaims.length, 0);
});

test("no decision without any seer claim, and none once the result is public", async () => {
  const captured = [];
  const game = village9(stub("claim_medium", captured));
  executeAndRecord(game, "npc7");
  game.state.day = 2;
  assert.equal(await game.resolveMediumClaimDecision(), null);
  assert.equal(captured.length, 0);

  addSeerClaim(game, [{ targetId: "npc7", result: "werewolf" }]);
  const claim = await game.resolveMediumClaimDecision();
  assert.equal(claim.role, "medium");
  assert.equal(captured.length, 1);
  // The decisive result is now published, so the next morning stays quiet.
  assert.equal(await game.resolveMediumClaimDecision(), null);
  assert.equal(captured.length, 1);
});

test("a seer claim registered after the execution does not trigger the decision", async () => {
  const captured = [];
  const game = village9(stub("claim_medium", captured));
  executeAndRecord(game, "npc7");
  addSeerClaim(game, [{ targetId: "npc7", result: "werewolf" }], 2);
  game.state.day = 2;
  assert.equal(await game.resolveMediumClaimDecision(), null);
  assert.equal(captured.length, 0);
});

test("staying silent and provider failures keep the result unpublished", async () => {
  const silent = village9(stub("stay_silent"));
  addSeerClaim(silent, [{ targetId: "npc7", result: "werewolf" }]);
  executeAndRecord(silent, "npc7");
  silent.state.day = 2;
  assert.equal(await silent.resolveMediumClaimDecision(), null);
  assert.equal(decisions(silent)[0].detail.choiceId, "stay_silent");
  assert.equal(silent.getPlayer("npc4").publicClaims.length, 0);

  const throwing = village9({ name: "throwing", async chooseAction() { throw new Error("no"); } });
  addSeerClaim(throwing, [{ targetId: "npc7", result: "werewolf" }]);
  executeAndRecord(throwing, "npc7");
  throwing.state.day = 2;
  assert.equal(await throwing.resolveMediumClaimDecision(), null);
  assert.equal(decisions(throwing)[0].detail.fallbackReason, "provider_error");
  assert.equal(throwing.getPlayer("npc4").publicClaims.length, 0);
});

test("a dead medium gets no decision", async () => {
  const captured = [];
  const game = village9(stub("claim_medium", captured));
  addSeerClaim(game, [{ targetId: "npc7", result: "werewolf" }]);
  executeAndRecord(game, "npc7");
  game.killPlayer("npc4", "werewolf_attack");
  game.state.day = 2;
  assert.equal(await game.resolveMediumClaimDecision(), null);
  assert.equal(captured.length, 0);
});

test("the decision request is village-aligned for the medium and privacy-safe", async () => {
  const captured = [];
  const game = village9(stub("stay_silent", captured));
  addSeerClaim(game, [{ targetId: "npc7", result: "werewolf" }]);
  executeAndRecord(game, "npc7");
  game.state.day = 2;
  await game.resolveMediumClaimDecision();
  const request = captured[0];
  assert.equal(request.decisionPoint, "medium_proactive_claim");
  assert.equal(request.private.role, "medium");
  assert.deepEqual(request.private.goals, ["村を守る", "真実の霊媒結果を適切に公開する"]);
  assert.deepEqual(request.candidates.map(({ id }) => id), ["claim_medium", "stay_silent"]);
  const serialized = JSON.stringify(request);
  assert.equal(serialized.includes("hiddenInfo"), false);
  assert.equal(serialized.includes("knownInfo"), false);
});

test("runNight publishes the medium result on the decisive morning", async () => {
  const game = village9(new PseudoResponseProvider());
  addSeerClaim(game, [{ targetId: "npc7", result: "werewolf" }], 1);
  for (const voter of game.getAlivePlayers()) voter.suspicionScores = { npc7: 9, npc9: 1 };
  await game.dispatchPlayerAction({ type: "advance_vote" });
  assert.equal(game.getPlayer("npc7").alive, false);

  game.getPlayer("npc3").suspicionScores = { npc8: 100 };
  game.getPlayer("npc1").suspicionScores = { npc9: -5 };
  game.getPlayer("npc5").suspicionScores = { npc1: -5 };
  await game.dispatchPlayerAction({ type: "run_night" });

  const medium = game.getPlayer("npc4");
  assert.equal(medium.publicClaims.length, 1);
  assert.deepEqual(medium.publicClaims[0].results, [{ targetId: "npc7", result: "not_werewolf" }]);
  assert.equal(decisions(game).length, 1);
});

test("default five-player games never offer the medium decision", async () => {
  const game = WerewolfGame.create({ seed: 9, responseProvider: stub("claim_medium") });
  assert.equal(await game.resolveMediumClaimDecision(), null);
  assert.equal(decisions(game).length, 0);
});
