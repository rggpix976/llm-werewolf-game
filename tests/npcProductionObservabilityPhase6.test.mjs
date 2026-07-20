import assert from "node:assert/strict";
import test from "node:test";

import * as observationModule from "../src/npcProductionObservationLedger.mjs";
import {
  createNpcProductionObservationLedger,
  formatNpcProductionObservationRecord
} from "../src/npcProductionObservationLedger.mjs";

const sessionId = "session-observation";

test("observation module exposes the exact browser-safe public surface", async () => {
  assert.deepEqual(Object.keys(observationModule).sort(), [
    "createNpcProductionObservationLedger",
    "formatNpcProductionObservationRecord"
  ]);
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/npcProductionObservationLedger.mjs", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /node:|\bfetch\b|setTimeout|setInterval/);
});

test("factory and public surface are exact, frozen, and redacted on invalid configuration", () => {
  const ledger = createNpcProductionObservationLedger({ gameSessionId: sessionId, capacity: 3 });
  assert.deepEqual(Object.keys(ledger), ["observe", "getSnapshot", "reset"]);
  assert.equal(Object.isFrozen(ledger), true);
  const symbolConfiguration = { gameSessionId: sessionId, capacity: 1 };
  symbolConfiguration[Symbol("extra")] = true;
  const accessorConfiguration = { gameSessionId: sessionId };
  Object.defineProperty(accessorConfiguration, "capacity", { enumerable: true, get() { throw new Error("sensitive-marker"); } });
  for (const value of [
    null,
    { gameSessionId: sessionId, capacity: 0 },
    { gameSessionId: sessionId, capacity: 1001 },
    { gameSessionId: sessionId, capacity: 1, extra: true },
    Object.assign(Object.create(null), { gameSessionId: sessionId, capacity: 1 }),
    symbolConfiguration,
    accessorConfiguration
  ]) {
    assert.throws(
      () => createNpcProductionObservationLedger(value),
      (error) => error instanceof TypeError
        && error.message === "Invalid NPC production observation ledger configuration."
    );
  }
});

test("route, controller, and orchestrator events map to one exact normalized schema", () => {
  const ledger = createNpcProductionObservationLedger({ gameSessionId: sessionId, capacity: 10 });
  ledger.observe(routeEvent());
  ledger.observe(controllerEvent());
  ledger.observe(orchestratorEvent());
  const snapshot = ledger.getSnapshot({ schemaVersion: 1, gameSessionId: sessionId, limit: 10 });
  assert.equal(snapshot.acceptedCount, 3);
  assert.equal(snapshot.rejectedCount, 0);
  assert.deepEqual(snapshot.records.map((record) => record.source), [
    "route", "delivery_controller", "delivery_orchestrator"
  ]);
  assert.deepEqual(snapshot.records.map((record) => record.observationOrder), [1, 2, 3]);
  assert.deepEqual(Object.keys(snapshot.records[0]), [
    "schemaVersion", "recordType", "observationOrder", "source", "gameSessionId",
    "triggerRequestId", "originatingInputRecordId", "reactionPlanId",
    "reactionAttemptId", "publicationId", "deliveryAttemptId", "deliveryAttemptOrder",
    "consumerId", "consumerGeneration", "sinkType", "attemptNumber",
    "sourceRuntimeOrder", "stage", "outcome", "code", "retryMode"
  ]);
  assert.deepEqual(snapshot.records[0], {
    schemaVersion: 1, recordType: "npc_production_observation", observationOrder: 1,
    source: "route", gameSessionId: sessionId, triggerRequestId: "trigger-1",
    originatingInputRecordId: "input-1", reactionPlanId: "plan-1",
    reactionAttemptId: "attempt-1", publicationId: null, deliveryAttemptId: null,
    deliveryAttemptOrder: null, consumerId: null, consumerGeneration: null,
    sinkType: null, attemptNumber: null, sourceRuntimeOrder: 7,
    stage: "commit", outcome: "committed", code: "committed", retryMode: null
  });
  assert.equal(snapshot.records[1].stage, "delivery_controller");
  assert.equal(snapshot.records[1].sinkType, "browser");
  assert.equal(snapshot.records[2].stage, "delivery_orchestrator");
  assert.equal(snapshot.records[2].consumerId, "browser-npc-main");
  assert.equal(snapshot.records[2].sinkType, null);
  assert.equal(snapshot.records[2].retryMode, "repeat_sink");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.records), true);
  assert.equal(Object.isFrozen(snapshot.records[0]), true);
});

test("malformed, wrong-session, accessor, symbol, proxy, and secret-bearing events fail closed without throwing", () => {
  const ledger = createNpcProductionObservationLedger({ gameSessionId: sessionId, capacity: 10 });
  const accessor = routeEvent();
  Object.defineProperty(accessor, "stage", { enumerable: true, get() { throw new Error("sensitive-marker"); } });
  const symbol = routeEvent();
  symbol[Symbol("sensitive-marker")] = true;
  const proxy = new Proxy(routeEvent(), { ownKeys() { throw new Error("sensitive-marker"); } });
  for (const value of [
    { ...routeEvent(), gameSessionId: "session-other" },
    { ...routeEvent(), rawPrompt: "sensitive-marker" },
    { ...routeEvent(), code: "sensitive marker" },
    accessor,
    symbol,
    proxy,
    null
  ]) assert.doesNotThrow(() => ledger.observe(value));
  const snapshot = ledger.getSnapshot({ schemaVersion: 1, gameSessionId: sessionId, limit: 10 });
  assert.equal(snapshot.acceptedCount, 0);
  assert.equal(snapshot.rejectedCount, 7);
  assert.equal(snapshot.records.length, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /sensitive-marker|rawPrompt/);
});

test("capacity evicts the oldest record while preserving monotonic orders and saturating-style counters", () => {
  const ledger = createNpcProductionObservationLedger({ gameSessionId: sessionId, capacity: 2 });
  ledger.observe(routeEvent({ runtimeOrder: 0 }));
  ledger.observe(routeEvent({ runtimeOrder: 1, stage: "provider", outcome: "started" }));
  ledger.observe(routeEvent({ runtimeOrder: 2, stage: "provider", outcome: "failed", code: "timeout" }));
  const snapshot = ledger.getSnapshot({ schemaVersion: 1, gameSessionId: sessionId, limit: 2 });
  assert.equal(snapshot.status, "active");
  assert.equal(snapshot.acceptedCount, 3);
  assert.equal(snapshot.evictedCount, 1);
  assert.equal(snapshot.nextObservationOrder, 4);
  assert.deepEqual(snapshot.records.map(({ observationOrder }) => observationOrder), [2, 3]);
});

test("last safe observation order is accepted once and all counters saturate without wrap", async () => {
  const boundaryModule = await loadLedgerWithPrivateInitializers({
    nextObservationOrder: Number.MAX_SAFE_INTEGER - 1,
    acceptedCount: Number.MAX_SAFE_INTEGER - 1,
    evictedCount: Number.MAX_SAFE_INTEGER - 1
  });
  const ledger = boundaryModule.createNpcProductionObservationLedger({ gameSessionId: sessionId, capacity: 1 });
  ledger.observe(routeEvent({ runtimeOrder: 0 }));
  ledger.observe(routeEvent({ runtimeOrder: 1 }));
  ledger.observe(routeEvent({ runtimeOrder: 2 }));
  const snapshot = ledger.getSnapshot({ schemaVersion: 1, gameSessionId: sessionId, limit: 1 });
  assert.equal(snapshot.status, "exhausted");
  assert.equal(snapshot.acceptedCount, Number.MAX_SAFE_INTEGER);
  assert.equal(snapshot.evictedCount, Number.MAX_SAFE_INTEGER);
  assert.equal(snapshot.nextObservationOrder, Number.MAX_SAFE_INTEGER);
  assert.equal(snapshot.records[0].observationOrder, Number.MAX_SAFE_INTEGER);

  const beforeReset = structuredClone(snapshot);
  assert.equal(ledger.reset(), undefined);
  assert.equal(ledger.reset(), undefined);
  const resetSnapshot = ledger.getSnapshot({ schemaVersion: 1, gameSessionId: sessionId, limit: 1 });
  assert.equal(resetSnapshot.status, "reset");
  assert.deepEqual(resetSnapshot.records, beforeReset.records);
  assert.equal(resetSnapshot.acceptedCount, beforeReset.acceptedCount);
  assert.equal(resetSnapshot.rejectedCount, beforeReset.rejectedCount);
  assert.equal(resetSnapshot.evictedCount, beforeReset.evictedCount);
  assert.equal(resetSnapshot.nextObservationOrder, beforeReset.nextObservationOrder);
  ledger.observe(routeEvent({ runtimeOrder: 3 }));
  assert.deepEqual(
    ledger.getSnapshot({ schemaVersion: 1, gameSessionId: sessionId, limit: 1 }),
    resetSnapshot
  );

  const rejectedBoundaryModule = await loadLedgerWithPrivateInitializers({
    rejectedCount: Number.MAX_SAFE_INTEGER - 1
  });
  const rejectedLedger = rejectedBoundaryModule.createNpcProductionObservationLedger({ gameSessionId: sessionId, capacity: 1 });
  rejectedLedger.observe(null);
  rejectedLedger.observe(null);
  assert.equal(
    rejectedLedger.getSnapshot({ schemaVersion: 1, gameSessionId: sessionId, limit: 1 }).rejectedCount,
    Number.MAX_SAFE_INTEGER
  );
});

test("snapshots return only the newest limit in ascending order and are detached from prior snapshots", () => {
  const ledger = createNpcProductionObservationLedger({ gameSessionId: sessionId, capacity: 4 });
  for (let runtimeOrder = 0; runtimeOrder < 4; runtimeOrder += 1) ledger.observe(routeEvent({ runtimeOrder }));
  const first = ledger.getSnapshot({ schemaVersion: 1, gameSessionId: sessionId, limit: 2 });
  const second = ledger.getSnapshot({ schemaVersion: 1, gameSessionId: sessionId, limit: 2 });
  assert.deepEqual(first.records.map(({ observationOrder }) => observationOrder), [3, 4]);
  assert.notEqual(first.records, second.records);
  assert.notEqual(first.records[0], second.records[0]);
  for (const input of [
    { schemaVersion: 1, gameSessionId: "wrong", limit: 1 },
    { schemaVersion: 1, gameSessionId: sessionId, limit: 0 },
    { schemaVersion: 1, gameSessionId: sessionId, limit: 5 },
    { schemaVersion: 1, gameSessionId: sessionId, limit: 1, extra: true }
  ]) assert.throws(() => ledger.getSnapshot(input), /Invalid NPC production observation snapshot request\./);
});

test("reset is idempotent, retains postmortem data, and ignores later observations", () => {
  const ledger = createNpcProductionObservationLedger({ gameSessionId: sessionId, capacity: 2 });
  ledger.observe(routeEvent());
  assert.equal(ledger.reset(), undefined);
  assert.equal(ledger.reset(), undefined);
  ledger.observe(controllerEvent());
  const snapshot = ledger.getSnapshot({ schemaVersion: 1, gameSessionId: sessionId, limit: 2 });
  assert.equal(snapshot.status, "reset");
  assert.equal(snapshot.acceptedCount, 1);
  assert.equal(snapshot.rejectedCount, 0);
  assert.equal(snapshot.records.length, 1);
});

test("formatter emits one exact redacted line and rejects malformed normalized records", () => {
  const ledger = createNpcProductionObservationLedger({ gameSessionId: sessionId, capacity: 2 });
  ledger.observe(routeEvent());
  const [record] = ledger.getSnapshot({ schemaVersion: 1, gameSessionId: sessionId, limit: 2 }).records;
  const line = formatNpcProductionObservationRecord(record);
  assert.equal(line, "#1 source=route stage=commit outcome=committed code=committed trigger=trigger-1 plan=plan-1 attempt=attempt-1 publication=- delivery=- attemptNumber=- retry=-");
  assert.equal(line.includes("\n"), false);
  assert.throws(
    () => formatNpcProductionObservationRecord({ ...record, rawResponse: "sensitive-marker" }),
    (error) => error instanceof TypeError && error.message === "Invalid NPC production observation record."
  );
});

test("repeat-sink and acknowledgement-only retry modes remain distinct in redacted projection", () => {
  const ledger = createNpcProductionObservationLedger({ gameSessionId: sessionId, capacity: 2 });
  ledger.observe(orchestratorEvent());
  ledger.observe(orchestratorEvent({
    deliveryId: "delivery-2",
    retryMode: "ack_only"
  }));
  const snapshot = ledger.getSnapshot({ schemaVersion: 1, gameSessionId: sessionId, limit: 2 });
  const lines = snapshot.records.map(formatNpcProductionObservationRecord);
  assert.match(lines[0], /outcome=retry_required[\s\S]*retry=repeat_sink$/);
  assert.match(lines[1], /outcome=retry_required[\s\S]*retry=ack_only$/);
  assert.doesNotMatch(lines.join("\n"), /receipt|retryToken|capability|rawResponse/);
});

test("source event objects remain unchanged and retained records are detached", () => {
  const ledger = createNpcProductionObservationLedger({ gameSessionId: sessionId, capacity: 2 });
  const event = controllerEvent();
  const before = structuredClone(event);
  ledger.observe(event);
  event.code = "changed_after_observation";
  const [record] = ledger.getSnapshot({ schemaVersion: 1, gameSessionId: sessionId, limit: 2 }).records;
  assert.deepEqual({ ...before }, controllerEvent());
  assert.equal(record.code, null);
});

function routeEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    observationType: "npc_structured_reaction_route",
    gameSessionId: sessionId,
    triggerRequestId: "trigger-1",
    originatingInputRecordId: "input-1",
    reactionPlanId: "plan-1",
    reactionAttemptId: "attempt-1",
    stage: "commit",
    outcome: "committed",
    code: "committed",
    runtimeOrder: 7,
    ...overrides
  };
}

function controllerEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    outcomeType: "npc_publication_sink_started",
    gameSessionId: sessionId,
    publicationId: "publication-1",
    consumerId: "browser-npc-main",
    consumerGeneration: 0,
    sinkType: "browser",
    deliveryAttemptId: "delivery-1",
    deliveryAttemptOrder: 0,
    attemptNumber: 1,
    code: null,
    runtimeOrder: 2,
    ...overrides
  };
}

function orchestratorEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventType: "npc_publication_delivery_orchestration",
    gameSessionId: sessionId,
    publicationId: "publication-1",
    sinkId: "browser-npc-main",
    deliveryId: "delivery-1",
    attemptNumber: 1,
    resultType: "retry_required",
    retryMode: "repeat_sink",
    terminalCode: "sink_failed",
    consumerGeneration: 0,
    ...overrides
  };
}

async function loadLedgerWithPrivateInitializers(initializers) {
  let source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/npcProductionObservationLedger.mjs", import.meta.url), "utf8"));
  source = source.replace(
    'import { ID_PATTERN } from "./conversation/domain.mjs";',
    "const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;"
  );
  for (const [name, value] of Object.entries(initializers)) {
    source = source.replace(`let ${name} = ${name === "nextObservationOrder" ? 1 : 0};`, `let ${name} = ${value};`);
  }
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}
