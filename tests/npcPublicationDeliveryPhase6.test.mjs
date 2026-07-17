import test from "node:test";
import assert from "node:assert/strict";

import {
  NPC_PUBLICATION_ACKNOWLEDGEMENT_ERROR_CODES,
  NPC_PUBLICATION_DELIVERY_ERROR_CODES,
  NPC_PUBLICATION_DELIVERY_INVARIANT_CODES,
  NpcPublicationDeliveryError,
  NpcPublicationDeliveryInvariantError,
  createNpcPublicationDeliveryController
} from "../src/npcPublicationDelivery.mjs";
import {
  committedGraphFixture,
  createDeliveryHarness,
  discoveryInput,
  prepareInput
} from "./helpers/npcPublicationDeliveryFixtures.mjs";

test("production factory and public controller API have exact closed fields", () => {
  const graph = committedGraphFixture();
  const timers = [];
  const dependencies = {
    gameSessionId: "game-session-1",
    initialConsumer: { consumerId: "consumer-1", sinkType: "browser" },
    createId: () => "delivery-attempt-1",
    listCommittedNpcPublicationGraphs: () => [graph],
    getCanonicalRenderingContext: () => ({ locale: "en", publicParticipantsById: { "npc-1": { participantId: "npc-1", displayName: "Actor" } } }),
    nowMonotonicMs: () => 0,
    scheduleTimer: (callback, delayMs) => { const handle = { callback, delayMs }; timers.push(handle); return handle; },
    cancelTimer: () => {},
    createAbortController: () => new AbortController(),
    observer: () => {}
  };
  const controller = createNpcPublicationDeliveryController(dependencies);
  assert.deepEqual(Object.keys(controller), [
    "discoverPendingNpcPublications", "prepareNpcPublicationDelivery", "beginNpcPublicationSink",
    "completeNpcPublicationSink", "recordNpcPublicationSinkFailure", "getNpcPublicationDeliveryRetryToken",
    "retryNpcPublicationDelivery", "getCompletedNpcPublicationSinkReceipt", "acknowledgeNpcPublication",
    "replaceNpcPublicationDeliveryConsumer", "reset"
  ]);
  for (const field of Object.keys(dependencies)) {
    const invalid = { ...dependencies };
    delete invalid[field];
    assert.throws(() => createNpcPublicationDeliveryController(invalid), NpcPublicationDeliveryInvariantError);
  }
  assert.throws(() => createNpcPublicationDeliveryController({ ...dependencies, extra: true }), NpcPublicationDeliveryInvariantError);
  assert.throws(() => createNpcPublicationDeliveryController({ ...dependencies, observer: null }), NpcPublicationDeliveryInvariantError);
});

test("closed error sets and redacted error objects remain exact", () => {
  assert.equal(NPC_PUBLICATION_DELIVERY_ERROR_CODES.length, 13);
  assert.equal(NPC_PUBLICATION_ACKNOWLEDGEMENT_ERROR_CODES.length, 5);
  assert.equal(NPC_PUBLICATION_DELIVERY_INVARIANT_CODES.length, 8);
  const error = new NpcPublicationDeliveryError("npc_publication_not_found");
  assert.equal(error.name, "NpcPublicationDeliveryError");
  assert.equal(error.code, "npc_publication_not_found");
  assert.equal(error.message, "NPC publication delivery failed");
  assert.deepEqual(Object.keys(error), []);
  assert.ok(!Object.hasOwn(error, "cause"));
});

test("discovery materializes only the unresolved head and cursor cannot expose a later slot", () => {
  const harness = createDeliveryHarness({ graphs: [committedGraphFixture({ number: 1 }), committedGraphFixture({ number: 2 })] });
  const first = harness.controller.discoverPendingNpcPublications(discoveryInput());
  assert.equal(first.length, 1);
  assert.equal(first[0].publicationId, "npc-publication-1");
  assert.equal(first[0].state, "pending");
  assert.equal(first[0].currentAttemptId, null);
  assert.equal(first[0].retryTokenId, null);
  assert.ok(Object.isFrozen(first));
  assert.deepEqual(harness.controller.discoverPendingNpcPublications(discoveryInput({ afterPublicationSlotOrder: 0 })), []);
  assert.equal(Object.keys(harness.inspect().root.currentRecordsByPublicationId).length, 1);
  assert.deepEqual(harness.graphs, harness.authoritativeSnapshot);
});

test("preparation creates one exact frozen request without authoritative mutation", () => {
  const harness = createDeliveryHarness();
  harness.controller.discoverPendingNpcPublications(discoveryInput());
  const request = harness.controller.prepareNpcPublicationDelivery(prepareInput());
  assert.deepEqual(Object.keys(request), [
    "schemaVersion", "gameSessionId", "consumerId", "consumerGeneration", "sinkType",
    "deliveryAttemptId", "deliveryAttemptOrder", "attemptNumber", "publicationSlotOrder",
    "recordAppendOrder", "payload"
  ]);
  assert.equal(request.attemptNumber, 1);
  assert.equal(request.deliveryAttemptOrder, 0);
  assert.equal(request.payload.publicationId, "npc-publication-1");
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.payload));
  assert.equal(harness.inspect().root.nextDeliveryAttemptOrder, 1);
  assert.equal(harness.observations.at(-1).outcomeType, "npc_publication_delivery_prepared");
  assert.ok(!Object.hasOwn(harness.observations.at(-1), "payload"));
  assert.ok(!Object.hasOwn(harness.observations.at(-1), "payloadFingerprint"));
  assert.deepEqual(harness.graphs, harness.authoritativeSnapshot);
});

test("testing inspector exposes a detached exact twelve-field root but no capability values", () => {
  const harness = createDeliveryHarness();
  const snapshot = harness.inspect();
  assert.deepEqual(Object.keys(snapshot.root), [
    "schemaVersion", "gameSessionId", "consumer", "invalidated", "nextDeliveryAttemptOrder",
    "nextSinkStartedOrder", "nextSinkSucceededOrder", "nextAcknowledgedOrder",
    "currentRecordsByPublicationId", "attemptsById", "acknowledgementsByPublicationId", "retryTokensById"
  ]);
  assert.deepEqual(snapshot.root.consumer, { consumerId: "consumer-1", consumerGeneration: 0, sinkType: "browser" });
  assert.ok(!Object.hasOwn(snapshot, "requests"));
  assert.ok(!Object.hasOwn(snapshot, "capabilities"));
  assert.ok(!Object.hasOwn(snapshot, "receipts"));
  assert.throws(() => { snapshot.root.consumer.consumerId = "changed-locally"; }, TypeError);
  assert.equal(harness.inspect().root.consumer.consumerId, "consumer-1");
});

test("canonical resolution failure stores terminal null-fingerprint evidence then throws", () => {
  const resolution = Object.freeze({ schemaVersion: 1, failureType: "npc_delivery_resolution", code: "canonical_render_failed", disposition: "terminal" });
  const harness = createDeliveryHarness({ renderer: () => resolution });
  harness.controller.discoverPendingNpcPublications(discoveryInput());
  assert.throws(() => harness.controller.prepareNpcPublicationDelivery(prepareInput()), (error) => {
    assert.equal(error.code, "npc_delivery_terminal");
    return true;
  });
  const snapshot = harness.inspect();
  const attempt = Object.values(snapshot.root.attemptsById)[0];
  assert.equal(attempt.state, "failed_terminal");
  assert.equal(attempt.payloadFingerprint, null);
  assert.deepEqual(attempt.failure, resolution);
  assert.equal(snapshot.activeRequestCount, 0);
  assert.equal(snapshot.retainedPayloadCount, 0);
  assert.equal(harness.observations.at(-1).code, "canonical_render_failed");
  assert.deepEqual(harness.graphs, harness.authoritativeSnapshot);
});

test("renderer invariant and malformed authoritative graph leave controller byte-equivalent", () => {
  const harness = createDeliveryHarness({ renderer: () => { throw new Error("private renderer failure"); } });
  harness.controller.discoverPendingNpcPublications(discoveryInput());
  const before = harness.inspect();
  assert.throws(() => harness.controller.prepareNpcPublicationDelivery(prepareInput()), /private renderer failure/);
  assert.deepEqual(harness.inspect(), before);

  const malformed = createDeliveryHarness();
  malformed.graphs[0].publication.publicationId = "wrong-publication";
  assert.throws(() => malformed.controller.discoverPendingNpcPublications(discoveryInput()), (error) => {
    assert.equal(error.code, "invalid_npc_delivery_publication_graph");
    return true;
  });
  assert.equal(malformed.observations.length, 0);
});

test("pre-publication and capability-registration faults roll back preparation and begin", () => {
  const rootFault = createDeliveryHarness({
    beforeRootPublication: (nextRoot) => {
      if (Object.keys(nextRoot.attemptsById).length > 0) throw new Error("root publication fault");
    }
  });
  rootFault.controller.discoverPendingNpcPublications(discoveryInput());
  const beforePrepare = rootFault.inspect();
  assert.throws(() => rootFault.controller.prepareNpcPublicationDelivery(prepareInput()), /root publication fault/);
  assert.deepEqual(rootFault.inspect(), beforePrepare);

  const capabilityFault = createDeliveryHarness({
    beforeCapabilityRegistryPublication: (value) => {
      if (!Object.hasOwn(value, "schemaVersion")) throw new Error("capability registry fault");
    }
  });
  capabilityFault.controller.discoverPendingNpcPublications(discoveryInput());
  const request = capabilityFault.controller.prepareNpcPublicationDelivery(prepareInput());
  const beforeBegin = capabilityFault.inspect();
  assert.throws(() => capabilityFault.controller.beginNpcPublicationSink(request), /capability registry fault/);
  assert.deepEqual(capabilityFault.inspect(), beforeBegin);
  assert.equal(capabilityFault.abortControllers[0].signal.aborted, true);
  assert.ok(capabilityFault.timers.every((timer) => timer.cancelled));
});

test("attempt identity collision is a fixed invariant with no allocator retry or counter gap", () => {
  let calls = 0;
  const graph = committedGraphFixture();
  const controller = createNpcPublicationDeliveryController({
    gameSessionId: "game-session-1",
    initialConsumer: { consumerId: "consumer-1", sinkType: "browser" },
    createId: () => { calls += 1; return graph.publication.publicationId; },
    listCommittedNpcPublicationGraphs: () => [graph],
    getCanonicalRenderingContext: () => ({ locale: "en", publicParticipantsById: { "npc-1": { participantId: "npc-1", displayName: "Actor" } } }),
    nowMonotonicMs: () => 0,
    scheduleTimer: () => ({}),
    cancelTimer: () => {},
    createAbortController: () => new AbortController(),
    observer: () => {}
  });
  controller.discoverPendingNpcPublications(discoveryInput());
  assert.throws(() => controller.prepareNpcPublicationDelivery(prepareInput()), (error) => error.code === "npc_delivery_identity_collision");
  assert.equal(calls, 1);
});

test("production module remains synchronous, browser-safe, and production-unconnected", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/npcPublicationDelivery.mjs", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /\basync\b|\bawait\b|node:|gameEngine|browserApp|\bfetch\b|provider/i);
  assert.match(source, /resolveNpcCanonicalDeliveryPayload/);
});
