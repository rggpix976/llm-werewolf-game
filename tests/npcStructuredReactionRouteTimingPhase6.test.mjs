import assert from "node:assert/strict";
import test from "node:test";

import { NpcReactionCandidateProviderError } from "../src/npcReactionCandidateProvider.mjs";
import { createRouteFixture, successTransport } from "./helpers/npcStructuredReactionRouteFixtures.mjs";

test("retryable provider failures use fresh attempts and stop after a successful second attempt", async () => {
  let invocation = 0;
  const value = createRouteFixture({
    monotonic: 0,
    transport: async (request) => {
      invocation += 1;
      if (invocation === 1) throw new NpcReactionCandidateProviderError("network_failure", true);
      return successTransport(request);
    }
  });
  const pending = value.route.executeStructuredReaction(value.trigger);
  await new Promise((resolve) => setImmediate(resolve));
  const backoff = value.timers.find((timer) => timer.delayMs === 1000);
  assert.ok(backoff);
  backoff.callback();
  const result = await pending;
  assert.equal(result.status, "committed");
  assert.equal(result.attemptCount, 2);
  assert.equal(value.calls.transport, 2);
  assert.equal(value.calls.commit, 1);
});

test("logical deadline aborts a pending attempt and suppresses late fulfillment", async () => {
  let resolveTransport;
  const value = createRouteFixture({
    transport: () => new Promise((resolve) => { resolveTransport = resolve; })
  });
  const pending = value.route.executeStructuredReaction(value.trigger);
  await Promise.resolve();
  value.setMonotonic(15000);
  value.fire(0);
  resolveTransport?.({});
  const result = await pending;
  assert.equal(result.status, "exhausted");
  assert.equal(result.stage, "deadline");
  assert.equal(value.calls.commit, 0);
  assert.equal(value.game.state.conversation.reactionPlans.length, 0);
});

test("retry budget is exactly three attempts with no hidden fourth invocation", async () => {
  const value = createRouteFixture({
    transport: async () => { throw new NpcReactionCandidateProviderError("provider_unavailable", true); }
  });
  const pending = value.route.executeStructuredReaction(value.trigger);
  await new Promise((resolve) => setImmediate(resolve));
  value.timers.find((timer) => timer.delayMs === 1000 && !timer.cancelled).callback();
  await new Promise((resolve) => setImmediate(resolve));
  value.timers.find((timer) => timer.delayMs === 2000 && !timer.cancelled).callback();
  const result = await pending;
  assert.equal(result.status, "exhausted");
  assert.equal(result.attemptCount, 3);
  assert.equal(value.calls.transport, 3);
  assert.equal(value.calls.commit, 0);
});

test("synchronous timer callback is deferred until route publication", async () => {
  let resolveTransport;
  const value = createRouteFixture({
    synchronousTimer: true,
    monotonic: 0,
    transport: () => new Promise((resolve) => { resolveTransport = resolve; })
  });
  const pending = value.route.executeStructuredReaction(value.trigger);
  value.setMonotonic(15000);
  await Promise.resolve();
  resolveTransport?.({});
  const result = await pending;
  assert.equal(result.status, "exhausted");
  assert.equal(value.calls.transport, 1);
  assert.equal(value.calls.commit, 0);
});
