import { ID_PATTERN } from "./conversation/domain.mjs";

const ROUTE_FIELDS = Object.freeze([
  "schemaVersion", "observationType", "gameSessionId", "triggerRequestId",
  "originatingInputRecordId", "reactionPlanId", "reactionAttemptId", "stage",
  "outcome", "code", "runtimeOrder"
]);
const CONTROLLER_FIELDS = Object.freeze([
  "schemaVersion", "outcomeType", "gameSessionId", "publicationId", "consumerId",
  "consumerGeneration", "sinkType", "deliveryAttemptId", "deliveryAttemptOrder",
  "attemptNumber", "code", "runtimeOrder"
]);
const ORCHESTRATOR_FIELDS = Object.freeze([
  "schemaVersion", "eventType", "gameSessionId", "publicationId", "sinkId",
  "deliveryId", "attemptNumber", "resultType", "retryMode", "terminalCode",
  "consumerGeneration"
]);
const RECORD_FIELDS = Object.freeze([
  "schemaVersion", "recordType", "observationOrder", "source", "gameSessionId",
  "triggerRequestId", "originatingInputRecordId", "reactionPlanId",
  "reactionAttemptId", "publicationId", "deliveryAttemptId", "deliveryAttemptOrder",
  "consumerId", "consumerGeneration", "sinkType", "attemptNumber",
  "sourceRuntimeOrder", "stage", "outcome", "code", "retryMode"
]);
const SNAPSHOT_INPUT_FIELDS = Object.freeze(["schemaVersion", "gameSessionId", "limit"]);
const TOKEN_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SOURCES = new Set(["route", "delivery_controller", "delivery_orchestrator"]);
const MAXIMUM_CAPACITY = 1000;
const INVALID_CONFIGURATION = "Invalid NPC production observation ledger configuration.";
const INVALID_SNAPSHOT = "Invalid NPC production observation snapshot request.";
const INVALID_RECORD = "Invalid NPC production observation record.";

export function createNpcProductionObservationLedger(configuration) {
  const config = reconstructConfiguration(configuration);
  let status = "active";
  let nextObservationOrder = 1;
  let acceptedCount = 0;
  let rejectedCount = 0;
  let evictedCount = 0;
  const records = [];

  function observe(rawEvent) {
    if (status !== "active") return undefined;
    let normalized;
    try {
      normalized = normalizeEvent(rawEvent, config.gameSessionId, nextObservationOrder);
    } catch {
      rejectedCount = saturatingIncrement(rejectedCount);
      return undefined;
    }

    records.push(normalized);
    acceptedCount = saturatingIncrement(acceptedCount);
    if (records.length > config.capacity) {
      records.shift();
      evictedCount = saturatingIncrement(evictedCount);
    }
    if (nextObservationOrder === Number.MAX_SAFE_INTEGER) status = "exhausted";
    else nextObservationOrder += 1;
    return undefined;
  }

  function getSnapshot(input) {
    const request = reconstructSnapshotInput(input, config);
    const selected = records.slice(-request.limit).map((record) => deepFreeze({ ...record }));
    return deepFreeze({
      schemaVersion: 1,
      resultType: "npc_production_observation_snapshot",
      gameSessionId: config.gameSessionId,
      status,
      capacity: config.capacity,
      acceptedCount,
      rejectedCount,
      evictedCount,
      nextObservationOrder,
      records: selected
    });
  }

  function reset() {
    status = "reset";
    return undefined;
  }

  return deepFreeze({ observe, getSnapshot, reset });
}

export function formatNpcProductionObservationRecord(record) {
  let value;
  try {
    value = reconstructNormalizedRecord(record);
  } catch {
    throw new TypeError(INVALID_RECORD);
  }
  const show = (entry) => entry === null ? "-" : String(entry);
  return `#${value.observationOrder} source=${value.source} stage=${show(value.stage)} outcome=${show(value.outcome)} code=${show(value.code)} trigger=${show(value.triggerRequestId)} plan=${show(value.reactionPlanId)} attempt=${show(value.reactionAttemptId)} publication=${show(value.publicationId)} delivery=${show(value.deliveryAttemptId)} attemptNumber=${show(value.attemptNumber)} retry=${show(value.retryMode)}`;
}

function reconstructConfiguration(value) {
  try {
    const result = reconstructExactDataObject(value, ["gameSessionId", "capacity"]);
    if (!isId(result.gameSessionId)
        || !Number.isSafeInteger(result.capacity)
        || result.capacity < 1
        || result.capacity > MAXIMUM_CAPACITY) throw new TypeError();
    return result;
  } catch {
    throw new TypeError(INVALID_CONFIGURATION);
  }
}

function reconstructSnapshotInput(value, config) {
  try {
    const result = reconstructExactDataObject(value, SNAPSHOT_INPUT_FIELDS);
    if (result.schemaVersion !== 1
        || result.gameSessionId !== config.gameSessionId
        || !Number.isSafeInteger(result.limit)
        || result.limit < 1
        || result.limit > config.capacity) throw new TypeError();
    return result;
  } catch {
    throw new TypeError(INVALID_SNAPSHOT);
  }
}

function normalizeEvent(value, gameSessionId, observationOrder) {
  const keys = ownStringKeys(value);
  if (sameFields(keys, ROUTE_FIELDS)) return normalizeRoute(value, gameSessionId, observationOrder);
  if (sameFields(keys, CONTROLLER_FIELDS)) return normalizeController(value, gameSessionId, observationOrder);
  if (sameFields(keys, ORCHESTRATOR_FIELDS)) return normalizeOrchestrator(value, gameSessionId, observationOrder);
  throw new TypeError();
}

function normalizeRoute(value, gameSessionId, observationOrder) {
  const event = reconstructExactDataObject(value, ROUTE_FIELDS);
  if (event.schemaVersion !== 1
      || event.observationType !== "npc_structured_reaction_route"
      || event.gameSessionId !== gameSessionId
      || !isId(event.triggerRequestId)
      || !isId(event.originatingInputRecordId)
      || !isNullableId(event.reactionPlanId)
      || !isNullableId(event.reactionAttemptId)
      || !isToken(event.stage)
      || !isToken(event.outcome)
      || !isNullableToken(event.code)
      || !isNonnegativeSafe(event.runtimeOrder)) throw new TypeError();
  return makeRecord({
    observationOrder, source: "route", gameSessionId,
    triggerRequestId: event.triggerRequestId,
    originatingInputRecordId: event.originatingInputRecordId,
    reactionPlanId: event.reactionPlanId,
    reactionAttemptId: event.reactionAttemptId,
    sourceRuntimeOrder: event.runtimeOrder,
    stage: event.stage,
    outcome: event.outcome,
    code: event.code
  });
}

function normalizeController(value, gameSessionId, observationOrder) {
  const event = reconstructExactDataObject(value, CONTROLLER_FIELDS);
  if (event.schemaVersion !== 1
      || event.gameSessionId !== gameSessionId
      || !isToken(event.outcomeType)
      || !isNullableId(event.publicationId)
      || !isId(event.consumerId)
      || !isNonnegativeSafe(event.consumerGeneration)
      || !isSinkType(event.sinkType)
      || !isNullableId(event.deliveryAttemptId)
      || !isNullableNonnegativeSafe(event.deliveryAttemptOrder)
      || !isNullableAttemptNumber(event.attemptNumber)
      || !isNullableToken(event.code)
      || !isNonnegativeSafe(event.runtimeOrder)) throw new TypeError();
  return makeRecord({
    observationOrder, source: "delivery_controller", gameSessionId,
    publicationId: event.publicationId,
    deliveryAttemptId: event.deliveryAttemptId,
    deliveryAttemptOrder: event.deliveryAttemptOrder,
    consumerId: event.consumerId,
    consumerGeneration: event.consumerGeneration,
    sinkType: event.sinkType,
    attemptNumber: event.attemptNumber,
    sourceRuntimeOrder: event.runtimeOrder,
    stage: "delivery_controller",
    outcome: event.outcomeType,
    code: event.code
  });
}

function normalizeOrchestrator(value, gameSessionId, observationOrder) {
  const event = reconstructExactDataObject(value, ORCHESTRATOR_FIELDS);
  if (event.schemaVersion !== 1
      || event.eventType !== "npc_publication_delivery_orchestration"
      || event.gameSessionId !== gameSessionId
      || !isNullableId(event.publicationId)
      || !isId(event.sinkId)
      || !isNullableId(event.deliveryId)
      || !isNullableAttemptNumber(event.attemptNumber)
      || !isToken(event.resultType)
      || !isNullableToken(event.retryMode)
      || !isNullableToken(event.terminalCode)
      || !isNonnegativeSafe(event.consumerGeneration)) throw new TypeError();
  return makeRecord({
    observationOrder, source: "delivery_orchestrator", gameSessionId,
    publicationId: event.publicationId,
    deliveryAttemptId: event.deliveryId,
    consumerId: event.sinkId,
    consumerGeneration: event.consumerGeneration,
    attemptNumber: event.attemptNumber,
    stage: "delivery_orchestrator",
    outcome: event.resultType,
    code: event.terminalCode,
    retryMode: event.retryMode
  });
}

function makeRecord(fields) {
  return deepFreeze({
    schemaVersion: 1,
    recordType: "npc_production_observation",
    observationOrder: fields.observationOrder,
    source: fields.source,
    gameSessionId: fields.gameSessionId,
    triggerRequestId: fields.triggerRequestId ?? null,
    originatingInputRecordId: fields.originatingInputRecordId ?? null,
    reactionPlanId: fields.reactionPlanId ?? null,
    reactionAttemptId: fields.reactionAttemptId ?? null,
    publicationId: fields.publicationId ?? null,
    deliveryAttemptId: fields.deliveryAttemptId ?? null,
    deliveryAttemptOrder: fields.deliveryAttemptOrder ?? null,
    consumerId: fields.consumerId ?? null,
    consumerGeneration: fields.consumerGeneration ?? null,
    sinkType: fields.sinkType ?? null,
    attemptNumber: fields.attemptNumber ?? null,
    sourceRuntimeOrder: fields.sourceRuntimeOrder ?? null,
    stage: fields.stage ?? null,
    outcome: fields.outcome ?? null,
    code: fields.code ?? null,
    retryMode: fields.retryMode ?? null
  });
}

function reconstructNormalizedRecord(value) {
  const record = reconstructExactDataObject(value, RECORD_FIELDS);
  if (record.schemaVersion !== 1
      || record.recordType !== "npc_production_observation"
      || !Number.isSafeInteger(record.observationOrder)
      || record.observationOrder < 1
      || !SOURCES.has(record.source)
      || !isId(record.gameSessionId)
      || !isNullableId(record.triggerRequestId)
      || !isNullableId(record.originatingInputRecordId)
      || !isNullableId(record.reactionPlanId)
      || !isNullableId(record.reactionAttemptId)
      || !isNullableId(record.publicationId)
      || !isNullableId(record.deliveryAttemptId)
      || !isNullableNonnegativeSafe(record.deliveryAttemptOrder)
      || !isNullableId(record.consumerId)
      || !isNullableNonnegativeSafe(record.consumerGeneration)
      || !(record.sinkType === null || isSinkType(record.sinkType))
      || !isNullableAttemptNumber(record.attemptNumber)
      || !isNullableNonnegativeSafe(record.sourceRuntimeOrder)
      || !isNullableToken(record.stage)
      || !isNullableToken(record.outcome)
      || !isNullableToken(record.code)
      || !isNullableToken(record.retryMode)) throw new TypeError();
  if (record.source === "route" && !validRouteRecord(record)) throw new TypeError();
  if (record.source === "delivery_controller" && !validControllerRecord(record)) throw new TypeError();
  if (record.source === "delivery_orchestrator" && !validOrchestratorRecord(record)) throw new TypeError();
  return record;
}

function validRouteRecord(record) {
  return record.triggerRequestId !== null
    && record.originatingInputRecordId !== null
    && record.sourceRuntimeOrder !== null
    && record.stage !== null
    && record.outcome !== null
    && [record.publicationId, record.deliveryAttemptId, record.deliveryAttemptOrder,
      record.consumerId, record.consumerGeneration, record.sinkType, record.attemptNumber,
      record.retryMode].every((entry) => entry === null);
}

function validControllerRecord(record) {
  return record.consumerId !== null
    && record.consumerGeneration !== null
    && record.sinkType !== null
    && record.sourceRuntimeOrder !== null
    && record.stage === "delivery_controller"
    && record.outcome !== null
    && [record.triggerRequestId, record.originatingInputRecordId, record.reactionPlanId,
      record.reactionAttemptId, record.retryMode].every((entry) => entry === null);
}

function validOrchestratorRecord(record) {
  return record.consumerId !== null
    && record.consumerGeneration !== null
    && record.stage === "delivery_orchestrator"
    && record.outcome !== null
    && [record.triggerRequestId, record.originatingInputRecordId, record.reactionPlanId,
      record.reactionAttemptId, record.deliveryAttemptOrder, record.sinkType,
      record.sourceRuntimeOrder].every((entry) => entry === null);
}

function reconstructExactDataObject(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if (!sameFields(keys, fields)) throw new TypeError();
  const result = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, "value")) throw new TypeError();
    result[field] = descriptor.value;
  }
  return result;
}

function ownStringKeys(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) throw new TypeError();
  return keys;
}

function sameFields(keys, fields) {
  return keys.length === fields.length
    && keys.every((key) => typeof key === "string" && fields.includes(key));
}

function isId(value) { return typeof value === "string" && ID_PATTERN.test(value); }
function isNullableId(value) { return value === null || isId(value); }
function isNonnegativeSafe(value) { return Number.isSafeInteger(value) && value >= 0; }
function isNullableNonnegativeSafe(value) { return value === null || isNonnegativeSafe(value); }
function isNullableAttemptNumber(value) { return value === null || (Number.isSafeInteger(value) && value >= 1); }
function isToken(value) { return typeof value === "string" && TOKEN_PATTERN.test(value); }
function isNullableToken(value) { return value === null || isToken(value); }
function isSinkType(value) { return value === "browser" || value === "cli"; }
function saturatingIncrement(value) { return value === Number.MAX_SAFE_INTEGER ? value : value + 1; }

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, "value")) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}
