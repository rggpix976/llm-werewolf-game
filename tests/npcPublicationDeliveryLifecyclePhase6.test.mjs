import test from "node:test";
import assert from "node:assert/strict";

import { NpcPublicationAcknowledgementError, NpcPublicationDeliveryError, NpcPublicationDeliveryInvariantError } from "../src/npcPublicationDelivery.mjs";
import { browserFailure, committedGraphFixture, createDeliveryHarness, discoveryInput, prepareInput } from "./helpers/npcPublicationDeliveryFixtures.mjs";

function retryableHarness() {
  const harness = createDeliveryHarness();
  harness.controller.discoverPendingNpcPublications(discoveryInput());
  const request = harness.controller.prepareNpcPublicationDelivery(prepareInput());
  const execution = harness.controller.beginNpcPublicationSink(request);
  const result = harness.controller.recordNpcPublicationSinkFailure(execution.settlementCapability, browserFailure());
  return { harness, request, result };
}

test("consumer replacement abandons retryable attempt, invalidates token, and rebinds pending", () => {
  const { harness, request, result } = retryableHarness();
  const consumer = harness.controller.replaceNpcPublicationDeliveryConsumer({
    schemaVersion: 1,
    gameSessionId: "game-session-1",
    consumerId: "consumer-1",
    consumerGeneration: 0,
    sinkType: "browser",
    nextConsumerId: "consumer-2",
    nextSinkType: "cli"
  });
  assert.deepEqual(consumer, { consumerId: "consumer-2", consumerGeneration: 1, sinkType: "cli" });
  const snapshot = harness.inspect().root;
  assert.equal(snapshot.attemptsById[request.deliveryAttemptId].state, "abandoned");
  assert.equal(snapshot.currentRecordsByPublicationId[request.payload.publicationId].state, "pending");
  assert.equal(snapshot.currentRecordsByPublicationId[request.payload.publicationId].currentAttemptId, null);
  assert.equal(snapshot.retryTokensById[result.retryToken.retryTokenId], undefined);
  assert.throws(() => harness.controller.retryNpcPublicationDelivery(result.retryToken), (error) => error.code === "npc_delivery_identity_conflict");
  assert.deepEqual(harness.observations.slice(-2).map((value) => value.outcomeType), ["npc_publication_delivery_abandoned", "npc_delivery_consumer_replaced"]);
  assert.equal(harness.observations.at(-1).consumerId, "consumer-2");
});

test("identical consumer replacement is an exact no-op and pending replacement increments once", () => {
  const harness = createDeliveryHarness();
  harness.controller.discoverPendingNpcPublications(discoveryInput());
  const before = harness.inspect();
  const same = harness.controller.replaceNpcPublicationDeliveryConsumer({
    schemaVersion: 1, gameSessionId: "game-session-1", consumerId: "consumer-1",
    consumerGeneration: 0, sinkType: "browser", nextConsumerId: "consumer-1", nextSinkType: "browser"
  });
  assert.equal(same.consumerGeneration, 0);
  assert.deepEqual(harness.inspect(), before);
  const next = harness.controller.replaceNpcPublicationDeliveryConsumer({
    schemaVersion: 1, gameSessionId: "game-session-1", consumerId: "consumer-1",
    consumerGeneration: 0, sinkType: "browser", nextConsumerId: "consumer-2", nextSinkType: "cli"
  });
  assert.equal(next.consumerGeneration, 1);
  assert.equal(harness.inspect().root.currentRecordsByPublicationId["npc-publication-1"].sinkType, "cli");
});

test("replacement blocks prepared, in-flight, and sink-succeeded states", () => {
  for (const state of ["prepared", "in_flight", "sink_succeeded"]) {
    const harness = createDeliveryHarness();
    harness.controller.discoverPendingNpcPublications(discoveryInput());
    const request = harness.controller.prepareNpcPublicationDelivery(prepareInput());
    let execution;
    if (state !== "prepared") execution = harness.controller.beginNpcPublicationSink(request);
    if (state === "sink_succeeded") harness.controller.completeNpcPublicationSink(execution.settlementCapability);
    const before = harness.inspect().root;
    assert.throws(() => harness.controller.replaceNpcPublicationDeliveryConsumer({
      schemaVersion: 1, gameSessionId: "game-session-1", consumerId: "consumer-1",
      consumerGeneration: 0, sinkType: "browser", nextConsumerId: "consumer-2", nextSinkType: "cli"
    }), (error) => error.code === "npc_delivery_in_progress", state);
    assert.deepEqual(harness.inspect().root, before);
  }
});

test("old receipt becomes stale after a later consumer replacement and is never duplicate success", () => {
  const harness = createDeliveryHarness();
  harness.controller.discoverPendingNpcPublications(discoveryInput());
  const request = harness.controller.prepareNpcPublicationDelivery(prepareInput());
  const execution = harness.controller.beginNpcPublicationSink(request);
  const completion = harness.controller.completeNpcPublicationSink(execution.settlementCapability);
  harness.controller.acknowledgeNpcPublication({ sinkSuccessReceipt: completion.receipt });
  harness.controller.replaceNpcPublicationDeliveryConsumer({
    schemaVersion: 1, gameSessionId: "game-session-1", consumerId: "consumer-1",
    consumerGeneration: 0, sinkType: "browser", nextConsumerId: "consumer-2", nextSinkType: "cli"
  });
  assert.throws(() => harness.controller.acknowledgeNpcPublication({ sinkSuccessReceipt: completion.receipt }), (error) => {
    assert.ok(error instanceof NpcPublicationAcknowledgementError);
    assert.equal(error.code, "stale_npc_acknowledgement_generation");
    return true;
  });
  assert.equal(harness.observations.at(-1).outcomeType, "npc_publication_stale_ack_rejected");
});

test("reset abandons nonterminal attempts, aborts once, closes observer, and invalidates every public method", () => {
  const harness = createDeliveryHarness();
  harness.controller.discoverPendingNpcPublications(discoveryInput());
  const request = harness.controller.prepareNpcPublicationDelivery(prepareInput());
  const execution = harness.controller.beginNpcPublicationSink(request);
  const lateResults = [];
  execution.signal.addEventListener("abort", () => {
    try { harness.controller.completeNpcPublicationSink(execution.settlementCapability); } catch (error) { lateResults.push(error.code); }
  }, { once: true });
  const observerCount = harness.observations.length;
  assert.equal(harness.controller.reset(), undefined);
  assert.equal(execution.signal.aborted, true);
  assert.deepEqual(lateResults, ["stale_npc_delivery_session"]);
  assert.equal(harness.inspect().invalidated, true);
  assert.equal(harness.inspect().root, null);
  assert.equal(harness.controller.reset(), undefined);
  assert.equal(harness.observations.length, observerCount + 1);
  assert.throws(() => harness.controller.discoverPendingNpcPublications(discoveryInput()), (error) => error.code === "stale_npc_delivery_session");
  assert.throws(() => harness.controller.completeNpcPublicationSink(execution.settlementCapability), (error) => error.code === "stale_npc_delivery_session");
  const after = harness.observations.length;
  for (const timer of harness.timers) harness.fire(timer);
  assert.equal(harness.observations.length, after);
  assert.deepEqual(harness.graphs, harness.authoritativeSnapshot);
});

test("observer MAX_SAFE_INTEGER is used once then channel exhausts without changing primary results", () => {
  const harness = createDeliveryHarness({ initialRuntimeOrders: { nextObservationRuntimeOrder: Number.MAX_SAFE_INTEGER } });
  const first = harness.controller.discoverPendingNpcPublications(discoveryInput());
  assert.equal(first.length, 1);
  assert.equal(harness.observations.length, 0);
  const request = harness.controller.prepareNpcPublicationDelivery(prepareInput());
  assert.equal(request.attemptNumber, 1);
  assert.equal(harness.observations.length, 1);
  assert.equal(harness.observations[0].runtimeOrder, Number.MAX_SAFE_INTEGER);
  harness.controller.beginNpcPublicationSink(request);
  assert.equal(harness.observations.length, 1);
  assert.equal(harness.inspect().observerAvailable, false);
});

test("observer orders MAX_SAFE_INTEGER minus one and MAX_SAFE_INTEGER remain unique", () => {
  const harness = createDeliveryHarness({ initialRuntimeOrders: { nextObservationRuntimeOrder: Number.MAX_SAFE_INTEGER - 1 } });
  harness.controller.discoverPendingNpcPublications(discoveryInput());
  const request = harness.controller.prepareNpcPublicationDelivery(prepareInput());
  harness.controller.beginNpcPublicationSink(request);
  assert.deepEqual(harness.observations.map((value) => value.runtimeOrder), [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]);
  assert.equal(new Set(harness.observations.map((value) => value.runtimeOrder)).size, 2);
  assert.equal(harness.inspect().observerAvailable, false);
});

test("acknowledged head advances discovery to the next authoritative publication", () => {
  const harness = createDeliveryHarness({ graphs: [committedGraphFixture({ number: 1 }), committedGraphFixture({ number: 2 })] });
  harness.controller.discoverPendingNpcPublications(discoveryInput());
  const request = harness.controller.prepareNpcPublicationDelivery(prepareInput());
  const completion = harness.controller.completeNpcPublicationSink(harness.controller.beginNpcPublicationSink(request).settlementCapability);
  harness.controller.acknowledgeNpcPublication({ sinkSuccessReceipt: completion.receipt });
  const next = harness.controller.discoverPendingNpcPublications(discoveryInput());
  assert.equal(next.length, 1);
  assert.equal(next[0].publicationId, "npc-publication-2");
});

test("observer exceptions and order exhaustion never alter stored transition", () => {
  const harness = createDeliveryHarness({ observer: () => { throw new Error("observer private failure"); } });
  harness.controller.discoverPendingNpcPublications(discoveryInput());
  const request = harness.controller.prepareNpcPublicationDelivery(prepareInput());
  assert.equal(harness.inspect().root.attemptsById[request.deliveryAttemptId].state, "prepared");
  const execution = harness.controller.beginNpcPublicationSink(request);
  assert.equal(harness.inspect().root.attemptsById[request.deliveryAttemptId].state, "in_flight");
  assert.equal(execution.status, "in_flight");
});

test("order and generation exhaustion fail before mutation and ID allocation effects", () => {
  const attemptOrder = createDeliveryHarness({ initialRuntimeOrders: { nextDeliveryAttemptOrder: Number.MAX_SAFE_INTEGER } });
  attemptOrder.controller.discoverPendingNpcPublications(discoveryInput());
  const before = attemptOrder.inspect();
  assert.throws(() => attemptOrder.controller.prepareNpcPublicationDelivery(prepareInput()), (error) => error instanceof NpcPublicationDeliveryInvariantError && error.code === "npc_delivery_order_corruption");
  assert.deepEqual(attemptOrder.inspect(), before);

  const generation = createDeliveryHarness({ initialRuntimeOrders: { consumerGeneration: Number.MAX_SAFE_INTEGER } });
  generation.controller.discoverPendingNpcPublications(discoveryInput({ consumerGeneration: Number.MAX_SAFE_INTEGER }));
  assert.throws(() => generation.controller.replaceNpcPublicationDeliveryConsumer({
    schemaVersion: 1, gameSessionId: "game-session-1", consumerId: "consumer-1",
    consumerGeneration: Number.MAX_SAFE_INTEGER, sinkType: "browser", nextConsumerId: "consumer-2", nextSinkType: "cli"
  }), (error) => error.code === "npc_delivery_order_corruption");
});

test("all public transitions remain synchronous and return no Promise", () => {
  const { harness, request, result } = retryableHarness();
  assert.ok(!(request instanceof Promise));
  assert.ok(!(result instanceof Promise));
  assert.throws(() => harness.controller.retryNpcPublicationDelivery(structuredClone(result.retryToken)), NpcPublicationDeliveryError);
});
