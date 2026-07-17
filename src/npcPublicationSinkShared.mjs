const EXECUTION_FIELDS = ["schemaVersion", "status", "request", "settlementCapability", "signal", "sinkDeadlineMs", "timeoutCleanupGraceMs"];
const REQUEST_FIELDS = ["schemaVersion", "gameSessionId", "consumerId", "consumerGeneration", "sinkType", "deliveryAttemptId", "deliveryAttemptOrder", "attemptNumber", "publicationSlotOrder", "recordAppendOrder", "payload"];
const PAYLOAD_FIELDS = ["schemaVersion", "payloadType", "publicationId", "reactionPlanId", "reactionCommitRequestId", "turnId", "reactionResultingStateVersion", "actorId", "locale", "canonicalRendererVersion", "canonicalSegmentIds", "displayText", "payloadFingerprint"];
export const LOOKUP_FIELDS = Object.freeze(["schemaVersion", "gameSessionId", "publicationId", "consumerId", "consumerGeneration", "sinkType", "deliveryAttemptId", "deliveryAttemptOrder", "attemptNumber"]);
export const CONTROLLER_FIELDS = Object.freeze(["discoverPendingNpcPublications", "prepareNpcPublicationDelivery", "beginNpcPublicationSink", "completeNpcPublicationSink", "recordNpcPublicationSinkFailure", "getNpcPublicationDeliveryRetryToken", "retryNpcPublicationDelivery", "getCompletedNpcPublicationSinkReceipt", "acknowledgeNpcPublication", "replaceNpcPublicationDeliveryConsumer", "reset"]);

export function exactDataObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string") || fields.some((field) => !keys.includes(field))) return false;
  return fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && Object.hasOwn(descriptor, "value");
  });
}

function id(value) { return typeof value === "string" && value.length > 0 && value.length <= 128; }
function safe(value, min = 0) { return Number.isSafeInteger(value) && value >= min; }

export function validateExecution(execution, sinkType) {
  if (!exactDataObject(execution, EXECUTION_FIELDS) || execution.schemaVersion !== 1 || execution.status !== "in_flight" || !exactDataObject(execution.request, REQUEST_FIELDS) || typeof execution.settlementCapability !== "object" || execution.settlementCapability === null || typeof execution.signal !== "object" || execution.signal === null || typeof execution.signal.aborted !== "boolean" || execution.sinkDeadlineMs !== 15000 || execution.timeoutCleanupGraceMs !== 1000) return null;
  const request = execution.request;
  if (request.schemaVersion !== 1 || request.sinkType !== sinkType || ![request.gameSessionId, request.consumerId, request.deliveryAttemptId].every(id) || ![request.consumerGeneration, request.deliveryAttemptOrder, request.publicationSlotOrder, request.recordAppendOrder].every((value) => safe(value)) || !safe(request.attemptNumber, 1) || !exactDataObject(request.payload, PAYLOAD_FIELDS)) return null;
  const payload = request.payload;
  if (payload.schemaVersion !== 1 || payload.payloadType !== "npc_canonical_utterance" || ![payload.publicationId, payload.reactionPlanId, payload.reactionCommitRequestId, payload.turnId, payload.actorId, payload.locale].every(id) || !safe(payload.reactionResultingStateVersion, 1) || !safe(payload.canonicalRendererVersion, 1) || !Array.isArray(payload.canonicalSegmentIds) || payload.canonicalSegmentIds.length < 1 || payload.canonicalSegmentIds.length > 16 || payload.canonicalSegmentIds.some((value) => !id(value)) || new Set(payload.canonicalSegmentIds).size !== payload.canonicalSegmentIds.length || typeof payload.displayText !== "string" || [...payload.displayText].length < 1 || [...payload.displayText].length > 1000 || !/^[0-9a-f]{64}$/.test(payload.payloadFingerprint)) return null;
  return execution;
}

export function validateController(controller) {
  return exactDataObject(controller, CONTROLLER_FIELDS) && CONTROLLER_FIELDS.every((field) => typeof controller[field] === "function");
}

export function identityFromExecution(execution) {
  const request = execution.request;
  return Object.freeze({ schemaVersion: 1, gameSessionId: request.gameSessionId, publicationId: request.payload.publicationId, consumerId: request.consumerId, consumerGeneration: request.consumerGeneration, sinkType: request.sinkType, deliveryAttemptId: request.deliveryAttemptId, deliveryAttemptOrder: request.deliveryAttemptOrder, attemptNumber: request.attemptNumber });
}

export function identityKey(identity) {
  return [identity.gameSessionId, identity.publicationId, identity.consumerId, identity.consumerGeneration, identity.sinkType, identity.deliveryAttemptId, identity.deliveryAttemptOrder, identity.attemptNumber].join("\u0000");
}

export function validateLookup(input, sinkType) {
  return exactDataObject(input, LOOKUP_FIELDS) && input.schemaVersion === 1 && input.sinkType === sinkType && [input.gameSessionId, input.publicationId, input.consumerId, input.deliveryAttemptId].every(id) && [input.consumerGeneration, input.deliveryAttemptOrder].every((value) => safe(value)) && safe(input.attemptNumber, 1);
}

export function failureEvidence(sinkType, failureCode, visibleEffect, cleanupStatus) {
  return Object.freeze({ schemaVersion: 1, evidenceType: "npc_sink_failure_evidence", sinkType, failureCode, visibleEffect, cleanupStatus });
}

export function sanitizeNpcTerminalText(value) {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "");
}

export function frozenCopy(value) { return Object.freeze({ ...value }); }
