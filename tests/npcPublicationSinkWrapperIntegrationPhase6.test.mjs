import test from "node:test";
import assert from "node:assert/strict";
import { createNpcBrowserPublicationSink } from "../src/npcBrowserPublicationSink.mjs";
import { createNpcCliPublicationSink } from "../src/npcCliPublicationSink.mjs";
import { controllerSpy, fakeDom, lookupFor, preparedExecution } from "./helpers/npcPublicationSinkFixtures.mjs";
import { retryLookup } from "./helpers/npcPublicationDeliveryFixtures.mjs";

test("actual controller browser path delivers, exposes exact evidence, and acknowledges only explicitly", () => {
  const { harness, execution } = preparedExecution();
  const dom = fakeDom();
  const sink = createNpcBrowserPublicationSink({ getConversationContainer: dom.getConversationContainer, createTextNode: dom.createTextNode, createMessageNode: dom.createMessageNode });
  const spy = controllerSpy(harness.controller);
  const completion = sink.deliver(execution, spy.controller);
  assert.equal(completion.status, "sink_succeeded");
  assert.equal(harness.controller.getCompletedNpcPublicationSinkReceipt({ ...completion.receipt }), completion.receipt);
  assert.equal(sink.getAttachedDeliveryEvidence(lookupFor(execution)).attached, true);
  assert.equal(spy.counts.acknowledge, 0);
  const acknowledgement = harness.controller.acknowledgeNpcPublication({ sinkSuccessReceipt: completion.receipt });
  assert.equal(acknowledgement.acknowledgementType, "npc_publication_acknowledged");
  assert.deepEqual(harness.graphs, harness.authoritativeSnapshot);
});

test("browser retry is caller-owned and reuses the exact canonical payload", () => {
  const { harness, request, execution } = preparedExecution();
  const missing = fakeDom({ containerMissing: true });
  const first = createNpcBrowserPublicationSink({ getConversationContainer: missing.getConversationContainer, createTextNode: missing.createTextNode, createMessageNode: missing.createMessageNode }).deliver(execution, harness.controller);
  assert.equal(first.status, "failed_retryable");
  const token = harness.controller.getNpcPublicationDeliveryRetryToken(retryLookup(first.retryToken));
  const retryRequest = harness.controller.retryNpcPublicationDelivery(token);
  assert.equal(retryRequest.payload, request.payload);
  const retryExecution = harness.controller.beginNpcPublicationSink(retryRequest);
  const dom = fakeDom();
  const completion = createNpcBrowserPublicationSink({ getConversationContainer: dom.getConversationContainer, createTextNode: dom.createTextNode, createMessageNode: dom.createMessageNode }).deliver(retryExecution, harness.controller);
  assert.equal(completion.status, "sink_succeeded");
  assert.equal(dom.nodes.length, 1);
  assert.equal(harness.counts.rendererCalls, 1);
});

test("browser unproved rollback becomes terminal ambiguity without duplicate node", () => {
  const { harness, execution } = preparedExecution();
  const dom = fakeDom({ wrongParent: true, removalThrows: true });
  const result = createNpcBrowserPublicationSink({ getConversationContainer: dom.getConversationContainer, createTextNode: dom.createTextNode, createMessageNode: dom.createMessageNode }).deliver(execution, harness.controller);
  assert.equal(result.status, "failed_terminal");
  assert.equal(result.failure.disposition, "terminal_ambiguous");
  assert.equal(result.retryToken, null);
  assert.equal(dom.otherParent.children.length, 1);
});

test("actual controller CLI sync and async paths complete only after writer fulfillment", async () => {
  for (const asynchronous of [false, true]) {
    const { harness, execution } = preparedExecution("cli");
    const writes = [];
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const sink = createNpcCliPublicationSink({ write: (input) => { writes.push(input); return asynchronous ? pending : undefined; }, failureGuarantee: "unknown_on_failure" });
    const delivery = sink.deliver(execution, harness.controller);
    if (asynchronous) {
      assert.equal(harness.inspect().root.attemptsById[execution.request.deliveryAttemptId].state, "in_flight");
      resolve();
    }
    const completion = await delivery;
    assert.equal(completion.status, "sink_succeeded");
    assert.equal(writes.length, 1);
    assert.equal(sink.getCompletedOutputEvidence(lookupFor(execution)).completed, true);
  }
});

test("CLI failure classification is configured while retry remains caller-owned", async () => {
  const { harness, execution } = preparedExecution("cli");
  const sink = createNpcCliPublicationSink({ write: () => Promise.reject(new Error("private")), failureGuarantee: "no_output_on_rejection" });
  const result = await sink.deliver(execution, harness.controller);
  assert.equal(result.status, "failed_retryable");
  assert.equal(result.retryToken.retryKind, "repeat_sink");
  assert.equal(harness.inspect().root.attemptsById[execution.request.deliveryAttemptId].state, "failed_retryable");
});

test("controller timeout wins an async writer race without wrapper timeout evidence", async () => {
  const { harness, execution } = preparedExecution("cli");
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const sink = createNpcCliPublicationSink({ write: () => pending, failureGuarantee: "unknown_on_failure" });
  const spy = controllerSpy(harness.controller);
  const delivery = sink.deliver(execution, spy.controller);
  harness.setNow(15000);
  resolve();
  await assert.rejects(delivery, (error) => error.code === "npc_delivery_terminal");
  assert.equal(spy.counts.complete, 1);
  assert.equal(spy.counts.failure, 0);
  assert.equal(harness.inspect().root.attemptsById[execution.request.deliveryAttemptId].state, "failed_terminal");
});

test("controller reset wins an async writer race and wrapper sends no fallback", async () => {
  const { harness, execution } = preparedExecution("cli");
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const sink = createNpcCliPublicationSink({ write: () => pending, failureGuarantee: "unknown_on_failure" });
  const spy = controllerSpy(harness.controller);
  const delivery = sink.deliver(execution, spy.controller);
  harness.controller.reset();
  resolve();
  await assert.rejects(delivery, (error) => error.code === "stale_npc_delivery_session");
  assert.equal(spy.counts.complete, 1);
  assert.equal(spy.counts.failure, 0);
  assert.deepEqual(harness.graphs, harness.authoritativeSnapshot);
});

test("wrapper reset during async output suppresses late controller settlement", async () => {
  const { harness, execution } = preparedExecution("cli");
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const sink = createNpcCliPublicationSink({ write: () => pending, failureGuarantee: "unknown_on_failure" });
  const spy = controllerSpy(harness.controller);
  const delivery = sink.deliver(execution, spy.controller);
  sink.reset();
  resolve();
  await assert.rejects(delivery, (error) => error.code === "npc_cli_sink_reset");
  assert.equal(spy.counts.complete + spy.counts.failure, 0);
});

test("wrappers do not discover, prepare, retry, or acknowledge automatically", async () => {
  const browser = preparedExecution();
  const browserDom = fakeDom();
  const browserSpy = controllerSpy(browser.harness.controller);
  createNpcBrowserPublicationSink({ getConversationContainer: browserDom.getConversationContainer, createTextNode: browserDom.createTextNode, createMessageNode: browserDom.createMessageNode }).deliver(browser.execution, browserSpy.controller);
  assert.equal(browserSpy.counts.retry + browserSpy.counts.acknowledge, 0);
  const cli = preparedExecution("cli");
  const cliSpy = controllerSpy(cli.harness.controller);
  await createNpcCliPublicationSink({ write: () => {}, failureGuarantee: "unknown_on_failure" }).deliver(cli.execution, cliSpy.controller);
  assert.equal(cliSpy.counts.retry + cliSpy.counts.acknowledge, 0);
});
