import assert from "node:assert/strict";
import test from "node:test";

import { NpcReactionCandidateProviderError } from "../src/npcReactionCandidateProvider.mjs";
import { NpcStructuredReactionRouteInvariantError } from "../src/npcStructuredReactionRoute.mjs";
import { createRouteFixture, successTransport } from "./helpers/npcStructuredReactionRouteFixtures.mjs";

function activeTimerCount(value) {
  return value.timers.filter((timer) => timer.cancelled !== true).length;
}

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

test("monotonic clock failures leave planning unpublished and allow a second execution", async (t) => {
  const cases = [
    ["throw", () => { throw new Error("clock"); }],
    ["NaN", () => Number.NaN],
    ["negative", () => -1],
    ["deadline overflow", () => Number.MAX_SAFE_INTEGER - 100]
  ];
  for (const [name, firstValue] of cases) {
    await t.test(name, async () => {
      let first = true;
      const value = createRouteFixture({
        nowMonotonicMs() {
          if (first) { first = false; return firstValue(); }
          return 0;
        }
      });
      const version = value.game.state.stateVersion;
      await assert.rejects(
        () => value.route.executeStructuredReaction(value.trigger),
        NpcStructuredReactionRouteInvariantError
      );
      assert.equal(value.game.state.stateVersion, version);
      assert.equal(value.calls.transport, 0);
      assert.equal(activeTimerCount(value), 0);
      assert.equal((await value.route.executeStructuredReaction(value.trigger)).status, "committed");
    });
  }
});

test("timer registration failures invalidate pre-publication callbacks and do not wedge the route", async (t) => {
  const cases = [
    ["throw", "throw"],
    ["undefined", undefined],
    ["null", null]
  ];
  for (const [name, failure] of cases) {
    await t.test(name, async () => {
      let registration = 0;
      let staleCallback;
      const value = createRouteFixture({
        scheduleTimer(callback, delayMs, timers) {
          registration += 1;
          if (registration === 1) {
            staleCallback = callback;
            if (failure === "throw") throw new Error("schedule");
            return failure;
          }
          const handle = { callback, delayMs, cancelled: false };
          timers.push(handle);
          return handle;
        }
      });
      const version = value.game.state.stateVersion;
      await assert.rejects(
        () => value.route.executeStructuredReaction(value.trigger),
        NpcStructuredReactionRouteInvariantError
      );
      staleCallback();
      await Promise.resolve();
      assert.equal(value.game.state.stateVersion, version);
      assert.equal(value.calls.transport, 0);
      assert.equal(activeTimerCount(value), 0);
      assert.equal((await value.route.executeStructuredReaction(value.trigger)).status, "committed");
      staleCallback();
      assert.equal(value.game.state.stateVersion, version + 1);
    });
  }
});

test("observer exceptions after publication are isolated and do not retain the active operation", async () => {
  const value = createRouteFixture({ observer() { throw new Error("observer"); } });
  const committed = await value.route.executeStructuredReaction(value.trigger);
  assert.equal(committed.status, "committed");
  assert.equal(activeTimerCount(value), 0);
  assert.equal((await value.route.executeStructuredReaction(value.trigger)).status, "replayed");
});

test("malformed provider boundary closes the operation and a later execution can commit", async () => {
  let invocation = 0;
  const value = createRouteFixture({
    transport(request) {
      invocation += 1;
      if (invocation === 1) return { schemaVersion: 1, status: "success", unknown: true };
      return successTransport(request);
    }
  });
  const version = value.game.state.stateVersion;
  const rejected = await value.route.executeStructuredReaction(value.trigger);
  assert.equal(rejected.status, "rejected");
  assert.equal(value.game.state.stateVersion, version);
  assert.equal(activeTimerCount(value), 0);
  assert.equal((await value.route.executeStructuredReaction(value.trigger)).status, "committed");
  assert.equal(value.calls.transport, 2);
});

test("malformed authority read after attempt start is terminalized without retaining active state", async () => {
  const value = createRouteFixture({
    readResult(result, _input, calls) {
      return calls.read === 2 ? { schemaVersion: 1, status: "unknown" } : result;
    }
  });
  const version = value.game.state.stateVersion;
  await assert.rejects(
    () => value.route.executeStructuredReaction(value.trigger),
    NpcStructuredReactionRouteInvariantError
  );
  assert.equal(value.game.state.stateVersion, version);
  assert.equal(value.calls.transport, 1);
  assert.equal(value.calls.commit, 0);
  assert.equal(activeTimerCount(value), 0);
  assert.equal((await value.route.executeStructuredReaction(value.trigger)).status, "committed");
});

test("malformed atomic commit result recovers the Coordinator and permits a later commit", async () => {
  let first = true;
  const value = createRouteFixture({
    commitOverride() {
      if (!first) return undefined;
      first = false;
      return { schemaVersion: 1, status: "unknown" };
    }
  });
  const version = value.game.state.stateVersion;
  await assert.rejects(
    () => value.route.executeStructuredReaction(value.trigger),
    NpcStructuredReactionRouteInvariantError
  );
  assert.equal(value.game.state.stateVersion, version);
  assert.equal(value.calls.commit, 1);
  assert.equal(activeTimerCount(value), 0);
  assert.equal((await value.route.executeStructuredReaction(value.trigger)).status, "committed");
  assert.equal(value.calls.commit, 2);
});
