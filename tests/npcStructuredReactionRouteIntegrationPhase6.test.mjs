import assert from "node:assert/strict";
import test from "node:test";

import { createRouteFixture, successTransport } from "./helpers/npcStructuredReactionRouteFixtures.mjs";

test("rewritten route commits through the exact engine-owned authority port and cleans Coordinator state", async () => {
  const value = createRouteFixture();
  const beforeVersion = value.game.state.stateVersion;
  const result = await value.route.executeStructuredReaction(value.trigger);
  assert.equal(result.status, "committed");
  assert.equal(result.attemptCount, 1);
  assert.equal(value.game.state.stateVersion, beforeVersion + 1);
  assert.equal(value.calls.transport, 1);
  assert.equal(value.calls.commit, 1);
  assert.equal(value.game.state.conversation.reactionPlans.length, 1);
  assert.equal(value.game.state.conversation.npcReactionCommitIdempotencyRecords.length, 1);
  assert.ok(Object.isFrozen(result));
  assert.equal(JSON.stringify(result).includes("candidateFingerprint"), false);
  assert.equal(JSON.stringify(result).includes("coordinatorCleanupHandoff"), false);
  const readCalls = value.calls.read;
  const repeatedCleanup = value.route.retryPendingCoordinatorCleanup({
    schemaVersion: 1,
    gameSessionId: value.game.state.gameSessionId,
    reactionPlanId: result.reactionPlanId
  });
  assert.deepEqual(repeatedCleanup, {
    schemaVersion: 1,
    status: "already_cleaned",
    reactionPlanId: result.reactionPlanId
  });
  assert.equal(value.calls.read, readCalls + 1);
});

test("authoritative replay short-circuits provider, validation preparation and commit", async () => {
  const value = createRouteFixture();
  const committed = await value.route.executeStructuredReaction(value.trigger);
  const before = { ...value.calls };
  const replayed = await value.route.executeStructuredReaction(value.trigger);
  assert.equal(committed.status, "committed");
  assert.equal(replayed.status, "replayed");
  assert.equal(Object.hasOwn(replayed, "attemptCount"), false);
  assert.equal(value.calls.transport, before.transport);
  assert.equal(value.calls.commit, before.commit);
  assert.equal(value.calls.read, before.read + 1);
});

test("stale authority read exits before ID allocation and transport", async () => {
  let ids = 0;
  const value = createRouteFixture({ createId: () => { ids += 1; return `route-${ids}`; } });
  value.game.state.stateVersion += 1;
  const result = await value.route.executeStructuredReaction(value.trigger);
  assert.equal(result.status, "superseded");
  assert.equal(result.stage, "preflight");
  assert.equal(ids, 0);
  assert.equal(value.calls.transport, 0);
  assert.equal(value.calls.commit, 0);
});

test("Coordinator cleanup failure retains the authoritative commit and exposes only pending status", async () => {
  const value = createRouteFixture({
    commitResult(result) {
      const changed = structuredClone(result);
      changed.coordinatorCleanupHandoff.successfulAttemptId = "different-attempt";
      return changed;
    }
  });
  const beforeVersion = value.game.state.stateVersion;
  const result = await value.route.executeStructuredReaction(value.trigger);
  assert.equal(result.status, "committed_cleanup_pending");
  assert.equal(result.cleanupStatus, "pending");
  assert.equal(value.game.state.stateVersion, beforeVersion + 1);
  assert.equal(JSON.stringify(result).includes("successfulAttemptId"), false);
  assert.equal(JSON.stringify(result).includes("preparationFingerprint"), false);
  assert.throws(() => value.route.retryPendingCoordinatorCleanup({
    schemaVersion: 1,
    gameSessionId: value.game.state.gameSessionId,
    reactionPlanId: result.reactionPlanId
  }));
});

test("fresh applicability rejects same-version authority drift without overwriting it", async () => {
  let value;
  value = createRouteFixture({
    transport: async (request) => {
      value.game.state.players.find((player) => player.id === "npc-aoi").conversationPolicy.roleClaim = "never_confess_werewolf";
      return successTransport(request);
    }
  });
  const version = value.game.state.stateVersion;
  const result = await value.route.executeStructuredReaction(value.trigger);
  assert.equal(result.status, "superseded");
  assert.equal(result.stage, "candidate_validation");
  assert.equal(value.game.state.stateVersion, version);
  assert.equal(value.game.state.players.find((player) => player.id === "npc-aoi").conversationPolicy.roleClaim, "never_confess_werewolf");
  assert.equal(value.calls.commit, 0);
});
