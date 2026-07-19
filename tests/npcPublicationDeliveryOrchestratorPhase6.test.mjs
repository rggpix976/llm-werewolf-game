import test from "node:test";
import assert from "node:assert/strict";
import * as module from "../src/npcPublicationDeliveryOrchestrator.mjs";
import { createNpcPublicationDeliveryOrchestrator } from "../src/npcPublicationDeliveryOrchestrator.mjs";
import { createNpcBrowserPublicationSink } from "../src/npcBrowserPublicationSink.mjs";
import { createDeliveryHarness } from "./helpers/npcPublicationDeliveryFixtures.mjs";
import { fakeDom } from "./helpers/npcPublicationSinkFixtures.mjs";

const SESSION = "game-session-1";

function routeResult(status = "committed") {
  const base = {
    schemaVersion: 1,
    resultType: "npc_structured_reaction_route",
    gameSessionId: SESSION,
    triggerRequestId: "trigger-1",
    originatingInputRecordId: "input-record-1",
    status
  };
  if (status === "committed") return Object.freeze({ ...base, reactionPlanId: "reaction-plan-1", requestId: "reaction-request-1", attemptCount: 1, commitResult: Object.freeze({ npcPublicationId: "wrong-hint" }) });
  if (status === "committed_cleanup_pending") return Object.freeze({ ...base, reactionPlanId: "reaction-plan-1", requestId: "reaction-request-1", attemptCount: 1, commitResult: Object.freeze({ npcPublicationId: "wrong-hint" }), cleanupStatus: "pending" });
  if (status === "replayed") return Object.freeze({ ...base, reactionPlanId: "reaction-plan-1", requestId: "reaction-request-1", commitResult: Object.freeze({ npcPublicationId: "npc-publication-1" }) });
  if (status === "in_progress") return Object.freeze({ ...base, activeReactionPlanId: "reaction-plan-1", activeRequestId: "reaction-request-1" });
  return Object.freeze({ ...base, stage: "preflight", reason: "not_eligible" });
}

function browserSink(dom = fakeDom()) {
  return createNpcBrowserPublicationSink({
    getConversationContainer: dom.getConversationContainer,
    createTextNode: dom.createTextNode,
    createMessageNode: dom.createMessageNode
  });
}

function exactController(controller, overrides = {}) {
  const value = {};
  for (const key of Object.keys(controller)) value[key] = overrides[key] ?? ((...args) => controller[key](...args));
  return Object.freeze(value);
}

function make({ harness = createDeliveryHarness(), sink = browserSink(), controller = null, observer = null } = {}) {
  let id = 0;
  const orchestrator = createNpcPublicationDeliveryOrchestrator({
    gameSessionId: SESSION,
    controller: controller ?? harness.controller,
    initialConsumer: { consumerId: "consumer-1", sinkType: "browser" },
    resolveSinkConsumer: ({ sinkType }) => {
      assert.equal(sinkType, "browser");
      return sink;
    },
    createId: () => `orchestrator-retry-${++id}`,
    observer
  });
  return { orchestrator, harness, sink };
}

test("module and factory expose exact closed public surfaces", () => {
  assert.deepEqual(Object.keys(module).sort(), [
    "NPC_PUBLICATION_DELIVERY_ORCHESTRATOR_ERROR_CODES",
    "NPC_PUBLICATION_DELIVERY_ORCHESTRATOR_RESULT_TYPES",
    "NpcPublicationDeliveryOrchestratorConfigurationError",
    "NpcPublicationDeliveryOrchestratorInvariantError",
    "createNpcPublicationDeliveryOrchestrator"
  ].sort());
  const { orchestrator } = make();
  assert.deepEqual(Object.keys(orchestrator), [
    "handleNpcStructuredRouteResult", "pumpPendingNpcPublications", "retryNpcPublicationDelivery",
    "replaceNpcPublicationDeliveryConsumer", "reset", "getPendingDeliverySummary"
  ]);
  assert.ok(Object.isFrozen(orchestrator));
});

test("factory and public inputs reject missing, extra, accessor, symbol, and custom prototype values", async () => {
  const { harness } = make();
  const valid = {
    gameSessionId: SESSION, controller: harness.controller,
    initialConsumer: { consumerId: "consumer-1", sinkType: "browser" },
    resolveSinkConsumer: () => browserSink(), createId: () => "retry-1", observer: null
  };
  for (const key of Object.keys(valid)) {
    const copy = { ...valid }; delete copy[key];
    assert.throws(() => createNpcPublicationDeliveryOrchestrator(copy), { name: "NpcPublicationDeliveryOrchestratorConfigurationError" });
  }
  assert.throws(() => createNpcPublicationDeliveryOrchestrator({ ...valid, extra: true }));
  assert.throws(() => createNpcPublicationDeliveryOrchestrator(Object.assign(Object.create({}), valid)));
  const accessor = { schemaVersion: 1, gameSessionId: SESSION };
  let called = 0;
  Object.defineProperty(accessor, "extra", { enumerable: true, get() { called += 1; return true; } });
  const { orchestrator } = make();
  await assert.rejects(orchestrator.pumpPendingNpcPublications(accessor));
  assert.equal(called, 0);
  const symbolic = { schemaVersion: 1, gameSessionId: SESSION, [Symbol("secret")]: true };
  await assert.rejects(orchestrator.pumpPendingNpcPublications(symbolic));
});

test("committed and cleanup-pending route results pump while publication hint is nonauthoritative", async () => {
  for (const status of ["committed", "committed_cleanup_pending"]) {
    const { orchestrator, harness } = make();
    const value = await orchestrator.handleNpcStructuredRouteResult({ schemaVersion: 1, gameSessionId: SESSION, routeResult: routeResult(status) });
    assert.equal(value.status, "delivered");
    assert.equal(value.publicationId, "npc-publication-1");
    assert.equal(harness.counts.graphReads > 0, true);
    assert.ok(Object.isFrozen(value));
  }
});

test("replay and every non-commit route outcome skip without discovery", async () => {
  for (const status of ["replayed", "rejected", "superseded", "cancelled", "exhausted", "in_progress"]) {
    const { orchestrator, harness } = make();
    const before = structuredClone(harness.authoritativeSnapshot);
    const value = await orchestrator.handleNpcStructuredRouteResult({ schemaVersion: 1, gameSessionId: SESSION, routeResult: routeResult(status) });
    assert.equal(value.status, "skipped_not_eligible");
    assert.equal(harness.counts.graphReads, 0);
    assert.deepEqual(harness.authoritativeSnapshot, before);
  }
});

test("explicit pump delivers and a subsequent pump returns pending_none", async () => {
  const { orchestrator, harness } = make();
  assert.equal((await orchestrator.pumpPendingNpcPublications({ schemaVersion: 1, gameSessionId: SESSION })).status, "delivered");
  assert.equal((await orchestrator.pumpPendingNpcPublications({ schemaVersion: 1, gameSessionId: SESSION })).status, "pending_none");
  assert.deepEqual(harness.graphs, harness.authoritativeSnapshot);
});

test("proved no-effect failure returns a private repeat-sink handle and explicit retry writes once", async () => {
  const harness = createDeliveryHarness();
  let calls = 0;
  const sink = Object.freeze({
    deliver(execution, controller) {
      calls += 1;
      if (calls === 1) return controller.recordNpcPublicationSinkFailure(execution.settlementCapability, {
        schemaVersion: 1, evidenceType: "npc_sink_failure_evidence", sinkType: "browser",
        failureCode: "browser_sink_attachment_failed", visibleEffect: "none", cleanupStatus: "complete"
      });
      return controller.completeNpcPublicationSink(execution.settlementCapability);
    },
    getAttachedDeliveryEvidence() { return null; },
    reset() {}
  });
  const { orchestrator } = make({ harness, sink });
  const first = await orchestrator.pumpPendingNpcPublications({ schemaVersion: 1, gameSessionId: SESSION });
  assert.equal(first.status, "retry_required");
  assert.equal(first.retryMode, "repeat_sink");
  assert.equal("retryToken" in first, false);
  const second = await orchestrator.retryNpcPublicationDelivery({ schemaVersion: 1, gameSessionId: SESSION, retryId: first.retryId });
  assert.equal(second.status, "delivered");
  assert.equal(calls, 2);
});

test("acknowledgement failure returns ack-only and retry never calls the sink", async () => {
  const harness = createDeliveryHarness();
  let ackCalls = 0;
  const controller = exactController(harness.controller, {
    acknowledgeNpcPublication: (...args) => {
      ackCalls += 1;
      if (ackCalls === 1) throw new Error("private ack failure");
      return harness.controller.acknowledgeNpcPublication(...args);
    }
  });
  let sinkCalls = 0;
  const sink = Object.freeze({
    deliver(execution, supplied) { sinkCalls += 1; return supplied.completeNpcPublicationSink(execution.settlementCapability); },
    getAttachedDeliveryEvidence() { return null; }, reset() {}
  });
  const { orchestrator } = make({ harness, sink, controller });
  const first = await orchestrator.pumpPendingNpcPublications({ schemaVersion: 1, gameSessionId: SESSION });
  assert.equal(first.retryMode, "ack_only");
  const second = await orchestrator.retryNpcPublicationDelivery({ schemaVersion: 1, gameSessionId: SESSION, retryId: first.retryId });
  assert.equal(second.status, "acknowledged_existing");
  assert.equal(sinkCalls, 1);
});

test("ambiguous sink failure is terminal and never creates a retry authority", async () => {
  const harness = createDeliveryHarness();
  let calls = 0;
  const sink = Object.freeze({
    deliver(execution, controller) {
      calls += 1;
      return controller.recordNpcPublicationSinkFailure(execution.settlementCapability, {
        schemaVersion: 1, evidenceType: "npc_sink_failure_evidence", sinkType: "browser",
        failureCode: "browser_sink_attachment_failed", visibleEffect: "unknown", cleanupStatus: "unproved"
      });
    },
    getAttachedDeliveryEvidence() { return null; }, reset() {}
  });
  const { orchestrator } = make({ harness, sink });
  const value = await orchestrator.pumpPendingNpcPublications({ schemaVersion: 1, gameSessionId: SESSION });
  assert.equal(value.status, "failed_terminal");
  assert.equal("retryId" in value, false);
  assert.equal(calls, 1);
});

test("three explicit no-effect attempts exhaust without a hidden fourth sink call", async () => {
  const harness = createDeliveryHarness();
  let calls = 0;
  const sink = Object.freeze({
    deliver(execution, controller) {
      calls += 1;
      return controller.recordNpcPublicationSinkFailure(execution.settlementCapability, {
        schemaVersion: 1, evidenceType: "npc_sink_failure_evidence", sinkType: "browser",
        failureCode: "browser_sink_attachment_failed", visibleEffect: "none", cleanupStatus: "complete"
      });
    },
    getAttachedDeliveryEvidence() { return null; }, reset() {}
  });
  const { orchestrator } = make({ harness, sink });
  let value = await orchestrator.pumpPendingNpcPublications({ schemaVersion: 1, gameSessionId: SESSION });
  value = await orchestrator.retryNpcPublicationDelivery({ schemaVersion: 1, gameSessionId: SESSION, retryId: value.retryId });
  value = await orchestrator.retryNpcPublicationDelivery({ schemaVersion: 1, gameSessionId: SESSION, retryId: value.retryId });
  assert.equal(value.status, "failed_terminal");
  assert.equal(value.terminalCode, "sink_retry_exhausted");
  assert.equal(calls, 3);
});

test("reset wins an active async sink and late completion cannot acknowledge", async () => {
  const harness = createDeliveryHarness();
  let release;
  let sinkCalls = 0;
  const sink = Object.freeze({
    async deliver(execution, controller) {
      sinkCalls += 1;
      await new Promise((resolve) => { release = resolve; });
      return controller.completeNpcPublicationSink(execution.settlementCapability);
    },
    getAttachedDeliveryEvidence() { return null; }, reset() {}
  });
  const { orchestrator } = make({ harness, sink });
  const pending = orchestrator.pumpPendingNpcPublications({ schemaVersion: 1, gameSessionId: SESSION });
  await Promise.resolve();
  assert.equal(orchestrator.reset().status, "reset");
  release();
  assert.equal((await pending).status, "reset");
  assert.equal(sinkCalls, 1);
  assert.equal(harness.controller === null, false);
});

test("consumer replacement invalidates retained retry handles", async () => {
  const harness = createDeliveryHarness();
  const sink = Object.freeze({
    deliver(execution, controller) { return controller.recordNpcPublicationSinkFailure(execution.settlementCapability, { schemaVersion: 1, evidenceType: "npc_sink_failure_evidence", sinkType: "browser", failureCode: "browser_sink_attachment_failed", visibleEffect: "none", cleanupStatus: "complete" }); },
    getAttachedDeliveryEvidence() { return null; }, reset() {}
  });
  const { orchestrator } = make({ harness, sink });
  const failed = await orchestrator.pumpPendingNpcPublications({ schemaVersion: 1, gameSessionId: SESSION });
  const next = orchestrator.replaceNpcPublicationDeliveryConsumer({ schemaVersion: 1, gameSessionId: SESSION, nextConsumerId: "consumer-2", nextSinkType: "browser" });
  assert.equal(next.consumerGeneration, 1);
  await assert.rejects(orchestrator.retryNpcPublicationDelivery({ schemaVersion: 1, gameSessionId: SESSION, retryId: failed.retryId }));
});

test("synchronous and early controller timers remain controller-owned", async () => {
  const harness = createDeliveryHarness({ synchronousTimerCallbacks: 1 });
  const { orchestrator } = make({ harness });
  const value = await orchestrator.pumpPendingNpcPublications({ schemaVersion: 1, gameSessionId: SESSION });
  assert.equal(value.status, "delivered");
  assert.equal(harness.timers.length >= 2, true);
});

test("observer throws without changing the primary result or exposing private markers", async () => {
  const { orchestrator } = make({ observer() { throw new Error("secret stack knownInfo role team"); } });
  const value = await orchestrator.pumpPendingNpcPublications({ schemaVersion: 1, gameSessionId: SESSION });
  assert.equal(value.status, "delivered");
  assert.equal(value.observerStatus, "failed");
  assert.equal(JSON.stringify(value).includes("secret"), false);
});

test("malformed controller and sink results fail with fixed redacted invariants", async () => {
  const base = createDeliveryHarness();
  const badController = exactController(base.controller, { discoverPendingNpcPublications: () => ({ secret: "knownInfo" }) });
  const first = make({ harness: base, controller: badController }).orchestrator;
  await assert.rejects(first.pumpPendingNpcPublications({ schemaVersion: 1, gameSessionId: SESSION }), (error) => error.name === "NpcPublicationDeliveryOrchestratorInvariantError" && !error.message.includes("secret") && !Object.hasOwn(error, "cause"));

  const sink = Object.freeze({ deliver: () => ({ schemaVersion: 1, status: "forged", secret: "private role" }), getAttachedDeliveryEvidence() { return null; }, reset() {} });
  const second = make({ sink }).orchestrator;
  await assert.rejects(second.pumpPendingNpcPublications({ schemaVersion: 1, gameSessionId: SESSION }), { name: "NpcPublicationDeliveryOrchestratorInvariantError" });

  const extraSink = Object.freeze({
    deliver: async (execution, controller) => ({
      ...controller.completeNpcPublicationSink(execution.settlementCapability),
      secret: "private role"
    }),
    getAttachedDeliveryEvidence() { return null; },
    reset() {}
  });
  const third = make({ sink: extraSink }).orchestrator;
  await assert.rejects(third.pumpPendingNpcPublications({ schemaVersion: 1, gameSessionId: SESSION }), {
    name: "NpcPublicationDeliveryOrchestratorInvariantError",
    code: "invalid_npc_delivery_sink_result"
  });
});

test("public results are detached, frozen, redacted, and caller input is immutable", async () => {
  const { orchestrator } = make();
  const input = { schemaVersion: 1, gameSessionId: SESSION };
  const before = structuredClone(input);
  const value = await orchestrator.pumpPendingNpcPublications(input);
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(value));
  for (const marker of ["knownInfo", "hiddenInfo", "privateMemory", "conversationPolicy", "retryToken", "payloadFingerprint", "displayText", "stack", "cause"]) assert.equal(JSON.stringify(value).includes(marker), false);
});

test("orchestrator source is browser-safe and remains production-unconnected", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../src/npcPublicationDeliveryOrchestrator.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:|gameEngine|dispatchPlayerAction|npcReactionPreparation|npcReactionAuthoritativeCommit|npcReactionCandidateProvider/);
  for (const path of ["../src/gameEngine.mjs", "../public/browserApp.mjs", "../src/cli.mjs", "../src/webServer.mjs", "../src/npcStructuredReactionRoute.mjs"]) {
    const production = await fs.readFile(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(production, /npcPublicationDeliveryOrchestrator/);
  }
});
