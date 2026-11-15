import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";

// D-021: when the triggering claim's newest result is a werewolf result on
// the deciding player himself, the seer-claim decision offers two claim
// shapes (accuse / deny) plus silence, and the fabricated claim never
// contains a result about the claimant (a real seer cannot divine
// themselves). Fixed village9 roles: npc1/npc2 werewolf, npc3 seer,
// npc6 madman.

function village9(provider) {
  return WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: provider });
}

function stubProvider(choiceId, captured) {
  return {
    name: "stub",
    async chooseAction(request) {
      captured?.push(request);
      return { choiceId };
    }
  };
}

function blackOn(targetId, actorId = "npc3") {
  return { day: 2, actorId, actorName: "Chika", role: "seer", results: [{ targetId, result: "werewolf" }] };
}

function decisions(game, kind) {
  return game.state.developerLog.filter((entry) => entry.kind === kind);
}

test("self-blacked counter decision offers accuse, deny and silence", async () => {
  const captured = [];
  const game = village9(stubProvider("stay_silent", captured));
  game.state.day = 2;
  await game.resolveMadmanSeerDecision(blackOn("npc6"));
  assert.deepEqual(captured[0].candidates.map(({ id }) => id), ["counter_claim_accuse", "counter_claim_deny", "stay_silent"]);
  assert.equal(captured[0].decisionPoint, "first_counter_claim");
  assert.equal(captured[0].private.role, "madman");
});

test("a black on someone else keeps the legacy two candidates", async () => {
  const captured = [];
  const game = village9(stubProvider("stay_silent", captured));
  game.state.day = 2;
  await game.resolveMadmanSeerDecision(blackOn("npc7"));
  assert.deepEqual(captured[0].candidates.map(({ id }) => id), ["counter_claim", "stay_silent"]);
});

test("madman accuse blacks the accuser and never himself", async () => {
  const game = village9(stubProvider("counter_claim_accuse"));
  game.state.day = 2;
  const claim = await game.resolveMadmanSeerDecision(blackOn("npc6"));
  assert.deepEqual(claim.results, [{ targetId: "npc3", result: "werewolf" }]);
  assert.equal(claim.results.some(({ targetId }) => targetId === "npc6"), false);
});

test("madman deny publishes whites only, excluding himself and the accuser", async () => {
  const game = village9(stubProvider("counter_claim_deny"));
  game.state.day = 3;
  const claim = await game.resolveMadmanSeerDecision(blackOn("npc6"));
  assert.equal(claim.results.length, 2);
  assert.ok(claim.results.every(({ result }) => result === "not_werewolf"));
  assert.equal(claim.results.some(({ targetId }) => targetId === "npc6" || targetId === "npc3"), false);
  assert.deepEqual(claim.results.map(({ targetId }) => targetId), ["npc1", "npc2"]);
});

test("werewolf accuse after the seer blacked him blacks the seer", async () => {
  const game = village9(stubProvider("counter_claim_accuse"));
  game.state.day = 2;
  const claim = await game.resolveWerewolfSeerDecision(blackOn("npc1"));
  assert.deepEqual(claim.results, [{ targetId: "npc3", result: "werewolf" }]);
  assert.equal(decisions(game, "werewolf_seer_decision")[0].detail.choiceId, "counter_claim_accuse");
});

test("werewolf deny publishes a white result away from the accuser", async () => {
  const game = village9(stubProvider("counter_claim_deny"));
  game.state.day = 2;
  const claim = await game.resolveWerewolfSeerDecision(blackOn("npc1"));
  assert.deepEqual(claim.results, [{ targetId: "npc2", result: "not_werewolf" }]);
});

test("follow-up accuse adds a black result on the accuser", async () => {
  const game = village9(stubProvider("publish_more_accuse"));
  game.getPlayer("npc6").publicClaims.push({ day: 2, actorId: "npc6", actorName: "Fumi", role: "seer", results: [{ targetId: "npc9", result: "not_werewolf" }] });
  game.state.day = 3;
  const claim = await game.resolveMadmanSeerDecision(blackOn("npc6"));
  assert.deepEqual(claim.results, [{ targetId: "npc3", result: "werewolf" }]);
});

test("follow-up deny adds one white away from the accuser and prior targets", async () => {
  const game = village9(stubProvider("publish_more_deny"));
  game.getPlayer("npc6").publicClaims.push({ day: 2, actorId: "npc6", actorName: "Fumi", role: "seer", results: [{ targetId: "npc9", result: "not_werewolf" }] });
  game.state.day = 3;
  const claim = await game.resolveMadmanSeerDecision(blackOn("npc6"));
  assert.deepEqual(claim.results, [{ targetId: "npc1", result: "not_werewolf" }]);
});

test("werewolf follow-up on a self black offers the accuse/deny pair", async () => {
  const captured = [];
  const game = village9(stubProvider("stay_silent", captured));
  game.getPlayer("npc1").publicClaims.push({ day: 2, actorId: "npc1", actorName: "Aoi", role: "seer", results: [{ targetId: "npc9", result: "not_werewolf" }] });
  game.state.day = 3;
  await game.resolveWerewolfSeerDecision(blackOn("npc1"));
  assert.deepEqual(captured[0].candidates.map(({ id }) => id), ["publish_more_accuse", "publish_more_deny", "stay_silent"]);
  assert.equal(captured[0].decisionPoint, "follow_up_publication");
});

test("the legacy choice id is invalid in the self-blacked candidate set", async () => {
  const game = village9(stubProvider("counter_claim"));
  game.state.day = 2;
  const claim = await game.resolveMadmanSeerDecision(blackOn("npc6"));
  assert.equal(claim, null);
  const log = decisions(game, "madman_seer_decision")[0];
  assert.equal(log.detail.choiceId, "stay_silent");
  assert.equal(log.detail.fallbackReason, "invalid_choice");
  assert.equal(game.getPlayer("npc6").publicClaims.length, 0);
});
