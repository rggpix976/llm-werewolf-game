import assert from "node:assert/strict";
import test from "node:test";

import * as api from "../src/npcStructuredReactionRoute.mjs";
import {
  NpcStructuredReactionRouteError,
  createNpcStructuredReactionRoute
} from "../src/npcStructuredReactionRoute.mjs";
import { createRouteFixture } from "./helpers/npcStructuredReactionRouteFixtures.mjs";

test("route module and factory expose only the closed public surfaces", () => {
  assert.deepEqual(Object.keys(api).sort(), [
    "NPC_STRUCTURED_REACTION_ROUTE_ERROR_CODES",
    "NPC_STRUCTURED_REACTION_ROUTE_INVARIANT_CODES",
    "NpcStructuredReactionRouteError",
    "NpcStructuredReactionRouteInvariantError",
    "createNpcStructuredReactionRoute"
  ].sort());
  const value = createRouteFixture();
  assert.deepEqual(Object.keys(value.route).sort(), [
    "cancelStructuredReaction", "executeStructuredReaction", "reset", "retryPendingCoordinatorCleanup"
  ].sort());
  assert.ok(Object.isFrozen(value.route));
});

test("factory and trigger validation reject unknown, accessor and foreign-session inputs before authority read", async () => {
  const value = createRouteFixture();
  const invalid = [
    { ...value.trigger, extra: true },
    { ...value.trigger, schemaVersion: 2 },
    { ...value.trigger, gameSessionId: "foreign-session" }
  ];
  for (const trigger of invalid) {
    await assert.rejects(() => value.route.executeStructuredReaction(trigger), NpcStructuredReactionRouteError);
  }
  const accessor = { ...value.trigger };
  Object.defineProperty(accessor, "triggerRequestId", { enumerable: true, get() { throw new Error("getter"); } });
  await assert.rejects(() => value.route.executeStructuredReaction(accessor), NpcStructuredReactionRouteError);
  assert.equal(value.calls.read, 0);
  assert.throws(() => createNpcStructuredReactionRoute({}), NpcStructuredReactionRouteError);
});

test("raw malformed transport is rejected without authoritative mutation or provider retry", async () => {
  const value = createRouteFixture({
    transport: async () => ({
      schemaVersion: 1,
      status: "success",
      transportEvidence: {
        schemaVersion: 1,
        evidenceType: "npc_reaction_candidate_http_success",
        httpStatus: 200,
        contentTypeHeader: "application/json; charset=utf-8",
        contentEncodingHeader: null,
        bodyBytes: new TextEncoder().encode("{")
      }
    })
  });
  const version = value.game.state.stateVersion;
  const result = await value.route.executeStructuredReaction(value.trigger);
  assert.equal(result.status, "rejected");
  assert.equal(result.stage, "candidate_validation");
  assert.equal(value.calls.transport, 1);
  assert.equal(value.calls.commit, 0);
  assert.equal(value.game.state.stateVersion, version);
});

test("same and different triggers are bounded by one active operation", async () => {
  let resolveTransport;
  const value = createRouteFixture({ transport: () => new Promise((resolve) => { resolveTransport = resolve; }) });
  const first = value.route.executeStructuredReaction(value.trigger);
  await Promise.resolve();
  const same = await value.route.executeStructuredReaction(value.trigger);
  const different = await value.route.executeStructuredReaction({ ...value.trigger, triggerRequestId: "other-request" });
  assert.equal(same.status, "in_progress");
  assert.equal(different.status, "in_progress");
  const cancelled = value.route.cancelStructuredReaction(value.trigger);
  assert.equal(cancelled.status, "cancelled");
  resolveTransport?.({});
  assert.equal((await first).status, "cancelled");
  assert.equal(value.calls.transport, 1);
});
