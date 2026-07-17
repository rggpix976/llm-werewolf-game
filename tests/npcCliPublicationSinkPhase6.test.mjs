import test from "node:test";
import assert from "node:assert/strict";
import { NpcCliPublicationSinkError, createNpcCliPublicationSink } from "../src/npcCliPublicationSink.mjs";
import { controllerSpy, lookupFor, preparedExecution, rendererWithText } from "./helpers/npcPublicationSinkFixtures.mjs";

test("CLI factory and public API are exact and fail closed", () => {
  const options = { write: () => {}, failureGuarantee: "unknown_on_failure" };
  assert.deepEqual(Object.keys(createNpcCliPublicationSink(options)), ["deliver", "getCompletedOutputEvidence", "reset"]);
  for (const key of Object.keys(options)) { const invalid = { ...options }; delete invalid[key]; assert.throws(() => createNpcCliPublicationSink(invalid), NpcCliPublicationSinkError); }
  for (const invalid of [{ ...options, extra: true }, { ...options, write: null }, { ...options, failureGuarantee: "unknown" }, { ...options, [Symbol("x")]: true }, Object.defineProperty({ ...options }, "write", { get: () => () => {} })]) assert.throws(() => createNpcCliPublicationSink(invalid), NpcCliPublicationSinkError);
});

test("CLI sync writer receives exact frozen sanitized input then completes once", async () => {
  const { harness, execution } = preparedExecution("cli");
  const original = execution.request.payload.displayText;
  const inputs = [];
  const sink = createNpcCliPublicationSink({ write: (input) => inputs.push(input), failureGuarantee: "unknown_on_failure" });
  const spy = controllerSpy(harness.controller);
  const completion = await sink.deliver(execution, spy.controller);
  assert.equal(completion.status, "sink_succeeded");
  assert.equal(inputs.length, 1);
  assert.deepEqual(Object.keys(inputs[0]), ["schemaVersion", "outputType", "publicationId", "deliveryAttemptId", "text", "signal"]);
  assert.equal(Object.isFrozen(inputs[0]), true);
  assert.equal(inputs[0].text, original);
  assert.equal(inputs[0].signal, execution.signal);
  assert.equal(spy.counts.complete, 1);
  assert.equal(spy.counts.failure + spy.counts.acknowledge + spy.counts.retry, 0);
  assert.equal(sink.getCompletedOutputEvidence(lookupFor(execution)).completed, true);
});

test("CLI awaits async fulfillment and rejects concurrent or repeated delivery", async () => {
  const { harness, execution } = preparedExecution("cli");
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const sink = createNpcCliPublicationSink({ write: () => pending, failureGuarantee: "unknown_on_failure" });
  const spy = controllerSpy(harness.controller);
  const delivery = sink.deliver(execution, spy.controller);
  assert.equal(spy.counts.complete, 0);
  await assert.rejects(sink.deliver(execution, spy.controller), NpcCliPublicationSinkError);
  resolve();
  assert.equal((await delivery).status, "sink_succeeded");
  assert.equal(spy.counts.complete, 1);
  await assert.rejects(sink.deliver(execution, spy.controller), NpcCliPublicationSinkError);
});

test("CLI sanitizer removes only prohibited terminal controls", async () => {
  const text = " leading\t\n\rE\u0301😀\u001b\u0000\u0085 trailing ";
  const { harness, execution } = preparedExecution("cli", { renderer: rendererWithText(text) });
  let written;
  const sink = createNpcCliPublicationSink({ write: (input) => { written = input.text; }, failureGuarantee: "unknown_on_failure" });
  await sink.deliver(execution, harness.controller);
  assert.equal(written, " leading\t\n\rE\u0301😀 trailing ");
  assert.equal(execution.request.payload.displayText, text);
});

test("CLI failures use only configured mechanical guarantee and redact exceptions", async () => {
  for (const [failureGuarantee, status, disposition] of [["unknown_on_failure", "failed_terminal", "terminal_ambiguous"], ["no_output_on_rejection", "failed_retryable", "retry_sink"]]) {
    for (const asynchronous of [false, true]) {
      const { harness, execution } = preparedExecution("cli");
      const secret = new Error("private writer text");
      const write = asynchronous ? () => Promise.reject(secret) : () => { throw secret; };
      const spy = controllerSpy(harness.controller);
      const result = await createNpcCliPublicationSink({ write, failureGuarantee }).deliver(execution, spy.controller);
      assert.equal(result.status, status);
      assert.equal(result.failure.code, "cli_sink_write_failed");
      assert.equal(result.failure.disposition, disposition);
      assert.equal(JSON.stringify(result).includes("private"), false);
      assert.equal(spy.counts.failure, 1);
      assert.equal(spy.counts.complete, 0);
    }
  }
});

test("CLI completion error preserves bookkeeping and never rewrites", async () => {
  const { harness, execution } = preparedExecution("cli");
  let writes = 0;
  const expected = new Error("controller");
  const sink = createNpcCliPublicationSink({ write: () => { writes += 1; }, failureGuarantee: "unknown_on_failure" });
  const spy = controllerSpy(harness.controller, { complete: () => { throw expected; } });
  await assert.rejects(sink.deliver(execution, spy.controller), (error) => error === expected);
  assert.equal(writes, 1);
  assert.equal(sink.getCompletedOutputEvidence(lookupFor(execution)).completed, true);
  await assert.rejects(sink.deliver(execution, spy.controller), NpcCliPublicationSinkError);
  assert.equal(writes, 1);
  assert.equal(spy.counts.failure, 0);
});

test("CLI reset clears evidence without writing or settling", async () => {
  const { harness, execution } = preparedExecution("cli");
  let writes = 0;
  const sink = createNpcCliPublicationSink({ write: () => { writes += 1; }, failureGuarantee: "unknown_on_failure" });
  assert.equal(sink.reset(), undefined);
  assert.equal(sink.reset(), undefined);
  assert.equal(sink.getCompletedOutputEvidence(lookupFor(execution)), null);
  await assert.rejects(sink.deliver(execution, harness.controller), (error) => error.code === "npc_cli_sink_reset");
  assert.equal(writes, 0);
});

test("CLI lookup requires every identity field and exposes no output text", async () => {
  const { harness, execution } = preparedExecution("cli");
  const sink = createNpcCliPublicationSink({ write: () => {}, failureGuarantee: "unknown_on_failure" });
  await sink.deliver(execution, harness.controller);
  const lookup = lookupFor(execution);
  const evidence = sink.getCompletedOutputEvidence(lookup);
  assert.deepEqual(Object.keys(evidence).sort(), [...Object.keys(lookup), "evidenceType", "completed"].sort());
  assert.equal(Object.hasOwn(evidence, "text"), false);
  for (const field of Object.keys(lookup)) if (field !== "schemaVersion" && field !== "sinkType") assert.equal(sink.getCompletedOutputEvidence({ ...lookup, [field]: `${lookup[field]}-wrong` }), null);
});

test("pre-aborted CLI execution invokes neither writer nor settlement", async () => {
  const { harness, execution } = preparedExecution("cli");
  harness.controller.reset();
  let writes = 0;
  const spy = controllerSpy(harness.controller);
  const sink = createNpcCliPublicationSink({ write: () => { writes += 1; }, failureGuarantee: "unknown_on_failure" });
  await assert.rejects(sink.deliver(execution, spy.controller), (error) => error.code === "invalid_npc_cli_sink_execution");
  assert.equal(writes, 0);
  assert.equal(spy.counts.complete + spy.counts.failure, 0);
});
