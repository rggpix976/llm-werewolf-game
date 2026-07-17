import { ID_PATTERN, SHA256_PATTERN } from "./conversation/domain.mjs";
import { validateReactionPlanReferences } from "./conversation/references.mjs";
import { resolveNpcCanonicalDeliveryPayload } from "./npcCanonicalRenderer.mjs";

export const NPC_PUBLICATION_DELIVERY_ERROR_CODES = Object.freeze([
  "npc_publication_not_found",
  "npc_publication_not_eligible",
  "npc_publication_already_acknowledged",
  "npc_delivery_order_blocked",
  "npc_delivery_in_progress",
  "npc_delivery_not_prepared",
  "npc_delivery_not_delivered",
  "npc_delivery_terminal",
  "npc_delivery_identity_conflict",
  "npc_delivery_capacity_exhausted",
  "sink_retry_exhausted",
  "stale_npc_delivery_session",
  "stale_npc_consumer_generation"
]);

export const NPC_PUBLICATION_ACKNOWLEDGEMENT_ERROR_CODES = Object.freeze([
  "npc_acknowledgement_not_delivered",
  "npc_acknowledgement_identity_mismatch",
  "npc_acknowledgement_conflict",
  "stale_npc_acknowledgement_session",
  "stale_npc_acknowledgement_generation"
]);

export const NPC_PUBLICATION_DELIVERY_INVARIANT_CODES = Object.freeze([
  "invalid_npc_delivery_controller_root",
  "invalid_npc_delivery_publication_graph",
  "invalid_npc_delivery_attempt",
  "invalid_npc_delivery_receipt",
  "invalid_npc_delivery_acknowledgement",
  "npc_delivery_identity_collision",
  "npc_delivery_order_corruption",
  "npc_delivery_state_transition_invalid"
]);

const FACTORY_FIELDS = Object.freeze([
  "gameSessionId", "initialConsumer", "createId",
  "listCommittedNpcPublicationGraphs", "getCanonicalRenderingContext",
  "nowMonotonicMs", "scheduleTimer", "cancelTimer",
  "createAbortController", "observer"
]);
const TEST_ORDER_FIELDS = Object.freeze([
  "consumerGeneration", "nextDeliveryAttemptOrder", "nextSinkStartedOrder",
  "nextSinkSucceededOrder", "nextAcknowledgedOrder", "nextObservationRuntimeOrder"
]);
const ROOT_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "consumer", "invalidated",
  "nextDeliveryAttemptOrder", "nextSinkStartedOrder", "nextSinkSucceededOrder",
  "nextAcknowledgedOrder", "currentRecordsByPublicationId", "attemptsById",
  "acknowledgementsByPublicationId", "retryTokensById"
]);
const DISCOVERY_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "consumerId", "consumerGeneration", "sinkType",
  "afterPublicationSlotOrder", "limit"
]);
const PREPARE_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "publicationId", "consumerId",
  "consumerGeneration", "sinkType"
]);
const REPLACEMENT_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "consumerId", "consumerGeneration", "sinkType",
  "nextConsumerId", "nextSinkType"
]);
const FAILURE_EVIDENCE_FIELDS = Object.freeze([
  "schemaVersion", "evidenceType", "sinkType", "failureCode", "visibleEffect", "cleanupStatus"
]);
const RECEIPT_FIELDS = Object.freeze([
  "schemaVersion", "receiptType", "receiptId", "gameSessionId", "publicationId",
  "consumerId", "consumerGeneration", "deliveryAttemptId", "deliveryAttemptOrder",
  "attemptNumber", "sinkType", "payloadFingerprint", "sinkSucceededOrder"
]);
const RETRY_LOOKUP_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "publicationId", "consumerId", "consumerGeneration",
  "sinkType", "deliveryAttemptId", "deliveryAttemptOrder", "attemptNumber",
  "payloadFingerprint", "retryTokenId"
]);
const ATTEMPT_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "publicationId", "consumerId", "consumerGeneration",
  "sinkType", "deliveryAttemptId", "deliveryAttemptOrder", "attemptNumber",
  "publicationSlotOrder", "recordAppendOrder", "state", "abandonedFromState",
  "payloadFingerprint", "sinkStartedOrder", "sinkSucceededOrder", "acknowledgedOrder",
  "failure", "receiptId", "retryTokenId"
]);
const RECORD_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "publicationId", "consumerId", "consumerGeneration",
  "sinkType", "publicationSlotOrder", "recordAppendOrder", "state", "currentAttemptId"
]);
const TOKEN_FIELDS = Object.freeze([
  "schemaVersion", "tokenType", "retryTokenId", "gameSessionId", "publicationId",
  "consumerId", "consumerGeneration", "deliveryAttemptId", "deliveryAttemptOrder",
  "attemptNumber", "sinkType", "payloadFingerprint", "retryKind"
]);
const ACK_FIELDS = Object.freeze([
  "schemaVersion", "acknowledgementType", "gameSessionId", "publicationId", "consumerId",
  "consumerGeneration", "deliveryAttemptId", "deliveryAttemptOrder", "attemptNumber",
  "sinkType", "receiptId", "payloadFingerprint", "acknowledgedOrder"
]);
const REQUEST_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "consumerId", "consumerGeneration", "sinkType",
  "deliveryAttemptId", "deliveryAttemptOrder", "attemptNumber", "publicationSlotOrder",
  "recordAppendOrder", "payload"
]);

const MAX_CURRENT_RECORDS = 1024;
const MAX_ATTEMPTS = 3072;
const MAX_PER_PUBLICATION_ATTEMPTS = 3;
const SINK_DEADLINE_MS = 15000;
const CLEANUP_GRACE_MS = 1000;
const SETTLEMENT_CAPABILITY_BRAND = Symbol("NpcPublicationSettlementCapability");
const ACTIVE_BROWSER_FAILURES = new Set([
  "browser_sink_container_missing", "browser_sink_attachment_failed", "browser_sink_bookkeeping_failed"
]);
const ACTIVE_CLI_FAILURES = new Set(["cli_sink_write_failed"]);
const FAILURE_CODES = new Set([...ACTIVE_BROWSER_FAILURES, ...ACTIVE_CLI_FAILURES, "sink_timeout", "sink_aborted"]);
const ACTIVE_ATTEMPT_STATES = new Set(["prepared", "in_flight", "sink_succeeded", "failed_retryable"]);
const RECORD_STATES = new Set([
  "pending", "prepared", "in_flight", "sink_succeeded", "failed_retryable",
  "failed_terminal", "acknowledged", "abandoned"
]);

export class NpcPublicationDeliveryError extends Error {
  constructor(code) {
    super("NPC publication delivery failed");
    defineError(this, "NpcPublicationDeliveryError", code);
  }
}

export class NpcPublicationAcknowledgementError extends Error {
  constructor(code) {
    super("NPC publication acknowledgement failed");
    defineError(this, "NpcPublicationAcknowledgementError", code);
  }
}

export class NpcPublicationDeliveryInvariantError extends Error {
  constructor(code) {
    super("NPC publication delivery invariant failed");
    defineError(this, "NpcPublicationDeliveryInvariantError", code);
  }
}

function defineError(error, name, code) {
  Object.defineProperty(error, "name", { configurable: true, enumerable: false, value: name, writable: true });
  Object.defineProperty(error, "code", { configurable: false, enumerable: false, value: code, writable: false });
}

function deliveryError(code) {
  if (!NPC_PUBLICATION_DELIVERY_ERROR_CODES.includes(code)) throw new TypeError("invalid delivery error code");
  return new NpcPublicationDeliveryError(code);
}

function acknowledgementError(code) {
  if (!NPC_PUBLICATION_ACKNOWLEDGEMENT_ERROR_CODES.includes(code)) throw new TypeError("invalid acknowledgement error code");
  return new NpcPublicationAcknowledgementError(code);
}

function invariant(code) {
  if (!NPC_PUBLICATION_DELIVERY_INVARIANT_CODES.includes(code)) throw new TypeError("invalid delivery invariant code");
  return new NpcPublicationDeliveryInvariantError(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length
    && keys.every((key) => typeof key === "string")
    && fields.every((field) => Object.hasOwn(value, field));
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, "value")) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function frozen(value) {
  return deepFreeze(value);
}

function isId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isFingerprint(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isSafe(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isSink(value) {
  return value === "browser" || value === "cli";
}

function cloneIndex(index) {
  return Object.assign(Object.create(null), index);
}

function exactIndexKeys(index) {
  const keys = Reflect.ownKeys(index);
  if (keys.some((key) => typeof key !== "string")) throw invariant("invalid_npc_delivery_controller_root");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(index, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw invariant("invalid_npc_delivery_controller_root");
  }
  return keys;
}

function makeRoot(gameSessionId, consumer, orders) {
  return freezeRoot({
    schemaVersion: 1,
    gameSessionId,
    consumer: frozen({ ...consumer }),
    invalidated: false,
    nextDeliveryAttemptOrder: orders.nextDeliveryAttemptOrder,
    nextSinkStartedOrder: orders.nextSinkStartedOrder,
    nextSinkSucceededOrder: orders.nextSinkSucceededOrder,
    nextAcknowledgedOrder: orders.nextAcknowledgedOrder,
    currentRecordsByPublicationId: Object.create(null),
    attemptsById: Object.create(null),
    acknowledgementsByPublicationId: Object.create(null),
    retryTokensById: Object.create(null)
  });
}

function freezeRoot(root) {
  return deepFreeze(root);
}

function detachedRoot(root) {
  return {
    ...root,
    consumer: { ...root.consumer },
    currentRecordsByPublicationId: cloneIndex(root.currentRecordsByPublicationId),
    attemptsById: cloneIndex(root.attemptsById),
    acknowledgementsByPublicationId: cloneIndex(root.acknowledgementsByPublicationId),
    retryTokensById: cloneIndex(root.retryTokensById)
  };
}

function sameFields(left, right, fields) {
  return fields.every((field) => left[field] === right[field]);
}

function validReceiptShape(value) {
  return hasExactFields(value, RECEIPT_FIELDS)
    && value.schemaVersion === 1
    && value.receiptType === "npc_sink_success"
    && isId(value.receiptId)
    && isId(value.gameSessionId)
    && isId(value.publicationId)
    && isId(value.consumerId)
    && isSafe(value.consumerGeneration)
    && isId(value.deliveryAttemptId)
    && isSafe(value.deliveryAttemptOrder)
    && isSafe(value.attemptNumber, 1, 3)
    && isSink(value.sinkType)
    && isFingerprint(value.payloadFingerprint)
    && isSafe(value.sinkSucceededOrder);
}

function validRequestShape(value) {
  return hasExactFields(value, REQUEST_FIELDS)
    && value.schemaVersion === 1
    && isId(value.gameSessionId)
    && isId(value.consumerId)
    && isSafe(value.consumerGeneration)
    && isSink(value.sinkType)
    && isId(value.deliveryAttemptId)
    && isSafe(value.deliveryAttemptOrder)
    && isSafe(value.attemptNumber, 1, 3)
    && isSafe(value.publicationSlotOrder)
    && isSafe(value.recordAppendOrder)
    && isPlainObject(value.payload)
    && isFingerprint(value.payload.payloadFingerprint);
}

function validFailure(value) {
  if (!hasExactFields(value, ["schemaVersion", "failureType", "code", "disposition"]) || value.schemaVersion !== 1) return false;
  if (value.failureType === "npc_delivery_resolution") return ["canonical_render_failed", "canonical_render_limit_exceeded"].includes(value.code) && value.disposition === "terminal";
  if (value.failureType !== "npc_delivery_transport") return false;
  const codes = new Set([...ACTIVE_BROWSER_FAILURES, ...ACTIVE_CLI_FAILURES, "sink_timeout", "sink_retry_exhausted"]);
  if (!codes.has(value.code) || !["retry_sink", "terminal_exhausted", "terminal_ambiguous"].includes(value.disposition)) return false;
  if (value.disposition === "terminal_exhausted") return value.code === "sink_retry_exhausted";
  if (value.code === "sink_retry_exhausted") return false;
  return true;
}

function validateFactory(options, testing) {
  const allowed = testing
    ? [...FACTORY_FIELDS, "resolveCanonicalDeliveryPayloadForTesting", "initialRuntimeOrdersForTesting", "beforeRootPublicationForTesting", "beforeCapabilityRegistryPublicationForTesting"]
    : FACTORY_FIELDS;
  if (!hasExactFields(options, allowed)) throw invariant("invalid_npc_delivery_controller_root");
  if (!isId(options.gameSessionId)
      || !hasExactFields(options.initialConsumer, ["consumerId", "sinkType"])
      || !isId(options.initialConsumer.consumerId)
      || !isSink(options.initialConsumer.sinkType)) {
    throw invariant("invalid_npc_delivery_controller_root");
  }
  for (const field of ["createId", "listCommittedNpcPublicationGraphs", "getCanonicalRenderingContext", "nowMonotonicMs", "scheduleTimer", "cancelTimer", "createAbortController", "observer"]) {
    if (typeof options[field] !== "function") throw invariant("invalid_npc_delivery_controller_root");
  }
  if (testing) {
    if (typeof options.resolveCanonicalDeliveryPayloadForTesting !== "function"
        || (options.beforeRootPublicationForTesting !== null && typeof options.beforeRootPublicationForTesting !== "function")
        || (options.beforeCapabilityRegistryPublicationForTesting !== null && typeof options.beforeCapabilityRegistryPublicationForTesting !== "function")
        || !hasExactFields(options.initialRuntimeOrdersForTesting, TEST_ORDER_FIELDS)
        || !TEST_ORDER_FIELDS.every((field) => isSafe(options.initialRuntimeOrdersForTesting[field]))) {
      throw invariant("invalid_npc_delivery_controller_root");
    }
  }
}

function validateAttempt(attempt) {
  if (!hasExactFields(attempt, ATTEMPT_FIELDS)
      || attempt.schemaVersion !== 1
      || !isId(attempt.gameSessionId)
      || !isId(attempt.publicationId)
      || !isId(attempt.consumerId)
      || !isSafe(attempt.consumerGeneration)
      || !isSink(attempt.sinkType)
      || !isId(attempt.deliveryAttemptId)
      || !isSafe(attempt.deliveryAttemptOrder)
      || !isSafe(attempt.attemptNumber, 1, 3)
      || !isSafe(attempt.publicationSlotOrder)
      || !isSafe(attempt.recordAppendOrder)
      || !new Set(["prepared", "in_flight", "sink_succeeded", "failed_retryable", "failed_terminal", "acknowledged", "abandoned"]).has(attempt.state)
      || !(attempt.abandonedFromState === null || new Set(["prepared", "in_flight", "sink_succeeded", "failed_retryable"]).has(attempt.abandonedFromState))
      || !(attempt.payloadFingerprint === null || isFingerprint(attempt.payloadFingerprint))
      || ![attempt.sinkStartedOrder, attempt.sinkSucceededOrder, attempt.acknowledgedOrder].every((value) => value === null || isSafe(value))
      || !(attempt.failure === null || validFailure(attempt.failure))
      || !(attempt.receiptId === null || isId(attempt.receiptId))
      || !(attempt.retryTokenId === null || isId(attempt.retryTokenId))) {
    throw invariant("invalid_npc_delivery_controller_root");
  }
  if (attempt.state === "prepared" && (attempt.payloadFingerprint === null || attempt.sinkStartedOrder !== null || attempt.failure !== null || attempt.receiptId !== null || attempt.retryTokenId !== null)) throw invariant("invalid_npc_delivery_controller_root");
  if (attempt.state === "in_flight" && (attempt.payloadFingerprint === null || attempt.sinkStartedOrder === null || attempt.failure !== null || attempt.receiptId !== null || attempt.retryTokenId !== null)) throw invariant("invalid_npc_delivery_controller_root");
  if (attempt.state === "sink_succeeded" && (attempt.payloadFingerprint === null || attempt.sinkStartedOrder === null || attempt.sinkSucceededOrder === null || attempt.failure !== null || attempt.receiptId === null || attempt.retryTokenId === null)) throw invariant("invalid_npc_delivery_controller_root");
  if (attempt.state === "failed_retryable" && (attempt.payloadFingerprint === null || attempt.sinkStartedOrder === null || attempt.failure?.failureType !== "npc_delivery_transport" || attempt.failure.disposition !== "retry_sink" || attempt.receiptId !== null || attempt.retryTokenId === null)) throw invariant("invalid_npc_delivery_controller_root");
  if (attempt.state === "failed_terminal" && (attempt.failure === null || attempt.receiptId !== null || attempt.retryTokenId !== null || attempt.acknowledgedOrder !== null || (attempt.payloadFingerprint === null) !== (attempt.sinkStartedOrder === null) || (attempt.payloadFingerprint === null ? attempt.failure.failureType !== "npc_delivery_resolution" : attempt.failure.failureType !== "npc_delivery_transport" || !["terminal_exhausted", "terminal_ambiguous"].includes(attempt.failure.disposition)))) throw invariant("invalid_npc_delivery_controller_root");
  if (attempt.state === "acknowledged" && (attempt.payloadFingerprint === null || attempt.sinkStartedOrder === null || attempt.sinkSucceededOrder === null || attempt.acknowledgedOrder === null || attempt.failure !== null || attempt.receiptId === null || attempt.retryTokenId !== null)) throw invariant("invalid_npc_delivery_controller_root");
  if (attempt.state === "abandoned" && (attempt.abandonedFromState === null || attempt.retryTokenId !== null || attempt.acknowledgedOrder !== null)) throw invariant("invalid_npc_delivery_controller_root");
  if (attempt.state !== "abandoned" && attempt.abandonedFromState !== null) throw invariant("invalid_npc_delivery_controller_root");
}

function validateRoot(root) {
  if (!hasExactFields(root, ROOT_FIELDS)
      || root.schemaVersion !== 1
      || !isId(root.gameSessionId)
      || !hasExactFields(root.consumer, ["consumerId", "consumerGeneration", "sinkType"])
      || !isId(root.consumer.consumerId)
      || !isSafe(root.consumer.consumerGeneration)
      || !isSink(root.consumer.sinkType)
      || typeof root.invalidated !== "boolean"
      || ![root.nextDeliveryAttemptOrder, root.nextSinkStartedOrder, root.nextSinkSucceededOrder, root.nextAcknowledgedOrder].every((value) => isSafe(value))) {
    throw invariant("invalid_npc_delivery_controller_root");
  }
  for (const name of ["currentRecordsByPublicationId", "attemptsById", "acknowledgementsByPublicationId", "retryTokensById"]) {
    if (!isPlainObject(root[name])) throw invariant("invalid_npc_delivery_controller_root");
    exactIndexKeys(root[name]);
  }
  if (Object.keys(root.currentRecordsByPublicationId).length > MAX_CURRENT_RECORDS || Object.keys(root.attemptsById).length > MAX_ATTEMPTS) throw invariant("invalid_npc_delivery_controller_root");
  const attemptOrders = new Set();
  const attemptsPerPublication = new Map();
  for (const [key, attempt] of Object.entries(root.attemptsById)) {
    validateAttempt(attempt);
    if (key !== attempt.deliveryAttemptId || attempt.gameSessionId !== root.gameSessionId || attemptOrders.has(attempt.deliveryAttemptOrder) || attempt.deliveryAttemptOrder >= root.nextDeliveryAttemptOrder || (attempt.sinkStartedOrder !== null && attempt.sinkStartedOrder >= root.nextSinkStartedOrder) || (attempt.sinkSucceededOrder !== null && attempt.sinkSucceededOrder >= root.nextSinkSucceededOrder) || (attempt.acknowledgedOrder !== null && attempt.acknowledgedOrder >= root.nextAcknowledgedOrder)) throw invariant("invalid_npc_delivery_controller_root");
    attemptOrders.add(attempt.deliveryAttemptOrder);
    attemptsPerPublication.set(attempt.publicationId, (attemptsPerPublication.get(attempt.publicationId) ?? 0) + 1);
    if (attemptsPerPublication.get(attempt.publicationId) > MAX_PER_PUBLICATION_ATTEMPTS) throw invariant("invalid_npc_delivery_controller_root");
  }
  const currentSlots = new Set();
  for (const [key, record] of Object.entries(root.currentRecordsByPublicationId)) {
    if (!hasExactFields(record, RECORD_FIELDS) || record.schemaVersion !== 1 || key !== record.publicationId || record.gameSessionId !== root.gameSessionId || !isId(key) || !isId(record.consumerId) || !isSafe(record.consumerGeneration) || !isSink(record.sinkType) || !isSafe(record.publicationSlotOrder) || !isSafe(record.recordAppendOrder) || !RECORD_STATES.has(record.state) || !(record.currentAttemptId === null || isId(record.currentAttemptId))) throw invariant("invalid_npc_delivery_controller_root");
    if (currentSlots.has(record.publicationSlotOrder)) throw invariant("invalid_npc_delivery_controller_root");
    currentSlots.add(record.publicationSlotOrder);
    if (!["acknowledged", "failed_terminal", "abandoned"].includes(record.state) && (record.consumerId !== root.consumer.consumerId || record.consumerGeneration !== root.consumer.consumerGeneration || record.sinkType !== root.consumer.sinkType)) throw invariant("invalid_npc_delivery_controller_root");
    if (record.state === "pending") {
      if (record.currentAttemptId !== null) throw invariant("invalid_npc_delivery_controller_root");
    } else {
      const attempt = root.attemptsById[record.currentAttemptId];
      if (!attempt || attempt.publicationId !== key || attempt.state !== record.state || attempt.consumerId !== record.consumerId || attempt.consumerGeneration !== record.consumerGeneration || attempt.sinkType !== record.sinkType) throw invariant("invalid_npc_delivery_controller_root");
    }
  }
  for (const [key, token] of Object.entries(root.retryTokensById)) {
    if (!hasExactFields(token, TOKEN_FIELDS) || key !== token.retryTokenId || token.schemaVersion !== 1 || token.tokenType !== "npc_delivery_retry" || token.gameSessionId !== root.gameSessionId || !isId(key) || !isId(token.publicationId) || !isId(token.consumerId) || !isSafe(token.consumerGeneration) || !isId(token.deliveryAttemptId) || !isSafe(token.deliveryAttemptOrder) || !isSafe(token.attemptNumber, 1, 3) || !isSink(token.sinkType) || !isFingerprint(token.payloadFingerprint) || !["repeat_sink", "ack_only"].includes(token.retryKind)) throw invariant("invalid_npc_delivery_controller_root");
    const attempt = root.attemptsById[token.deliveryAttemptId];
    if (!attempt || attempt.retryTokenId !== key || attempt.publicationId !== token.publicationId || attempt.consumerId !== token.consumerId || attempt.consumerGeneration !== token.consumerGeneration || attempt.sinkType !== token.sinkType || attempt.deliveryAttemptOrder !== token.deliveryAttemptOrder || attempt.attemptNumber !== token.attemptNumber || attempt.payloadFingerprint !== token.payloadFingerprint || (token.retryKind === "repeat_sink" ? attempt.state !== "failed_retryable" : attempt.state !== "sink_succeeded")) throw invariant("invalid_npc_delivery_controller_root");
  }
  for (const [key, acknowledgement] of Object.entries(root.acknowledgementsByPublicationId)) {
    if (!hasExactFields(acknowledgement, ACK_FIELDS) || key !== acknowledgement.publicationId || acknowledgement.schemaVersion !== 1 || acknowledgement.acknowledgementType !== "npc_publication_acknowledged" || acknowledgement.gameSessionId !== root.gameSessionId || !isId(key) || !isId(acknowledgement.consumerId) || !isSafe(acknowledgement.consumerGeneration) || !isId(acknowledgement.deliveryAttemptId) || !isSafe(acknowledgement.deliveryAttemptOrder) || !isSafe(acknowledgement.attemptNumber, 1, 3) || !isSink(acknowledgement.sinkType) || !isId(acknowledgement.receiptId) || !isFingerprint(acknowledgement.payloadFingerprint) || !isSafe(acknowledgement.acknowledgedOrder)) throw invariant("invalid_npc_delivery_controller_root");
    const attempt = root.attemptsById[acknowledgement.deliveryAttemptId];
    if (!attempt || attempt.state !== "acknowledged" || attempt.publicationId !== key || attempt.receiptId !== acknowledgement.receiptId || attempt.payloadFingerprint !== acknowledgement.payloadFingerprint || attempt.acknowledgedOrder !== acknowledgement.acknowledgedOrder) throw invariant("invalid_npc_delivery_controller_root");
  }
  return true;
}

function createController(options, testing = false) {
  validateFactory(options, testing);
  const initialOrders = testing ? options.initialRuntimeOrdersForTesting : Object.fromEntries(TEST_ORDER_FIELDS.map((field) => [field, 0]));
  const renderer = testing ? options.resolveCanonicalDeliveryPayloadForTesting : resolveNpcCanonicalDeliveryPayload;
  const beforeRootPublication = testing ? options.beforeRootPublicationForTesting : null;
  const beforeCapabilityPublication = testing ? options.beforeCapabilityRegistryPublicationForTesting : null;
  let root = makeRoot(options.gameSessionId, {
    consumerId: options.initialConsumer.consumerId,
    consumerGeneration: initialOrders.consumerGeneration,
    sinkType: options.initialConsumer.sinkType
  }, initialOrders);
  let nextObservationRuntimeOrder = initialOrders.nextObservationRuntimeOrder;
  let observerAvailable = true;
  let invalidated = false;
  let resetting = false;
  let lastClock = null;
  let timerGeneration = 0;
  const requests = new Map();
  const payloads = new Map();
  const receiptsById = new Map();
  const receiptsByAttemptId = new Map();
  const exactTokens = new Map();
  const activeCapabilities = new WeakMap();
  const invalidatedIds = new Set();
  const gates = new Map();

  function currentRoot() {
    if (invalidated || resetting || !root || root.invalidated) throw deliveryError("stale_npc_delivery_session");
    validateRoot(root);
    return root;
  }

  function publish(nextRoot) {
    validateRoot(nextRoot);
    if (beforeRootPublication) beforeRootPublication(nextRoot);
    validateRoot(nextRoot);
    root = freezeRoot(nextRoot);
  }

  function validateSession(value, acknowledgement = false) {
    if (invalidated || resetting || !root || root.invalidated || value !== options.gameSessionId) throw acknowledgement ? acknowledgementError("stale_npc_acknowledgement_session") : deliveryError("stale_npc_delivery_session");
  }

  function ensureLive(acknowledgement = false) {
    if (invalidated || resetting || !root || root.invalidated) throw acknowledgement ? acknowledgementError("stale_npc_acknowledgement_session") : deliveryError("stale_npc_delivery_session");
  }

  function validateConsumer(input) {
    const consumer = currentRoot().consumer;
    if (input.consumerId !== consumer.consumerId || input.consumerGeneration !== consumer.consumerGeneration || input.sinkType !== consumer.sinkType) throw deliveryError("stale_npc_consumer_generation");
    return consumer;
  }

  function observe(outcomeType, attempt = null, code = null, consumer = root?.consumer ?? null) {
    if (!observerAvailable || invalidated || !consumer) return;
    const runtimeOrder = nextObservationRuntimeOrder;
    if (runtimeOrder === Number.MAX_SAFE_INTEGER) observerAvailable = false;
    else nextObservationRuntimeOrder += 1;
    const observation = frozen({
      schemaVersion: 1,
      outcomeType,
      gameSessionId: options.gameSessionId,
      publicationId: attempt?.publicationId ?? null,
      consumerId: attempt?.consumerId ?? consumer.consumerId,
      consumerGeneration: attempt?.consumerGeneration ?? consumer.consumerGeneration,
      sinkType: attempt?.sinkType ?? consumer.sinkType,
      deliveryAttemptId: attempt?.deliveryAttemptId ?? null,
      deliveryAttemptOrder: attempt?.deliveryAttemptOrder ?? null,
      attemptNumber: attempt?.attemptNumber ?? null,
      code,
      runtimeOrder
    });
    try { options.observer(observation); } catch { /* observer isolation */ }
  }

  function readClock() {
    let value;
    try { value = options.nowMonotonicMs(); } catch { throw invariant("invalid_npc_delivery_attempt"); }
    if (!Number.isFinite(value) || value < 0 || (lastClock !== null && value < lastClock)) throw invariant("invalid_npc_delivery_attempt");
    lastClock = value;
    return value;
  }

  function ensureOrder(counter) {
    if (counter === Number.MAX_SAFE_INTEGER) throw invariant("npc_delivery_order_corruption");
  }

  function allocateId(stagedIds = null) {
    let candidate;
    try { candidate = options.createId(); } catch { throw invariant("npc_delivery_identity_collision"); }
    if (!isId(candidate) || root.currentRecordsByPublicationId[candidate] || root.attemptsById[candidate] || root.acknowledgementsByPublicationId[candidate] || root.retryTokensById[candidate] || receiptsById.has(candidate) || invalidatedIds.has(candidate) || stagedIds?.has(candidate)) throw invariant("npc_delivery_identity_collision");
    stagedIds?.add(candidate);
    return candidate;
  }

  function listGraphs() {
    let graphs;
    try { graphs = options.listCommittedNpcPublicationGraphs(frozen({ gameSessionId: options.gameSessionId })); } catch { throw invariant("invalid_npc_delivery_publication_graph"); }
    if (!Array.isArray(graphs)) throw invariant("invalid_npc_delivery_publication_graph");
    let previousSlot = -1;
    const ids = new Set();
    const graphsById = new Map();
    for (let index = 0; index < graphs.length; index += 1) {
      if (!Object.hasOwn(graphs, index)) throw invariant("invalid_npc_delivery_publication_graph");
      const graph = graphs[index];
      try { validateReactionPlanReferences(graph?.reactionPlan, graph); } catch { throw invariant("invalid_npc_delivery_publication_graph"); }
      const publication = graph.publication;
      if (graph.contextType !== "committed_graph" || publication?.recordType !== "npc_canonical_published" || graph.idempotencyRecord?.gameSessionId !== options.gameSessionId || !isSafe(publication.publicationSlotOrder) || publication.publicationSlotOrder <= previousSlot || ids.has(publication.publicationId)) throw invariant("invalid_npc_delivery_publication_graph");
      previousSlot = publication.publicationSlotOrder;
      ids.add(publication.publicationId);
      graphsById.set(publication.publicationId, graph);
    }
    for (const [publicationId, record] of Object.entries(root.currentRecordsByPublicationId)) {
      const graph = graphsById.get(publicationId);
      if (!graph || graph.publication.publicationSlotOrder !== record.publicationSlotOrder || graph.publication.recordAppendOrder !== record.recordAppendOrder) throw invariant("invalid_npc_delivery_publication_graph");
    }
    return graphs;
  }

  function unresolvedHead(graphs) {
    for (const graph of graphs) {
      const publicationId = graph.publication.publicationId;
      const record = root.currentRecordsByPublicationId[publicationId];
      if (!record || record.state !== "acknowledged") return graph;
    }
    return null;
  }

  function pendingRecord(graph, consumer = root.consumer) {
    return frozen({
      schemaVersion: 1,
      gameSessionId: options.gameSessionId,
      publicationId: graph.publication.publicationId,
      consumerId: consumer.consumerId,
      consumerGeneration: consumer.consumerGeneration,
      sinkType: consumer.sinkType,
      publicationSlotOrder: graph.publication.publicationSlotOrder,
      recordAppendOrder: graph.publication.recordAppendOrder,
      state: "pending",
      currentAttemptId: null
    });
  }

  function summary(graph, record) {
    const attempt = record.currentAttemptId ? root.attemptsById[record.currentAttemptId] : null;
    return frozen({
      schemaVersion: 1,
      summaryType: "npc_publication_delivery",
      gameSessionId: options.gameSessionId,
      publicationId: graph.publication.publicationId,
      reactionPlanId: graph.publication.reactionPlanId,
      actorId: graph.publication.actorId,
      publicationSlotOrder: graph.publication.publicationSlotOrder,
      recordAppendOrder: graph.publication.recordAppendOrder,
      consumerId: record.consumerId,
      consumerGeneration: record.consumerGeneration,
      sinkType: record.sinkType,
      state: record.state,
      currentAttemptId: attempt?.deliveryAttemptId ?? null,
      retryTokenId: attempt?.retryTokenId ?? null
    });
  }

  function discoverPendingNpcPublications(input) {
    ensureLive();
    if (!hasExactFields(input, DISCOVERY_FIELDS) || input.schemaVersion !== 1 || !isId(input.gameSessionId) || !isId(input.consumerId) || !isSafe(input.consumerGeneration) || !isSink(input.sinkType) || !(input.afterPublicationSlotOrder === null || isSafe(input.afterPublicationSlotOrder)) || !isSafe(input.limit, 1, 32)) throw invariant("invalid_npc_delivery_attempt");
    validateSession(input.gameSessionId);
    validateConsumer(input);
    const graphs = listGraphs();
    const head = unresolvedHead(graphs);
    if (!head) return frozen([]);
    const publication = head.publication;
    let record = root.currentRecordsByPublicationId[publication.publicationId];
    if (!record) {
      if (Object.keys(root.currentRecordsByPublicationId).length >= MAX_CURRENT_RECORDS) throw deliveryError("npc_delivery_capacity_exhausted");
      const next = detachedRoot(root);
      record = pendingRecord(head);
      next.currentRecordsByPublicationId[publication.publicationId] = record;
      publish(next);
    }
    if (input.afterPublicationSlotOrder !== null && publication.publicationSlotOrder <= input.afterPublicationSlotOrder) return frozen([]);
    if (!["pending", "failed_retryable", "sink_succeeded"].includes(record.state)) return frozen([]);
    return frozen([summary(head, record)]);
  }

  function baseAttempt(graph, deliveryAttemptId, deliveryAttemptOrder, attemptNumber, payloadFingerprint) {
    return {
      schemaVersion: 1,
      gameSessionId: options.gameSessionId,
      publicationId: graph.publication.publicationId,
      consumerId: root.consumer.consumerId,
      consumerGeneration: root.consumer.consumerGeneration,
      sinkType: root.consumer.sinkType,
      deliveryAttemptId,
      deliveryAttemptOrder,
      attemptNumber,
      publicationSlotOrder: graph.publication.publicationSlotOrder,
      recordAppendOrder: graph.publication.recordAppendOrder,
      state: "prepared",
      abandonedFromState: null,
      payloadFingerprint,
      sinkStartedOrder: null,
      sinkSucceededOrder: null,
      acknowledgedOrder: null,
      failure: null,
      receiptId: null,
      retryTokenId: null
    };
  }

  function currentRecordForAttempt(attempt, state = attempt.state) {
    return frozen({
      schemaVersion: 1,
      gameSessionId: attempt.gameSessionId,
      publicationId: attempt.publicationId,
      consumerId: attempt.consumerId,
      consumerGeneration: attempt.consumerGeneration,
      sinkType: attempt.sinkType,
      publicationSlotOrder: attempt.publicationSlotOrder,
      recordAppendOrder: attempt.recordAppendOrder,
      state,
      currentAttemptId: attempt.deliveryAttemptId
    });
  }

  function requestFor(attempt, payload) {
    return frozen({
      schemaVersion: 1,
      gameSessionId: attempt.gameSessionId,
      consumerId: attempt.consumerId,
      consumerGeneration: attempt.consumerGeneration,
      sinkType: attempt.sinkType,
      deliveryAttemptId: attempt.deliveryAttemptId,
      deliveryAttemptOrder: attempt.deliveryAttemptOrder,
      attemptNumber: attempt.attemptNumber,
      publicationSlotOrder: attempt.publicationSlotOrder,
      recordAppendOrder: attempt.recordAppendOrder,
      payload
    });
  }

  function prepareNpcPublicationDelivery(input) {
    ensureLive();
    if (!hasExactFields(input, PREPARE_FIELDS) || input.schemaVersion !== 1 || !isId(input.gameSessionId) || !isId(input.publicationId) || !isId(input.consumerId) || !isSafe(input.consumerGeneration) || !isSink(input.sinkType)) throw invariant("invalid_npc_delivery_attempt");
    validateSession(input.gameSessionId);
    validateConsumer(input);
    const graphs = listGraphs();
    const head = unresolvedHead(graphs);
    if (!head || head.publication.publicationId !== input.publicationId) throw deliveryError(head ? "npc_delivery_order_blocked" : "npc_publication_not_found");
    const record = root.currentRecordsByPublicationId[input.publicationId];
    if (!record) throw deliveryError("npc_publication_not_eligible");
    if (record.state === "acknowledged") throw deliveryError("npc_publication_already_acknowledged");
    if (record.state === "failed_terminal") throw deliveryError("npc_delivery_terminal");
    if (record.state !== "pending") throw deliveryError(record.state === "failed_retryable" ? "npc_delivery_not_prepared" : "npc_delivery_in_progress");
    const priorAttempts = Object.values(root.attemptsById).filter((attempt) => attempt.publicationId === input.publicationId);
    if (priorAttempts.length >= MAX_PER_PUBLICATION_ATTEMPTS) throw deliveryError("sink_retry_exhausted");
    if (Object.keys(root.attemptsById).length >= MAX_ATTEMPTS) throw deliveryError("npc_delivery_capacity_exhausted");
    let renderingContext;
    try { renderingContext = options.getCanonicalRenderingContext(frozen({ gameSessionId: options.gameSessionId, publicationId: input.publicationId })); } catch { throw invariant("invalid_npc_delivery_publication_graph"); }
    const resolved = renderer(frozen({ schemaVersion: 1, committedGraph: head, renderingContext }));
    ensureOrder(root.nextDeliveryAttemptOrder);
    const deliveryAttemptId = allocateId();
    const attemptNumber = priorAttempts.length + 1;
    const order = root.nextDeliveryAttemptOrder;
    if (resolved?.failureType === "npc_delivery_resolution") {
      if (!hasExactFields(resolved, ["schemaVersion", "failureType", "code", "disposition"]) || resolved.schemaVersion !== 1 || !["canonical_render_failed", "canonical_render_limit_exceeded"].includes(resolved.code) || resolved.disposition !== "terminal") throw invariant("invalid_npc_delivery_publication_graph");
      const attempt = frozen({ ...baseAttempt(head, deliveryAttemptId, order, attemptNumber, null), state: "failed_terminal", failure: resolved });
      const next = detachedRoot(root);
      next.attemptsById[deliveryAttemptId] = attempt;
      next.currentRecordsByPublicationId[input.publicationId] = currentRecordForAttempt(attempt);
      next.nextDeliveryAttemptOrder += 1;
      publish(next);
      invalidatedIds.add(deliveryAttemptId);
      observe("npc_publication_delivery_failed", attempt, resolved.code);
      throw deliveryError("npc_delivery_terminal");
    }
    if (!isPlainObject(resolved) || !isFingerprint(resolved.payloadFingerprint) || resolved.publicationId !== input.publicationId) throw invariant("invalid_npc_delivery_publication_graph");
    const attempt = frozen(baseAttempt(head, deliveryAttemptId, order, attemptNumber, resolved.payloadFingerprint));
    const request = requestFor(attempt, resolved);
    const next = detachedRoot(root);
    next.attemptsById[deliveryAttemptId] = attempt;
    next.currentRecordsByPublicationId[input.publicationId] = currentRecordForAttempt(attempt);
    next.nextDeliveryAttemptOrder += 1;
    if (beforeCapabilityPublication) beforeCapabilityPublication(request);
    publish(next);
    requests.set(deliveryAttemptId, request);
    payloads.set(deliveryAttemptId, resolved);
    invalidatedIds.add(deliveryAttemptId);
    observe("npc_publication_delivery_prepared", attempt);
    return request;
  }

  function exactRequest(request) {
    ensureLive();
    if (!validRequestShape(request)) throw invariant("invalid_npc_delivery_attempt");
    validateSession(request.gameSessionId);
    if (request.consumerId !== root.consumer.consumerId || request.consumerGeneration !== root.consumer.consumerGeneration || request.sinkType !== root.consumer.sinkType) throw deliveryError("stale_npc_consumer_generation");
    if (requests.get(request.deliveryAttemptId) !== request) throw deliveryError("npc_delivery_identity_conflict");
    return root.attemptsById[request.deliveryAttemptId];
  }

  function safelyCancel(handle) {
    if (handle === null || handle === undefined) return;
    try { options.cancelTimer(handle); } catch { /* cleanup isolation */ }
  }

  function safelyAbort(controller) {
    try { controller.abort(); } catch { /* cleanup isolation */ }
  }

  function invalidateTimer(gate, kind) {
    const key = kind === "primary" ? "primaryHandle" : "cleanupHandle";
    const handle = gate[key];
    gate[key] = null;
    safelyCancel(handle);
  }

  function scheduleGateTimer(gate, kind, delay) {
    const generation = ++timerGeneration;
    if (kind === "primary") gate.primaryGeneration = generation;
    else gate.cleanupGeneration = generation;
    const callback = () => {
      if (!gate.published) {
        if (!gate.publicationInvalidated && !gate.pendingTimerCallbacks.some((pending) => pending.kind === kind && pending.generation === generation)) {
          gate.pendingTimerCallbacks.push({ kind, generation });
        }
        return;
      }
      timerCallback(gate.attemptId, kind, generation);
    };
    let handle;
    try { handle = options.scheduleTimer(callback, delay); } catch { throw invariant("invalid_npc_delivery_attempt"); }
    if (handle === null || handle === undefined) throw invariant("invalid_npc_delivery_attempt");
    if (kind === "primary") gate.primaryHandle = handle;
    else gate.cleanupHandle = handle;
  }

  function beginNpcPublicationSink(request) {
    const attempt = exactRequest(request);
    if (!attempt || attempt.state !== "prepared") throw deliveryError("npc_delivery_not_prepared");
    ensureOrder(root.nextSinkStartedOrder);
    let abortController;
    try { abortController = options.createAbortController(); } catch { throw invariant("invalid_npc_delivery_attempt"); }
    if (!abortController || typeof abortController.abort !== "function" || !abortController.signal) {
      if (typeof abortController?.abort === "function") safelyAbort(abortController);
      throw invariant("invalid_npc_delivery_attempt");
    }
    let startedAt;
    let deadlineAt;
    let cleanupDeadlineAt;
    try {
      startedAt = readClock();
      deadlineAt = startedAt + SINK_DEADLINE_MS;
      cleanupDeadlineAt = deadlineAt + CLEANUP_GRACE_MS;
      if (!Number.isFinite(deadlineAt) || !Number.isFinite(cleanupDeadlineAt)) throw invariant("invalid_npc_delivery_attempt");
    } catch (error) {
      safelyAbort(abortController);
      throw error;
    }
    const capability = {};
    Object.defineProperty(capability, SETTLEMENT_CAPABILITY_BRAND, { enumerable: false, value: true });
    Object.freeze(capability);
    const gate = {
      attemptId: attempt.deliveryAttemptId,
      capability,
      abortController,
      startedAt,
      deadlineAt,
      cleanupDeadlineAt,
      timeoutLatched: false,
      consumed: false,
      resetWinner: false,
      aborted: false,
      primaryHandle: null,
      cleanupHandle: null,
      primaryGeneration: null,
      cleanupGeneration: null,
      published: false,
      publicationInvalidated: false,
      pendingTimerCallbacks: []
    };
    try { scheduleGateTimer(gate, "primary", SINK_DEADLINE_MS); } catch (error) {
      gate.publicationInvalidated = true;
      gate.pendingTimerCallbacks.length = 0;
      safelyAbort(abortController);
      throw error;
    }
    const updated = frozen({ ...attempt, state: "in_flight", sinkStartedOrder: root.nextSinkStartedOrder });
    const next = detachedRoot(root);
    next.attemptsById[attempt.deliveryAttemptId] = updated;
    next.currentRecordsByPublicationId[attempt.publicationId] = currentRecordForAttempt(updated);
    next.nextSinkStartedOrder += 1;
    try {
      if (beforeCapabilityPublication) beforeCapabilityPublication(capability);
      publish(next);
    } catch (error) {
      gate.publicationInvalidated = true;
      gate.pendingTimerCallbacks.length = 0;
      invalidateTimer(gate, "primary");
      safelyAbort(abortController);
      throw error;
    }
    requests.delete(attempt.deliveryAttemptId);
    activeCapabilities.set(capability, gate);
    gates.set(attempt.deliveryAttemptId, gate);
    gate.published = true;
    observe("npc_publication_sink_started", updated);
    const pendingTimerCallbacks = gate.pendingTimerCallbacks.splice(0);
    for (const pending of pendingTimerCallbacks) timerCallback(gate.attemptId, pending.kind, pending.generation);
    return Object.freeze({
      schemaVersion: 1,
      status: "in_flight",
      request,
      settlementCapability: capability,
      signal: abortController.signal,
      sinkDeadlineMs: SINK_DEADLINE_MS,
      timeoutCleanupGraceMs: CLEANUP_GRACE_MS
    });
  }

  function exactGate(capability) {
    if (invalidated || resetting || !root || root.invalidated) throw deliveryError("stale_npc_delivery_session");
    const gate = activeCapabilities.get(capability);
    if (!gate || gate.capability !== capability) throw deliveryError("npc_delivery_identity_conflict");
    if (gate.resetWinner) throw deliveryError("stale_npc_delivery_session");
    if (gate.consumed) throw deliveryError("npc_delivery_identity_conflict");
    return gate;
  }

  function latchTimeout(gate) {
    if (gate.timeoutLatched) return;
    gate.timeoutLatched = true;
    if (!gate.aborted) {
      gate.aborted = true;
      safelyAbort(gate.abortController);
    }
    invalidateTimer(gate, "primary");
  }

  function cleanupGate(gate) {
    invalidateTimer(gate, "primary");
    invalidateTimer(gate, "cleanup");
    gate.consumed = true;
    gates.delete(gate.attemptId);
  }

  function normalizedTransportFailure(code, disposition) {
    return frozen({ schemaVersion: 1, failureType: "npc_delivery_transport", code, disposition });
  }

  function retryToken(attempt, retryKind, retryTokenId) {
    return frozen({
      schemaVersion: 1,
      tokenType: "npc_delivery_retry",
      retryTokenId,
      gameSessionId: attempt.gameSessionId,
      publicationId: attempt.publicationId,
      consumerId: attempt.consumerId,
      consumerGeneration: attempt.consumerGeneration,
      deliveryAttemptId: attempt.deliveryAttemptId,
      deliveryAttemptOrder: attempt.deliveryAttemptOrder,
      attemptNumber: attempt.attemptNumber,
      sinkType: attempt.sinkType,
      payloadFingerprint: attempt.payloadFingerprint,
      retryKind
    });
  }

  function settleFailure(gate, failure, retryable) {
    const attempt = root.attemptsById[gate.attemptId];
    let token = null;
    let retryTokenId = null;
    if (retryable) {
      retryTokenId = allocateId();
      token = retryToken(attempt, "repeat_sink", retryTokenId);
    }
    const state = retryable ? "failed_retryable" : "failed_terminal";
    const updated = frozen({ ...attempt, state, failure, retryTokenId });
    const next = detachedRoot(root);
    next.attemptsById[attempt.deliveryAttemptId] = updated;
    next.currentRecordsByPublicationId[attempt.publicationId] = currentRecordForAttempt(updated);
    if (token) next.retryTokensById[token.retryTokenId] = token;
    publish(next);
    if (token) {
      exactTokens.set(token.retryTokenId, token);
      invalidatedIds.add(token.retryTokenId);
    }
    cleanupGate(gate);
    observe("npc_publication_delivery_failed", updated, failure.code);
    return frozen({ schemaVersion: 1, status: state, failure, retryToken: token });
  }

  function settleTerminalTimeout(gate) {
    if (gate.consumed || invalidated || !root) return;
    latchTimeout(gate);
    settleFailure(gate, normalizedTransportFailure("sink_timeout", "terminal_ambiguous"), false);
  }

  function timerCallback(attemptId, kind, generation) {
    if (invalidated || resetting || !root) return;
    const gate = gates.get(attemptId);
    if (!gate || gate.consumed || gate.resetWinner) return;
    const generationKey = kind === "primary" ? "primaryGeneration" : "cleanupGeneration";
    if (gate[generationKey] !== generation) return;
    let now;
    try { now = readClock(); } catch { return; }
    if (kind === "primary") {
      if (now < gate.deadlineAt) {
        gate.primaryHandle = null;
        try { scheduleGateTimer(gate, "primary", gate.deadlineAt - now); } catch { /* valid attempt remains active */ }
        return;
      }
      latchTimeout(gate);
      if (now >= gate.cleanupDeadlineAt) {
        settleTerminalTimeout(gate);
        return;
      }
      try { scheduleGateTimer(gate, "cleanup", gate.cleanupDeadlineAt - now); } catch { settleTerminalTimeout(gate); }
      return;
    }
    if (now < gate.cleanupDeadlineAt) {
      gate.cleanupHandle = null;
      try { scheduleGateTimer(gate, "cleanup", gate.cleanupDeadlineAt - now); } catch { settleTerminalTimeout(gate); }
      return;
    }
    settleTerminalTimeout(gate);
  }

  function settleElapsed(gate, now) {
    if (now < gate.deadlineAt) return false;
    latchTimeout(gate);
    if (now >= gate.cleanupDeadlineAt) {
      settleTerminalTimeout(gate);
      return true;
    }
    if (gate.cleanupHandle === null) scheduleGateTimer(gate, "cleanup", gate.cleanupDeadlineAt - now);
    return false;
  }

  function completeNpcPublicationSink(capability) {
    const gate = exactGate(capability);
    const now = readClock();
    if (settleElapsed(gate, now)) throw deliveryError("npc_delivery_terminal");
    if (gate.timeoutLatched) {
      settleTerminalTimeout(gate);
      throw deliveryError("npc_delivery_terminal");
    }
    const attempt = root.attemptsById[gate.attemptId];
    if (!attempt || attempt.state !== "in_flight") throw deliveryError("npc_delivery_terminal");
    ensureOrder(root.nextSinkSucceededOrder);
    const stagedIds = new Set();
    const receiptId = allocateId(stagedIds);
    const retryTokenId = allocateId(stagedIds);
    const receipt = frozen({
      schemaVersion: 1,
      receiptType: "npc_sink_success",
      receiptId,
      gameSessionId: attempt.gameSessionId,
      publicationId: attempt.publicationId,
      consumerId: attempt.consumerId,
      consumerGeneration: attempt.consumerGeneration,
      deliveryAttemptId: attempt.deliveryAttemptId,
      deliveryAttemptOrder: attempt.deliveryAttemptOrder,
      attemptNumber: attempt.attemptNumber,
      sinkType: attempt.sinkType,
      payloadFingerprint: attempt.payloadFingerprint,
      sinkSucceededOrder: root.nextSinkSucceededOrder
    });
    const token = retryToken(attempt, "ack_only", retryTokenId);
    const updated = frozen({ ...attempt, state: "sink_succeeded", sinkSucceededOrder: root.nextSinkSucceededOrder, receiptId, retryTokenId });
    const next = detachedRoot(root);
    next.attemptsById[attempt.deliveryAttemptId] = updated;
    next.currentRecordsByPublicationId[attempt.publicationId] = currentRecordForAttempt(updated);
    next.retryTokensById[retryTokenId] = token;
    next.nextSinkSucceededOrder += 1;
    publish(next);
    receiptsById.set(receiptId, receipt);
    receiptsByAttemptId.set(attempt.deliveryAttemptId, receipt);
    exactTokens.set(retryTokenId, token);
    invalidatedIds.add(receiptId);
    invalidatedIds.add(retryTokenId);
    cleanupGate(gate);
    observe("npc_publication_delivered", updated);
    return frozen({ schemaVersion: 1, status: "sink_succeeded", receipt, retryToken: token });
  }

  function validateFailureEvidence(evidence, gate) {
    const attempt = root.attemptsById[gate.attemptId];
    if (!hasExactFields(evidence, FAILURE_EVIDENCE_FIELDS) || evidence.schemaVersion !== 1 || evidence.evidenceType !== "npc_sink_failure_evidence" || evidence.sinkType !== attempt.sinkType || !FAILURE_CODES.has(evidence.failureCode) || !["none", "unknown"].includes(evidence.visibleEffect) || !["complete", "unproved"].includes(evidence.cleanupStatus)) throw invariant("invalid_npc_delivery_attempt");
    if (evidence.failureCode === "sink_aborted") throw invariant("invalid_npc_delivery_attempt");
    if (gate.timeoutLatched) {
      if (evidence.failureCode !== "sink_timeout") throw invariant("invalid_npc_delivery_attempt");
    } else {
      if (evidence.failureCode === "sink_timeout") throw invariant("invalid_npc_delivery_attempt");
      const allowed = attempt.sinkType === "browser" ? ACTIVE_BROWSER_FAILURES : ACTIVE_CLI_FAILURES;
      if (!allowed.has(evidence.failureCode)) throw invariant("invalid_npc_delivery_attempt");
    }
    return attempt;
  }

  function recordNpcPublicationSinkFailure(capability, evidence) {
    const gate = exactGate(capability);
    const now = readClock();
    if (settleElapsed(gate, now)) throw deliveryError("npc_delivery_terminal");
    const attempt = validateFailureEvidence(evidence, gate);
    const provedNoEffect = evidence.visibleEffect === "none" && evidence.cleanupStatus === "complete";
    if (!provedNoEffect) return settleFailure(gate, normalizedTransportFailure(evidence.failureCode, "terminal_ambiguous"), false);
    if (attempt.attemptNumber === MAX_PER_PUBLICATION_ATTEMPTS) {
      return settleFailure(gate, normalizedTransportFailure("sink_retry_exhausted", "terminal_exhausted"), false);
    }
    return settleFailure(gate, normalizedTransportFailure(evidence.failureCode, "retry_sink"), true);
  }

  function getNpcPublicationDeliveryRetryToken(input) {
    ensureLive();
    if (!hasExactFields(input, RETRY_LOOKUP_FIELDS) || input.schemaVersion !== 1 || !isId(input.gameSessionId) || !isId(input.publicationId) || !isId(input.consumerId) || !isSafe(input.consumerGeneration) || !isSink(input.sinkType) || !isId(input.deliveryAttemptId) || !isSafe(input.deliveryAttemptOrder) || !isSafe(input.attemptNumber, 1, 3) || !isFingerprint(input.payloadFingerprint) || !isId(input.retryTokenId)) throw invariant("invalid_npc_delivery_attempt");
    validateSession(input.gameSessionId);
    if (input.consumerId !== root.consumer.consumerId || input.consumerGeneration !== root.consumer.consumerGeneration || input.sinkType !== root.consumer.sinkType) throw deliveryError("stale_npc_consumer_generation");
    const token = root.retryTokensById[input.retryTokenId];
    if (!token || !sameFields(token, input, RETRY_LOOKUP_FIELDS.filter((field) => field !== "schemaVersion"))) throw deliveryError("npc_delivery_identity_conflict");
    return exactTokens.get(input.retryTokenId) ?? (() => { throw invariant("invalid_npc_delivery_controller_root"); })();
  }

  function retryNpcPublicationDelivery(token) {
    ensureLive();
    if (!hasExactFields(token, TOKEN_FIELDS) || exactTokens.get(token.retryTokenId) !== token || root.retryTokensById[token.retryTokenId] !== token) throw deliveryError("npc_delivery_identity_conflict");
    validateSession(token.gameSessionId);
    if (token.consumerId !== root.consumer.consumerId || token.consumerGeneration !== root.consumer.consumerGeneration || token.sinkType !== root.consumer.sinkType) throw deliveryError("stale_npc_consumer_generation");
    if (token.retryKind === "ack_only") {
      const receipt = receiptsByAttemptId.get(token.deliveryAttemptId);
      if (!receipt) throw invariant("invalid_npc_delivery_receipt");
      return acknowledgeNpcPublication({ sinkSuccessReceipt: receipt });
    }
    const oldAttempt = root.attemptsById[token.deliveryAttemptId];
    if (!oldAttempt || oldAttempt.state !== "failed_retryable" || oldAttempt.retryTokenId !== token.retryTokenId) throw deliveryError("npc_delivery_terminal");
    const attempts = Object.values(root.attemptsById).filter((attempt) => attempt.publicationId === token.publicationId);
    if (attempts.length >= MAX_PER_PUBLICATION_ATTEMPTS) throw deliveryError("sink_retry_exhausted");
    if (Object.keys(root.attemptsById).length >= MAX_ATTEMPTS) throw deliveryError("npc_delivery_capacity_exhausted");
    ensureOrder(root.nextDeliveryAttemptOrder);
    const deliveryAttemptId = allocateId();
    const payload = payloads.get(oldAttempt.deliveryAttemptId);
    if (!payload || payload.payloadFingerprint !== oldAttempt.payloadFingerprint) throw invariant("invalid_npc_delivery_attempt");
    const graph = { publication: { publicationId: oldAttempt.publicationId, publicationSlotOrder: oldAttempt.publicationSlotOrder, recordAppendOrder: oldAttempt.recordAppendOrder } };
    const newAttempt = frozen(baseAttempt(graph, deliveryAttemptId, root.nextDeliveryAttemptOrder, attempts.length + 1, oldAttempt.payloadFingerprint));
    const abandoned = frozen({ ...oldAttempt, state: "abandoned", abandonedFromState: "failed_retryable", retryTokenId: null });
    const request = requestFor(newAttempt, payload);
    const next = detachedRoot(root);
    next.attemptsById[oldAttempt.deliveryAttemptId] = abandoned;
    next.attemptsById[deliveryAttemptId] = newAttempt;
    next.currentRecordsByPublicationId[token.publicationId] = currentRecordForAttempt(newAttempt);
    delete next.retryTokensById[token.retryTokenId];
    next.nextDeliveryAttemptOrder += 1;
    if (beforeCapabilityPublication) beforeCapabilityPublication(request);
    publish(next);
    exactTokens.delete(token.retryTokenId);
    requests.set(deliveryAttemptId, request);
    payloads.set(deliveryAttemptId, payload);
    invalidatedIds.add(deliveryAttemptId);
    observe("npc_publication_delivery_prepared", newAttempt);
    return request;
  }

  function classifyReceiptInput(input) {
    ensureLive(true);
    if (!validReceiptShape(input)) throw invariant("invalid_npc_delivery_receipt");
    validateSession(input.gameSessionId, true);
    if (input.consumerId !== root.consumer.consumerId || input.consumerGeneration !== root.consumer.consumerGeneration || input.sinkType !== root.consumer.sinkType) throw acknowledgementError("stale_npc_acknowledgement_generation");
    const retained = receiptsById.get(input.receiptId);
    if (!retained || !sameFields(retained, input, RECEIPT_FIELDS)) throw acknowledgementError("npc_acknowledgement_identity_mismatch");
    return retained;
  }

  function getCompletedNpcPublicationSinkReceipt(input) {
    const retained = classifyReceiptInput(input);
    const attempt = root.attemptsById[retained.deliveryAttemptId];
    if (!attempt || attempt.state !== "sink_succeeded" || attempt.receiptId !== retained.receiptId) throw acknowledgementError("npc_acknowledgement_not_delivered");
    return retained;
  }

  function staleAckObservation(receipt, code) {
    if (!receipt || !isPlainObject(receipt) || !isId(receipt.publicationId) || !isId(receipt.consumerId) || !isSafe(receipt.consumerGeneration) || !isSink(receipt.sinkType) || !isId(receipt.deliveryAttemptId) || !isSafe(receipt.deliveryAttemptOrder) || !isSafe(receipt.attemptNumber, 1, 3)) return;
    observe("npc_publication_stale_ack_rejected", receipt, code);
  }

  function acknowledgeNpcPublication(input) {
    ensureLive(true);
    if (!hasExactFields(input, ["sinkSuccessReceipt"])) throw invariant("invalid_npc_delivery_acknowledgement");
    const receipt = input.sinkSuccessReceipt;
    if (!validReceiptShape(receipt)) throw invariant("invalid_npc_delivery_acknowledgement");
    if (invalidated || resetting || !root || root.invalidated || receipt?.gameSessionId !== options.gameSessionId) throw acknowledgementError("stale_npc_acknowledgement_session");
    if (receipt.consumerId !== root.consumer.consumerId || receipt.consumerGeneration !== root.consumer.consumerGeneration || receipt.sinkType !== root.consumer.sinkType) {
      staleAckObservation(receipt, "stale_npc_acknowledgement_generation");
      throw acknowledgementError("stale_npc_acknowledgement_generation");
    }
    const retained = receiptsById.get(receipt.receiptId);
    const stored = root.acknowledgementsByPublicationId[receipt.publicationId];
    if (stored) {
      if (retained === receipt && stored.receiptId === receipt.receiptId) {
        observe("npc_publication_duplicate_ack_suppressed", root.attemptsById[receipt.deliveryAttemptId]);
        return stored;
      }
      throw acknowledgementError("npc_acknowledgement_conflict");
    }
    if (retained !== receipt) throw acknowledgementError("npc_acknowledgement_identity_mismatch");
    const attempt = root.attemptsById[receipt.deliveryAttemptId];
    if (!attempt || attempt.state !== "sink_succeeded" || attempt.receiptId !== receipt.receiptId) throw acknowledgementError("npc_acknowledgement_not_delivered");
    const token = root.retryTokensById[attempt.retryTokenId];
    if (!token || exactTokens.get(token.retryTokenId) !== token || token.retryKind !== "ack_only") throw invariant("invalid_npc_delivery_acknowledgement");
    ensureOrder(root.nextAcknowledgedOrder);
    const acknowledgement = frozen({
      schemaVersion: 1,
      acknowledgementType: "npc_publication_acknowledged",
      gameSessionId: attempt.gameSessionId,
      publicationId: attempt.publicationId,
      consumerId: attempt.consumerId,
      consumerGeneration: attempt.consumerGeneration,
      deliveryAttemptId: attempt.deliveryAttemptId,
      deliveryAttemptOrder: attempt.deliveryAttemptOrder,
      attemptNumber: attempt.attemptNumber,
      sinkType: attempt.sinkType,
      receiptId: receipt.receiptId,
      payloadFingerprint: attempt.payloadFingerprint,
      acknowledgedOrder: root.nextAcknowledgedOrder
    });
    const updated = frozen({ ...attempt, state: "acknowledged", acknowledgedOrder: root.nextAcknowledgedOrder, retryTokenId: null });
    const next = detachedRoot(root);
    next.attemptsById[attempt.deliveryAttemptId] = updated;
    next.currentRecordsByPublicationId[attempt.publicationId] = currentRecordForAttempt(updated);
    next.acknowledgementsByPublicationId[attempt.publicationId] = acknowledgement;
    delete next.retryTokensById[token.retryTokenId];
    next.nextAcknowledgedOrder += 1;
    publish(next);
    exactTokens.delete(token.retryTokenId);
    observe("npc_publication_acknowledged", updated);
    return acknowledgement;
  }

  function replaceNpcPublicationDeliveryConsumer(input) {
    ensureLive();
    if (!hasExactFields(input, REPLACEMENT_FIELDS) || input.schemaVersion !== 1 || !isId(input.gameSessionId) || !isId(input.consumerId) || !isSafe(input.consumerGeneration) || !isSink(input.sinkType) || !isId(input.nextConsumerId) || !isSink(input.nextSinkType)) throw invariant("invalid_npc_delivery_attempt");
    validateSession(input.gameSessionId);
    validateConsumer(input);
    if (input.nextConsumerId === root.consumer.consumerId && input.nextSinkType === root.consumer.sinkType) return root.consumer;
    ensureOrder(root.consumer.consumerGeneration);
    for (const record of Object.values(root.currentRecordsByPublicationId)) if (["prepared", "in_flight", "sink_succeeded"].includes(record.state)) throw deliveryError("npc_delivery_in_progress");
    const nextConsumer = frozen({ consumerId: input.nextConsumerId, consumerGeneration: root.consumer.consumerGeneration + 1, sinkType: input.nextSinkType });
    const next = detachedRoot(root);
    next.consumer = nextConsumer;
    const abandoned = [];
    const consumedTokenIds = [];
    for (const [publicationId, record] of Object.entries(root.currentRecordsByPublicationId)) {
      if (record.state === "pending") next.currentRecordsByPublicationId[publicationId] = frozen({ ...record, consumerId: nextConsumer.consumerId, consumerGeneration: nextConsumer.consumerGeneration, sinkType: nextConsumer.sinkType });
      if (record.state === "failed_retryable") {
        const attempt = root.attemptsById[record.currentAttemptId];
        const changed = frozen({ ...attempt, state: "abandoned", abandonedFromState: "failed_retryable", retryTokenId: null });
        next.attemptsById[attempt.deliveryAttemptId] = changed;
        next.currentRecordsByPublicationId[publicationId] = frozen({ ...record, consumerId: nextConsumer.consumerId, consumerGeneration: nextConsumer.consumerGeneration, sinkType: nextConsumer.sinkType, state: "pending", currentAttemptId: null });
        delete next.retryTokensById[attempt.retryTokenId];
        consumedTokenIds.push(attempt.retryTokenId);
        abandoned.push(changed);
      }
    }
    publish(next);
    for (const retryTokenId of consumedTokenIds) exactTokens.delete(retryTokenId);
    abandoned.sort((left, right) => left.deliveryAttemptOrder - right.deliveryAttemptOrder).forEach((attempt) => observe("npc_publication_delivery_abandoned", attempt));
    observe("npc_delivery_consumer_replaced", null, null, nextConsumer);
    return nextConsumer;
  }

  function reset() {
    if (invalidated || resetting) return undefined;
    resetting = true;
    for (const gate of gates.values()) gate.resetWinner = true;
    const oldRoot = root;
    const next = detachedRoot(oldRoot);
    const abandoned = [];
    for (const [attemptId, attempt] of Object.entries(oldRoot.attemptsById)) {
      if (ACTIVE_ATTEMPT_STATES.has(attempt.state)) {
        const changed = frozen({ ...attempt, state: "abandoned", abandonedFromState: attempt.state, retryTokenId: null, acknowledgedOrder: null });
        next.attemptsById[attemptId] = changed;
        next.currentRecordsByPublicationId[attempt.publicationId] = currentRecordForAttempt(changed);
        if (attempt.retryTokenId) delete next.retryTokensById[attempt.retryTokenId];
        abandoned.push(changed);
      }
    }
    next.invalidated = true;
    validateRoot(next);
    try {
      publish(next);
    } catch (error) {
      for (const gate of gates.values()) gate.resetWinner = false;
      resetting = false;
      throw error;
    }
    for (const gate of gates.values()) {
      gate.consumed = true;
      if (!gate.aborted) { gate.aborted = true; safelyAbort(gate.abortController); }
      invalidateTimer(gate, "primary");
      invalidateTimer(gate, "cleanup");
    }
    gates.clear();
    abandoned.sort((left, right) => left.deliveryAttemptOrder - right.deliveryAttemptOrder).forEach((attempt) => observe("npc_publication_delivery_abandoned", attempt));
    observerAvailable = false;
    requests.clear();
    payloads.clear();
    receiptsById.clear();
    receiptsByAttemptId.clear();
    exactTokens.clear();
    root = null;
    invalidated = true;
    resetting = false;
    return undefined;
  }

  const controller = Object.freeze({
    discoverPendingNpcPublications,
    prepareNpcPublicationDelivery,
    beginNpcPublicationSink,
    completeNpcPublicationSink,
    recordNpcPublicationSinkFailure,
    getNpcPublicationDeliveryRetryToken,
    retryNpcPublicationDelivery,
    getCompletedNpcPublicationSinkReceipt,
    acknowledgeNpcPublication,
    replaceNpcPublicationDeliveryConsumer,
    reset
  });

  const inspect = () => frozen({
    invalidated,
    resetting,
    root: root ? structuredClone(root) : null,
    nextObservationRuntimeOrder,
    observerAvailable,
    activeRequestCount: requests.size,
    activeGateCount: gates.size,
    retainedIdentityCount: invalidatedIds.size,
    retainedReceiptCount: receiptsById.size,
    retainedPayloadCount: payloads.size
  });
  return testing ? Object.freeze({ controller, inspect }) : controller;
}

export function createNpcPublicationDeliveryController(options) {
  return createController(options, false);
}

export function createNpcPublicationDeliveryControllerForTesting(options) {
  return createController(options, true);
}
