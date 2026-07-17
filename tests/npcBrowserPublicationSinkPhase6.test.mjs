import test from "node:test";
import assert from "node:assert/strict";
import { NpcBrowserPublicationSinkError, createNpcBrowserPublicationSink, createNpcBrowserPublicationSinkForTesting } from "../src/npcBrowserPublicationSink.mjs";
import { controllerSpy, fakeDom, lookupFor, preparedExecution, rendererWithText } from "./helpers/npcPublicationSinkFixtures.mjs";

test("browser factory and public API are exact and fail closed", () => {
  const dom = fakeDom();
  const options = { getConversationContainer: dom.getConversationContainer, createTextNode: dom.createTextNode, createMessageNode: dom.createMessageNode };
  assert.deepEqual(Object.keys(createNpcBrowserPublicationSink(options)), ["deliver", "getAttachedDeliveryEvidence", "reset"]);
  for (const key of Object.keys(options)) { const invalid = { ...options }; delete invalid[key]; assert.throws(() => createNpcBrowserPublicationSink(invalid), NpcBrowserPublicationSinkError); }
  assert.throws(() => createNpcBrowserPublicationSink({ ...options, extra: true }), NpcBrowserPublicationSinkError);
  assert.throws(() => createNpcBrowserPublicationSink({ ...options, createTextNode: null }), NpcBrowserPublicationSinkError);
  assert.throws(() => createNpcBrowserPublicationSink(Object.defineProperty({ ...options }, "extra", { value: true, enumerable: false })), NpcBrowserPublicationSinkError);
  assert.throws(() => createNpcBrowserPublicationSink(Object.defineProperty({ ...options }, "createTextNode", { get: () => dom.createTextNode })), NpcBrowserPublicationSinkError);
  assert.throws(() => createNpcBrowserPublicationSink({ ...options, [Symbol("x")]: true }), NpcBrowserPublicationSinkError);
});

test("browser attaches exact safe text and returns exact controller completion", () => {
  const { harness, execution } = preparedExecution();
  const dom = fakeDom();
  let textInput;
  const sink = createNpcBrowserPublicationSink({ getConversationContainer: dom.getConversationContainer, createTextNode: (text) => { textInput = text; return dom.createTextNode(text); }, createMessageNode: dom.createMessageNode });
  const spy = controllerSpy(harness.controller);
  const before = structuredClone(execution.request.payload);
  const completion = sink.deliver(execution, spy.controller);
  assert.equal(completion.status, "sink_succeeded");
  assert.equal(spy.counts.complete, 1);
  assert.equal(spy.counts.failure, 0);
  assert.equal(spy.counts.acknowledge, 0);
  assert.equal(spy.counts.retry, 0);
  assert.equal(textInput, execution.request.payload.displayText);
  assert.equal(dom.container.children.length, 1);
  assert.equal(dom.container.children[0].childNodes[0].textContent, textInput);
  assert.deepEqual(execution.request.payload, before);
  assert.deepEqual(sink.getAttachedDeliveryEvidence(lookupFor(execution)), { ...lookupFor(execution), evidenceType: "npc_browser_attached_delivery", attached: true });
});

test("browser preserves spaces, combining characters, emoji, and HTML-like text as text", () => {
  for (const displayText of [" leading ", "E\u0301", "😀", "<img src=x onerror=1>"]) {
    const { harness, execution } = preparedExecution("browser", { renderer: rendererWithText(displayText) });
    const dom = fakeDom();
    const sink = createNpcBrowserPublicationSink({ getConversationContainer: dom.getConversationContainer, createTextNode: dom.createTextNode, createMessageNode: dom.createMessageNode });
    sink.deliver(execution, harness.controller);
    assert.equal(dom.nodes[0].childNodes[0].textContent, displayText);
  }
});

test("browser missing container and unattached append report exact no-effect failure", () => {
  for (const configuration of [{ containerMissing: true, code: "browser_sink_container_missing" }, { attach: false, code: "browser_sink_attachment_failed" }, { appendThrows: true, code: "browser_sink_attachment_failed" }]) {
    const { harness, execution } = preparedExecution();
    const dom = fakeDom(configuration);
    const spy = controllerSpy(harness.controller);
    const result = createNpcBrowserPublicationSink({ getConversationContainer: dom.getConversationContainer, createTextNode: dom.createTextNode, createMessageNode: dom.createMessageNode }).deliver(execution, spy.controller);
    assert.equal(result.status, "failed_retryable");
    assert.deepEqual(result.failure, { schemaVersion: 1, failureType: "npc_delivery_transport", code: configuration.code, disposition: "retry_sink" });
    assert.equal(spy.counts.failure, 1);
    assert.equal(spy.counts.complete, 0);
  }
});

test("browser wrong-parent rollback is retryable only after exact detachment", () => {
  for (const removalThrows of [false, true]) {
    const { harness, execution } = preparedExecution();
    const dom = fakeDom({ wrongParent: true, removalThrows });
    const result = createNpcBrowserPublicationSink({ getConversationContainer: dom.getConversationContainer, createTextNode: dom.createTextNode, createMessageNode: dom.createMessageNode }).deliver(execution, harness.controller);
    assert.equal(result.status, removalThrows ? "failed_terminal" : "failed_retryable");
    assert.equal(dom.otherParent.children.length, removalThrows ? 1 : 0);
  }
});

test("browser bookkeeping rollback proves no effect or fails ambiguous", () => {
  for (const removalThrows of [false, true]) {
    const { harness, execution } = preparedExecution();
    const dom = fakeDom({ removalThrows });
    const testing = createNpcBrowserPublicationSinkForTesting({ getConversationContainer: dom.getConversationContainer, createTextNode: dom.createTextNode, createMessageNode: dom.createMessageNode }, { bookkeepingRegistrationFault: () => { throw new Error("fault"); } });
    const result = testing.sink.deliver(execution, harness.controller);
    assert.equal(result.status, removalThrows ? "failed_terminal" : "failed_retryable");
    assert.equal(result.failure.code, "browser_sink_bookkeeping_failed");
    assert.equal(dom.container.children.length, removalThrows ? 1 : 0);
    assert.equal(testing.inspect().recordCount, 0);
  }
});

test("browser completion error retains node and prevents any second sink", () => {
  const { harness, execution } = preparedExecution();
  const dom = fakeDom();
  const expected = new Error("controller completion");
  const spy = controllerSpy(harness.controller, { complete: () => { throw expected; } });
  const sink = createNpcBrowserPublicationSink({ getConversationContainer: dom.getConversationContainer, createTextNode: dom.createTextNode, createMessageNode: dom.createMessageNode });
  assert.throws(() => sink.deliver(execution, spy.controller), (error) => error === expected);
  assert.equal(dom.container.children.length, 1);
  assert.equal(spy.counts.failure, 0);
  assert.throws(() => sink.deliver(execution, spy.controller), NpcBrowserPublicationSinkError);
});

test("browser lookup is full identity and reset keeps visible nodes", () => {
  const { harness, execution } = preparedExecution();
  const dom = fakeDom();
  const sink = createNpcBrowserPublicationSink({ getConversationContainer: dom.getConversationContainer, createTextNode: dom.createTextNode, createMessageNode: dom.createMessageNode });
  sink.deliver(execution, harness.controller);
  const lookup = lookupFor(execution);
  for (const field of Object.keys(lookup)) if (field !== "schemaVersion" && field !== "sinkType") assert.equal(sink.getAttachedDeliveryEvidence({ ...lookup, [field]: `${lookup[field]}-wrong` }), null);
  assert.equal(sink.reset(), undefined);
  assert.equal(sink.reset(), undefined);
  assert.equal(dom.container.children.length, 1);
  assert.equal(sink.getAttachedDeliveryEvidence(lookup), null);
  assert.throws(() => sink.deliver(execution, harness.controller), (error) => error.code === "npc_browser_sink_reset");
});

test("browser rejects create and append reentrancy without duplicating the sink", () => {
  for (const phase of ["create", "append"]) {
    const { harness, execution } = preparedExecution();
    const dom = fakeDom();
    let sink;
    let reentrantError;
    const createMessageNode = (input) => {
      if (phase === "create") assert.throws(() => sink.deliver(execution, harness.controller), (error) => { reentrantError = error; return error.code === "invalid_npc_browser_sink_execution"; });
      return dom.createMessageNode(input);
    };
    if (phase === "append") {
      const append = dom.container.appendChild.bind(dom.container);
      dom.container.appendChild = (node) => { assert.throws(() => sink.deliver(execution, harness.controller), (error) => { reentrantError = error; return error.code === "invalid_npc_browser_sink_execution"; }); return append(node); };
    }
    sink = createNpcBrowserPublicationSink({ getConversationContainer: dom.getConversationContainer, createTextNode: dom.createTextNode, createMessageNode });
    assert.equal(sink.deliver(execution, harness.controller).status, "sink_succeeded");
    assert.ok(reentrantError);
    assert.equal(dom.container.children.length, 1);
  }
});
