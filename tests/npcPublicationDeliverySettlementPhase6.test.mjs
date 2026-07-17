import test from "node:test";
import assert from "node:assert/strict";

import {
  NpcPublicationAcknowledgementError,
  NpcPublicationDeliveryError,
  NpcPublicationDeliveryInvariantError
} from "../src/npcPublicationDelivery.mjs";
import {
  browserFailure,
  createDeliveryHarness,
  discoveryInput,
  prepareInput,
  retryLookup
} from "./helpers/npcPublicationDeliveryFixtures.mjs";

function preparedHarness(options = {}) {
  const harness = createDeliveryHarness(options);
  const sinkType = options.sinkType ?? "browser";
  harness.controller.discoverPendingNpcPublications(discoveryInput({ sinkType }));
  const request = harness.controller.prepareNpcPublicationDelivery(prepareInput("npc-publication-1", { sinkType }));
  return { harness, request };
}

test("exact request begins once and exact capability completes with receipt and ack-only token", () => {
  const { harness, request } = preparedHarness();
  assert.throws(() => harness.controller.beginNpcPublicationSink(structuredClone(request)), (error) => error.code === "npc_delivery_identity_conflict");
  const execution = harness.controller.beginNpcPublicationSink(request);
  assert.deepEqual(Object.keys(execution), ["schemaVersion", "status", "request", "settlementCapability", "signal", "sinkDeadlineMs", "timeoutCleanupGraceMs"]);
  assert.equal(execution.request, request);
  assert.equal(execution.sinkDeadlineMs, 15000);
  assert.equal(execution.timeoutCleanupGraceMs, 1000);
  assert.equal(harness.inspect().root.nextSinkStartedOrder, 1);
  assert.throws(() => harness.controller.beginNpcPublicationSink(request), NpcPublicationDeliveryError);

  harness.setNow(14999.999);
  const completion = harness.controller.completeNpcPublicationSink(execution.settlementCapability);
  assert.equal(completion.status, "sink_succeeded");
  assert.equal(completion.retryToken.retryKind, "ack_only");
  assert.equal(harness.controller.getCompletedNpcPublicationSinkReceipt({ ...completion.receipt }), completion.receipt);
  assert.throws(() => harness.controller.completeNpcPublicationSink(execution.settlementCapability), (error) => error.code === "npc_delivery_identity_conflict");
  assert.deepEqual(harness.graphs, harness.authoritativeSnapshot);
});

test("acknowledgement requires exact receipt and exact duplicate is idempotent", () => {
  const { harness, request } = preparedHarness();
  const execution = harness.controller.beginNpcPublicationSink(request);
  const completion = harness.controller.completeNpcPublicationSink(execution.settlementCapability);
  assert.throws(() => harness.controller.acknowledgeNpcPublication({ sinkSuccessReceipt: structuredClone(completion.receipt) }), NpcPublicationAcknowledgementError);
  const acknowledgement = harness.controller.acknowledgeNpcPublication({ sinkSuccessReceipt: completion.receipt });
  assert.equal(acknowledgement.acknowledgedOrder, 0);
  const before = harness.inspect().root;
  assert.equal(harness.controller.acknowledgeNpcPublication({ sinkSuccessReceipt: completion.receipt }), acknowledgement);
  assert.deepEqual(harness.inspect().root, before);
  assert.equal(harness.observations.at(-1).outcomeType, "npc_publication_duplicate_ack_suppressed");
});

test("proved no-effect failure creates explicit retry with same payload and fresh attempt identity", () => {
  const { harness, request } = preparedHarness();
  const execution = harness.controller.beginNpcPublicationSink(request);
  const failure = harness.controller.recordNpcPublicationSinkFailure(execution.settlementCapability, browserFailure());
  assert.equal(failure.status, "failed_retryable");
  assert.equal(failure.failure.disposition, "retry_sink");
  assert.equal(failure.retryToken.retryKind, "repeat_sink");
  assert.equal(harness.controller.getNpcPublicationDeliveryRetryToken(retryLookup(failure.retryToken)), failure.retryToken);
  const retryRequest = harness.controller.retryNpcPublicationDelivery(failure.retryToken);
  assert.notEqual(retryRequest.deliveryAttemptId, request.deliveryAttemptId);
  assert.equal(retryRequest.attemptNumber, 2);
  assert.equal(retryRequest.payload, request.payload);
  const attempts = harness.inspect().root.attemptsById;
  assert.equal(attempts[request.deliveryAttemptId].state, "abandoned");
  assert.equal(attempts[request.deliveryAttemptId].abandonedFromState, "failed_retryable");
  assert.equal(attempts[retryRequest.deliveryAttemptId].state, "prepared");
  assert.throws(() => harness.controller.retryNpcPublicationDelivery(failure.retryToken), (error) => error.code === "npc_delivery_identity_conflict");
  assert.equal(harness.counts.rendererCalls, 1);
  assert.equal(harness.counts.contextReads, 1);
});

test("ack-only retry performs acknowledgement without creating an attempt or invoking a sink", () => {
  const { harness, request } = preparedHarness();
  const execution = harness.controller.beginNpcPublicationSink(request);
  const completion = harness.controller.completeNpcPublicationSink(execution.settlementCapability);
  const attemptCount = Object.keys(harness.inspect().root.attemptsById).length;
  const acknowledgement = harness.controller.retryNpcPublicationDelivery(completion.retryToken);
  assert.equal(acknowledgement.acknowledgementType, "npc_publication_acknowledged");
  assert.equal(Object.keys(harness.inspect().root.attemptsById).length, attemptCount);
  assert.equal(harness.counts.rendererCalls, 1);
  assert.equal(harness.abortControllers.length, 1);
  assert.throws(() => harness.controller.retryNpcPublicationDelivery(completion.retryToken), (error) => error.code === "npc_delivery_identity_conflict");
});

test("three total no-effect attempts exhaust with a distinct terminal disposition", () => {
  const { harness, request } = preparedHarness();
  let currentRequest = request;
  for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
    const execution = harness.controller.beginNpcPublicationSink(currentRequest);
    const result = harness.controller.recordNpcPublicationSinkFailure(execution.settlementCapability, browserFailure());
    if (attemptNumber < 3) {
      assert.equal(result.status, "failed_retryable");
      currentRequest = harness.controller.retryNpcPublicationDelivery(result.retryToken);
      assert.equal(currentRequest.attemptNumber, attemptNumber + 1);
    } else {
      assert.equal(result.status, "failed_terminal");
      assert.equal(result.failure.code, "sink_retry_exhausted");
      assert.equal(result.failure.disposition, "terminal_exhausted");
      assert.equal(result.retryToken, null);
    }
  }
  assert.equal(Object.keys(harness.inspect().root.attemptsById).length, 3);
  assert.equal(harness.counts.rendererCalls, 1);
});

test("CLI accepts only its exact active failure code", () => {
  const { harness, request } = preparedHarness({ sinkType: "cli" });
  const execution = harness.controller.beginNpcPublicationSink(request);
  assert.throws(() => harness.controller.recordNpcPublicationSinkFailure(execution.settlementCapability, browserFailure({ sinkType: "cli" })), (error) => error.code === "invalid_npc_delivery_attempt");
  const result = harness.controller.recordNpcPublicationSinkFailure(execution.settlementCapability, browserFailure({ sinkType: "cli", failureCode: "cli_sink_write_failed" }));
  assert.equal(result.status, "failed_retryable");
  assert.equal(result.failure.code, "cli_sink_write_failed");
});

test("ambiguous failure is terminal and malformed or cross-sink evidence is mutation-free", () => {
  const { harness, request } = preparedHarness();
  const execution = harness.controller.beginNpcPublicationSink(request);
  const before = harness.inspect();
  assert.throws(() => harness.controller.recordNpcPublicationSinkFailure(execution.settlementCapability, browserFailure({ sinkType: "cli" })), NpcPublicationDeliveryInvariantError);
  assert.deepEqual(harness.inspect(), before);
  const result = harness.controller.recordNpcPublicationSinkFailure(execution.settlementCapability, browserFailure({ visibleEffect: "unknown", cleanupStatus: "unproved" }));
  assert.equal(result.status, "failed_terminal");
  assert.equal(result.failure.disposition, "terminal_ambiguous");
  assert.equal(result.retryToken, null);
  assert.throws(() => harness.controller.completeNpcPublicationSink(execution.settlementCapability), NpcPublicationDeliveryError);
});

test("premature timeout evidence is invariant and exact deadline owns timeout", () => {
  const { harness, request } = preparedHarness();
  const execution = harness.controller.beginNpcPublicationSink(request);
  harness.setNow(14999.999);
  const before = harness.inspect();
  assert.throws(() => harness.controller.recordNpcPublicationSinkFailure(execution.settlementCapability, browserFailure({ failureCode: "sink_timeout" })), (error) => error.code === "invalid_npc_delivery_attempt");
  assert.deepEqual(harness.inspect(), before);
  harness.setNow(15000);
  assert.equal(execution.signal.aborted, false);
  const result = harness.controller.recordNpcPublicationSinkFailure(execution.settlementCapability, browserFailure({ failureCode: "sink_timeout" }));
  assert.equal(execution.signal.aborted, true);
  assert.equal(result.status, "failed_retryable");
  assert.equal(result.failure.code, "sink_timeout");
});

test("early primary and cleanup callbacks rearm while cleanup deadline terminalizes once", () => {
  const { harness, request } = preparedHarness();
  harness.controller.beginNpcPublicationSink(request);
  const primary = harness.latestActiveTimer();
  harness.setNow(14999.999);
  harness.fire(primary);
  assert.equal(harness.inspect().root.attemptsById[request.deliveryAttemptId].state, "in_flight");
  const rearmedPrimary = harness.latestActiveTimer();
  assert.ok(Math.abs(rearmedPrimary.delayMs - 0.001) < 1e-9);
  harness.fire(primary);
  assert.equal(rearmedPrimary.cancelled, false);
  assert.equal(harness.inspect().root.attemptsById[request.deliveryAttemptId].state, "in_flight");
  harness.setNow(15000);
  harness.fire(rearmedPrimary);
  assert.equal(harness.abortControllers[0].signal.aborted, true);
  const cleanup = harness.latestActiveTimer();
  harness.setNow(15999.999);
  harness.fire(cleanup);
  assert.equal(harness.inspect().root.attemptsById[request.deliveryAttemptId].state, "in_flight");
  const rearmedCleanup = harness.latestActiveTimer();
  harness.fire(cleanup);
  assert.equal(rearmedCleanup.cancelled, false);
  harness.setNow(16000);
  harness.fire(rearmedCleanup);
  assert.equal(harness.inspect().root.attemptsById[request.deliveryAttemptId].state, "failed_terminal");
  const failureObservations = harness.observations.filter((value) => value.outcomeType === "npc_publication_delivery_failed");
  assert.equal(failureObservations.length, 1);
  harness.fire(cleanup);
  assert.equal(harness.observations.filter((value) => value.outcomeType === "npc_publication_delivery_failed").length, 1);
});

test("success exactly at deadline stores terminal ambiguity and never creates a receipt", () => {
  const { harness, request } = preparedHarness();
  const execution = harness.controller.beginNpcPublicationSink(request);
  harness.setNow(15000);
  assert.throws(() => harness.controller.completeNpcPublicationSink(execution.settlementCapability), (error) => error.code === "npc_delivery_terminal");
  const snapshot = harness.inspect();
  assert.equal(snapshot.root.attemptsById[request.deliveryAttemptId].state, "failed_terminal");
  assert.equal(snapshot.retainedReceiptCount, 0);
  assert.equal(snapshot.root.retryTokensById[Object.keys(snapshot.root.retryTokensById)[0]], undefined);
});

test("delayed primary callback at cleanup deadline terminalizes without a new grace timer", () => {
  const { harness, request } = preparedHarness();
  harness.controller.beginNpcPublicationSink(request);
  const primary = harness.latestActiveTimer();
  harness.setNow(16000);
  harness.fire(primary);
  assert.equal(harness.inspect().root.attemptsById[request.deliveryAttemptId].state, "failed_terminal");
  assert.equal(harness.abortControllers[0].signal.aborted, true);
  assert.equal(harness.timers.length, 1);
});

test("clock regression is an invariant and leaves the live attempt unsettled", () => {
  const { harness, request } = preparedHarness();
  const execution = harness.controller.beginNpcPublicationSink(request);
  harness.setNow(-1);
  const before = harness.inspect();
  assert.throws(() => harness.controller.completeNpcPublicationSink(execution.settlementCapability), (error) => error.code === "invalid_npc_delivery_attempt");
  assert.deepEqual(harness.inspect(), before);
});

test("sink-start, sink-success, and acknowledgement order exhaustion roll back without gaps", () => {
  const start = preparedHarness({ initialRuntimeOrders: { nextSinkStartedOrder: Number.MAX_SAFE_INTEGER } });
  const beforeStart = start.harness.inspect();
  assert.throws(() => start.harness.controller.beginNpcPublicationSink(start.request), (error) => error.code === "npc_delivery_order_corruption");
  assert.deepEqual(start.harness.inspect(), beforeStart);

  const success = preparedHarness({ initialRuntimeOrders: { nextSinkSucceededOrder: Number.MAX_SAFE_INTEGER } });
  const successExecution = success.harness.controller.beginNpcPublicationSink(success.request);
  const beforeSuccess = success.harness.inspect();
  assert.throws(() => success.harness.controller.completeNpcPublicationSink(successExecution.settlementCapability), (error) => error.code === "npc_delivery_order_corruption");
  assert.deepEqual(success.harness.inspect(), beforeSuccess);

  const acknowledgement = preparedHarness({ initialRuntimeOrders: { nextAcknowledgedOrder: Number.MAX_SAFE_INTEGER } });
  const ackExecution = acknowledgement.harness.controller.beginNpcPublicationSink(acknowledgement.request);
  const completion = acknowledgement.harness.controller.completeNpcPublicationSink(ackExecution.settlementCapability);
  const beforeAck = acknowledgement.harness.inspect();
  assert.throws(() => acknowledgement.harness.controller.acknowledgeNpcPublication({ sinkSuccessReceipt: completion.receipt }), (error) => error.code === "npc_delivery_order_corruption");
  assert.deepEqual(acknowledgement.harness.inspect(), beforeAck);
});
