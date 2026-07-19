import { ID_PATTERN } from "./conversation/domain.mjs";
import { CONTROLLER_FIELDS } from "./npcPublicationSinkShared.mjs";

export const NPC_PUBLICATION_DELIVERY_ORCHESTRATOR_RESULT_TYPES = Object.freeze([
  "pending_none", "skipped_not_eligible", "delivered", "acknowledged_existing",
  "retry_required", "failed_terminal", "reset"
]);

export const NPC_PUBLICATION_DELIVERY_ORCHESTRATOR_ERROR_CODES = Object.freeze([
  "invalid_npc_delivery_orchestrator_configuration",
  "invalid_npc_delivery_orchestrator_input",
  "npc_delivery_orchestrator_operation_in_progress",
  "npc_delivery_orchestrator_reset"
]);

const INVARIANT_CODES = Object.freeze([
  "invalid_npc_delivery_orchestrator_state",
  "invalid_npc_delivery_controller_result",
  "invalid_npc_delivery_sink_result",
  "npc_delivery_orchestrator_identity_collision"
]);
const FACTORY_FIELDS = Object.freeze([
  "gameSessionId", "controller", "initialConsumer", "resolveSinkConsumer", "createId", "observer"
]);
const ROUTE_BASE_FIELDS = Object.freeze([
  "schemaVersion", "resultType", "gameSessionId", "triggerRequestId", "originatingInputRecordId", "status"
]);
const ROUTE_COMMITTED_FIELDS = Object.freeze([...ROUTE_BASE_FIELDS, "reactionPlanId", "requestId", "attemptCount", "commitResult"]);
const ROUTE_PENDING_FIELDS = Object.freeze([...ROUTE_COMMITTED_FIELDS, "cleanupStatus"]);
const ROUTE_REPLAY_FIELDS = Object.freeze([...ROUTE_BASE_FIELDS, "reactionPlanId", "requestId", "commitResult"]);
const ROUTE_IN_PROGRESS_FIELDS = Object.freeze([...ROUTE_BASE_FIELDS, "activeReactionPlanId", "activeRequestId"]);
const ROUTE_PREFLIGHT_FIELDS = Object.freeze([...ROUTE_BASE_FIELDS, "stage", "reason"]);
const ROUTE_TERMINAL_FIELDS = Object.freeze([...ROUTE_BASE_FIELDS, "reactionPlanId", "requestId", "attemptCount", "stage", "reason"]);
const ELIGIBLE_ROUTE_STATUSES = new Set(["committed", "committed_cleanup_pending"]);
const KNOWN_ROUTE_STATUSES = new Set([
  "committed", "committed_cleanup_pending", "replayed", "rejected", "superseded",
  "cancelled", "exhausted", "in_progress"
]);

export class NpcPublicationDeliveryOrchestratorConfigurationError extends Error {
  constructor(code = "invalid_npc_delivery_orchestrator_configuration") {
    super("NPC publication delivery orchestrator configuration failed");
    defineError(this, "NpcPublicationDeliveryOrchestratorConfigurationError", code);
  }
}

export class NpcPublicationDeliveryOrchestratorInvariantError extends Error {
  constructor(code = "invalid_npc_delivery_orchestrator_state") {
    super("NPC publication delivery orchestrator invariant failed");
    defineError(this, "NpcPublicationDeliveryOrchestratorInvariantError", code);
  }
}

function defineError(error, name, code) {
  Object.defineProperty(error, "name", { configurable: true, value: name, writable: true });
  Object.defineProperty(error, "code", { value: code });
}

function configurationError(code = "invalid_npc_delivery_orchestrator_configuration") {
  return new NpcPublicationDeliveryOrchestratorConfigurationError(code);
}

function invariant(code = "invalid_npc_delivery_orchestrator_state") {
  return new NpcPublicationDeliveryOrchestratorInvariantError(
    INVARIANT_CODES.includes(code) ? code : "invalid_npc_delivery_orchestrator_state"
  );
}

function isPlain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataObject(value, fields) {
  if (!isPlain(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string")) return false;
  return fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function isId(value) { return typeof value === "string" && ID_PATTERN.test(value); }
function isSafe(value, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function isSinkType(value) { return value === "browser" || value === "cli"; }

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, "value")) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function result(status, fields = {}) {
  return deepFreeze({ schemaVersion: 1, resultType: "npc_publication_delivery_orchestration", status, ...fields });
}

function validateController(controller) {
  return exactDataObject(controller, CONTROLLER_FIELDS)
    && CONTROLLER_FIELDS.every((field) => typeof controller[field] === "function");
}

function sinkFields(sinkType) {
  return sinkType === "browser"
    ? ["deliver", "getAttachedDeliveryEvidence", "reset"]
    : ["deliver", "getCompletedOutputEvidence", "reset"];
}

function validateSink(sink, sinkType) {
  const fields = sinkFields(sinkType);
  return exactDataObject(sink, fields) && fields.every((field) => typeof sink[field] === "function");
}

function validateConsumer(value) {
  return exactDataObject(value, ["consumerId", "sinkType"])
    && isId(value.consumerId) && isSinkType(value.sinkType);
}

function validatePublicInput(value, fields) {
  if (!exactDataObject(value, fields) || value.schemaVersion !== 1 || !isId(value.gameSessionId)) {
    throw configurationError("invalid_npc_delivery_orchestrator_input");
  }
  return value;
}

function validateRouteResult(value) {
  if (!isPlain(value) || value.schemaVersion !== 1
      || value.resultType !== "npc_structured_reaction_route"
      || !isId(value.gameSessionId) || !isId(value.triggerRequestId)
      || !isId(value.originatingInputRecordId) || !KNOWN_ROUTE_STATUSES.has(value.status)) {
    throw configurationError("invalid_npc_delivery_orchestrator_input");
  }
  if (value.status === "committed") {
    if (!exactDataObject(value, ROUTE_COMMITTED_FIELDS)) throw configurationError("invalid_npc_delivery_orchestrator_input");
  } else if (value.status === "committed_cleanup_pending") {
    if (!exactDataObject(value, ROUTE_PENDING_FIELDS) || value.cleanupStatus !== "pending") throw configurationError("invalid_npc_delivery_orchestrator_input");
  } else {
    const validShape = value.status === "replayed" ? exactDataObject(value, ROUTE_REPLAY_FIELDS)
      : value.status === "in_progress" ? exactDataObject(value, ROUTE_IN_PROGRESS_FIELDS)
        : exactDataObject(value, ROUTE_PREFLIGHT_FIELDS) || exactDataObject(value, ROUTE_TERMINAL_FIELDS);
    if (!validShape) throw configurationError("invalid_npc_delivery_orchestrator_input");
  }
  return value;
}

function validateSummary(value, identity, gameSessionId) {
  const fields = [
    "schemaVersion", "summaryType", "gameSessionId", "publicationId", "reactionPlanId", "actorId",
    "publicationSlotOrder", "recordAppendOrder", "consumerId", "consumerGeneration", "sinkType",
    "state", "currentAttemptId", "retryTokenId"
  ];
  if (!exactDataObject(value, fields) || value.schemaVersion !== 1 || value.summaryType !== "npc_publication_delivery"
      || value.gameSessionId !== gameSessionId || value.consumerId !== identity.consumerId
      || value.consumerGeneration !== identity.consumerGeneration || value.sinkType !== identity.sinkType
      || !isId(value.publicationId) || !isId(value.reactionPlanId) || !isId(value.actorId)
      || !isSafe(value.publicationSlotOrder) || !isSafe(value.recordAppendOrder)
      || !new Set(["pending", "failed_retryable", "sink_succeeded"]).has(value.state)
      || !(value.currentAttemptId === null || isId(value.currentAttemptId))
      || !(value.retryTokenId === null || isId(value.retryTokenId))) {
    throw invariant("invalid_npc_delivery_controller_result");
  }
  return value;
}

function validateSettlement(value) {
  if (!isPlain(value) || value.schemaVersion !== 1) return false;
  if (value.status === "sink_succeeded") {
    return exactDataObject(value, ["schemaVersion", "status", "receipt", "retryToken"])
      && isPlain(value.receipt) && isPlain(value.retryToken) && value.retryToken.retryKind === "ack_only";
  }
  if (value.status === "failed_retryable") {
    return exactDataObject(value, ["schemaVersion", "status", "failure", "retryToken"])
      && isPlain(value.failure) && isPlain(value.retryToken) && value.retryToken.retryKind === "repeat_sink";
  }
  return value.status === "failed_terminal"
    && exactDataObject(value, ["schemaVersion", "status", "failure", "retryToken"])
    && isPlain(value.failure) && value.retryToken === null;
}

function validateAcknowledgement(value, identity, gameSessionId) {
  const fields = [
    "schemaVersion", "acknowledgementType", "gameSessionId", "publicationId", "consumerId",
    "consumerGeneration", "deliveryAttemptId", "deliveryAttemptOrder", "attemptNumber", "sinkType",
    "receiptId", "payloadFingerprint", "acknowledgedOrder"
  ];
  return exactDataObject(value, fields) && value.schemaVersion === 1
    && value.acknowledgementType === "npc_publication_acknowledged"
    && value.gameSessionId === gameSessionId && value.consumerId === identity.consumerId
    && value.consumerGeneration === identity.consumerGeneration && value.sinkType === identity.sinkType
    && isId(value.publicationId) && isId(value.deliveryAttemptId) && isSafe(value.deliveryAttemptOrder)
    && isSafe(value.attemptNumber, 1) && value.attemptNumber <= 3 && isId(value.receiptId)
    && typeof value.payloadFingerprint === "string" && /^[a-f0-9]{64}$/u.test(value.payloadFingerprint)
    && isSafe(value.acknowledgedOrder);
}

export function createNpcPublicationDeliveryOrchestrator(configuration) {
  if (!exactDataObject(configuration, FACTORY_FIELDS)
      || !isId(configuration.gameSessionId)
      || !validateController(configuration.controller)
      || !validateConsumer(configuration.initialConsumer)
      || typeof configuration.resolveSinkConsumer !== "function"
      || typeof configuration.createId !== "function"
      || !(configuration.observer === null || typeof configuration.observer === "function")) {
    throw configurationError();
  }

  const { gameSessionId, controller, resolveSinkConsumer, createId, observer } = configuration;
  let consumer = deepFreeze({ ...configuration.initialConsumer, consumerGeneration: 0 });
  let sink = resolveSink(consumer.sinkType);
  let invalidated = false;
  let generation = 0;
  let active = null;
  let observerStatus = "available";
  const retries = new Map();
  const usedSinks = new Set([sink]);
  const usedIds = new Set();

  function resolveSink(sinkType) {
    let candidate;
    try { candidate = resolveSinkConsumer(deepFreeze({ sinkType })); }
    catch { throw configurationError(); }
    if (!validateSink(candidate, sinkType)) throw configurationError();
    return candidate;
  }

  function ensureLive() {
    if (invalidated) throw configurationError("npc_delivery_orchestrator_reset");
  }

  function ensureSession(value) {
    if (value !== gameSessionId) throw configurationError("invalid_npc_delivery_orchestrator_input");
  }

  function observe(primary) {
    if (observer === null || observerStatus !== "available") return;
    const event = deepFreeze({
      schemaVersion: 1,
      eventType: "npc_publication_delivery_orchestration",
      gameSessionId,
      publicationId: primary.publicationId ?? null,
      sinkId: consumer.consumerId,
      deliveryId: primary.deliveryAttemptId ?? null,
      attemptNumber: primary.attemptNumber ?? null,
      resultType: primary.status,
      retryMode: primary.retryMode ?? null,
      terminalCode: primary.terminalCode ?? null,
      consumerGeneration: consumer.consumerGeneration
    });
    try { observer(event); } catch { observerStatus = "failed"; }
  }

  function allocateRetry(token, retryMode) {
    let retryId;
    try { retryId = createId(); } catch { throw invariant("npc_delivery_orchestrator_identity_collision"); }
    if (!isId(retryId) || usedIds.has(retryId)) throw invariant("npc_delivery_orchestrator_identity_collision");
    usedIds.add(retryId);
    retries.set(retryId, { token, retryMode, generation, consumerGeneration: consumer.consumerGeneration });
    return retryId;
  }

  function publicResult(status, fields = {}) {
    const primary = result(status, { gameSessionId, ...fields, observerStatus });
    observe(primary);
    return observerStatus === primary.observerStatus
      ? primary
      : result(status, { gameSessionId, ...fields, observerStatus });
  }

  function discover() {
    let summaries;
    try {
      summaries = controller.discoverPendingNpcPublications({
        schemaVersion: 1, gameSessionId, consumerId: consumer.consumerId,
        consumerGeneration: consumer.consumerGeneration, sinkType: consumer.sinkType,
        afterPublicationSlotOrder: null, limit: 1
      });
    } catch (error) {
      if (error?.name?.startsWith("NpcPublication")) throw error;
      throw invariant("invalid_npc_delivery_controller_result");
    }
    if (!Array.isArray(summaries) || summaries.length > 1 || Reflect.ownKeys(summaries).some((key) => {
      if (key === "length") return false;
      return typeof key !== "string" || !/^0$/.test(key);
    })) throw invariant("invalid_npc_delivery_controller_result");
    return summaries.length === 0 ? null : validateSummary(summaries[0], consumer, gameSessionId);
  }

  function retryForSummary(summary) {
    for (const [retryId, entry] of retries) {
      if (entry.token?.retryTokenId === summary.retryTokenId && entry.consumerGeneration === consumer.consumerGeneration) {
        return { retryId, entry };
      }
    }
    return null;
  }

  async function settleExecution(execution, operation) {
    let settlement;
    try { settlement = await sink.deliver(execution, controller); }
    catch (error) {
      if (!isCurrent(operation)) return publicResult("reset", {});
      if (error?.name?.startsWith("NpcPublication") || error?.name?.startsWith("NpcBrowser") || error?.name?.startsWith("NpcCli")) throw error;
      throw invariant("invalid_npc_delivery_sink_result");
    }
    if (!isCurrent(operation)) return publicResult("reset", {});
    if (!validateSettlement(settlement)) {
      throw invariant("invalid_npc_delivery_sink_result");
    }
    if (settlement.status === "failed_retryable") {
      const retryId = allocateRetry(settlement.retryToken, "repeat_sink");
      return publicResult("retry_required", {
        publicationId: execution.request.payload.publicationId, retryMode: "repeat_sink", retryId,
        deliveryAttemptId: execution.request.deliveryAttemptId, attemptNumber: execution.request.attemptNumber
      });
    }
    if (settlement.status === "failed_terminal") {
      return publicResult("failed_terminal", {
        publicationId: execution.request.payload.publicationId,
        terminalCode: typeof settlement.failure?.code === "string" ? settlement.failure.code : "delivery_failed"
      });
    }
    let receipt;
    try { receipt = controller.getCompletedNpcPublicationSinkReceipt(settlement.receipt); }
    catch { throw invariant("invalid_npc_delivery_controller_result"); }
    let acknowledgement;
    try { acknowledgement = controller.acknowledgeNpcPublication({ sinkSuccessReceipt: receipt }); }
    catch {
      const retryId = allocateRetry(settlement.retryToken, "ack_only");
      return publicResult("retry_required", {
        publicationId: receipt.publicationId, retryMode: "ack_only", retryId,
        deliveryAttemptId: receipt.deliveryAttemptId, attemptNumber: receipt.attemptNumber
      });
    }
    if (!validateAcknowledgement(acknowledgement, consumer, gameSessionId)) {
      throw invariant("invalid_npc_delivery_controller_result");
    }
    return publicResult("delivered", {
      publicationId: receipt.publicationId,
      deliveryAttemptId: receipt.deliveryAttemptId,
      attemptNumber: receipt.attemptNumber
    });
  }

  function isCurrent(operation) {
    return !invalidated && active === operation && operation.generation === generation
      && operation.consumerGeneration === consumer.consumerGeneration;
  }

  async function executeRequest(request) {
    let execution;
    try { execution = controller.beginNpcPublicationSink(request); }
    catch (error) {
      if (error?.name?.startsWith("NpcPublication")) throw error;
      throw invariant("invalid_npc_delivery_controller_result");
    }
    if (!isPlain(execution) || execution.status !== "in_flight" || execution.request !== request) {
      throw invariant("invalid_npc_delivery_controller_result");
    }
    const operation = { generation, consumerGeneration: consumer.consumerGeneration };
    active = operation;
    try { return await settleExecution(execution, operation); }
    finally { if (active === operation) active = null; }
  }

  async function pump() {
    ensureLive();
    if (active) throw configurationError("npc_delivery_orchestrator_operation_in_progress");
    const summary = discover();
    if (!summary) return publicResult("pending_none");
    if (summary.state !== "pending") {
      const found = retryForSummary(summary);
      if (!found) throw invariant("invalid_npc_delivery_orchestrator_state");
      return publicResult("retry_required", {
        publicationId: summary.publicationId, retryMode: found.entry.retryMode, retryId: found.retryId,
        deliveryAttemptId: summary.currentAttemptId
      });
    }
    let request;
    try {
      request = controller.prepareNpcPublicationDelivery({
        schemaVersion: 1, gameSessionId, publicationId: summary.publicationId,
        consumerId: consumer.consumerId, consumerGeneration: consumer.consumerGeneration,
        sinkType: consumer.sinkType
      });
    } catch (error) {
      if (error?.name?.startsWith("NpcPublication")) throw error;
      throw invariant("invalid_npc_delivery_controller_result");
    }
    return executeRequest(request);
  }

  async function handleNpcStructuredRouteResult(input) {
    validatePublicInput(input, ["schemaVersion", "gameSessionId", "routeResult"]);
    ensureSession(input.gameSessionId);
    ensureLive();
    const routeResult = validateRouteResult(input.routeResult);
    if (routeResult.gameSessionId !== gameSessionId) throw configurationError("invalid_npc_delivery_orchestrator_input");
    if (!ELIGIBLE_ROUTE_STATUSES.has(routeResult.status)) {
      return publicResult("skipped_not_eligible", { routeStatus: routeResult.status });
    }
    return pump();
  }

  async function pumpPendingNpcPublications(input) {
    validatePublicInput(input, ["schemaVersion", "gameSessionId"]);
    ensureSession(input.gameSessionId);
    return pump();
  }

  async function retryNpcPublicationDelivery(input) {
    validatePublicInput(input, ["schemaVersion", "gameSessionId", "retryId"]);
    ensureSession(input.gameSessionId);
    ensureLive();
    if (!isId(input.retryId) || active) throw configurationError(active
      ? "npc_delivery_orchestrator_operation_in_progress" : "invalid_npc_delivery_orchestrator_input");
    const retained = retries.get(input.retryId);
    if (!retained || retained.generation !== generation || retained.consumerGeneration !== consumer.consumerGeneration) {
      throw configurationError("invalid_npc_delivery_orchestrator_input");
    }
    if (retained.retryMode === "ack_only") {
      try {
        const acknowledgement = controller.retryNpcPublicationDelivery(retained.token);
        if (!validateAcknowledgement(acknowledgement, consumer, gameSessionId)) {
          throw invariant("invalid_npc_delivery_controller_result");
        }
        retries.delete(input.retryId);
        return publicResult("acknowledged_existing", { publicationId: acknowledgement.publicationId });
      } catch (error) {
        if (error?.name?.startsWith("NpcPublication")) throw error;
        throw invariant("invalid_npc_delivery_controller_result");
      }
    }
    let request;
    try { request = controller.retryNpcPublicationDelivery(retained.token); }
    catch (error) {
      if (error?.name?.startsWith("NpcPublication")) throw error;
      throw invariant("invalid_npc_delivery_controller_result");
    }
    retries.delete(input.retryId);
    return executeRequest(request);
  }

  function replaceNpcPublicationDeliveryConsumer(input) {
    validatePublicInput(input, ["schemaVersion", "gameSessionId", "nextConsumerId", "nextSinkType"]);
    ensureSession(input.gameSessionId);
    ensureLive();
    if (!isId(input.nextConsumerId) || !isSinkType(input.nextSinkType)) throw configurationError("invalid_npc_delivery_orchestrator_input");
    if (active) throw configurationError("npc_delivery_orchestrator_operation_in_progress");
    const nextSink = resolveSink(input.nextSinkType);
    let nextConsumer;
    try {
      nextConsumer = controller.replaceNpcPublicationDeliveryConsumer({
        schemaVersion: 1, gameSessionId, consumerId: consumer.consumerId,
        consumerGeneration: consumer.consumerGeneration, sinkType: consumer.sinkType,
        nextConsumerId: input.nextConsumerId, nextSinkType: input.nextSinkType
      });
    } catch (error) {
      if (error?.name?.startsWith("NpcPublication")) throw error;
      throw invariant("invalid_npc_delivery_controller_result");
    }
    if (!exactDataObject(nextConsumer, ["consumerId", "consumerGeneration", "sinkType"])
        || nextConsumer.consumerId !== input.nextConsumerId || nextConsumer.sinkType !== input.nextSinkType
        || !isSafe(nextConsumer.consumerGeneration)) {
      throw invariant("invalid_npc_delivery_controller_result");
    }
    generation += 1;
    retries.clear();
    consumer = deepFreeze({ ...nextConsumer });
    sink = nextSink;
    usedSinks.add(nextSink);
    return deepFreeze({ ...consumer });
  }

  function getPendingDeliverySummary(input) {
    validatePublicInput(input, ["schemaVersion", "gameSessionId"]);
    ensureSession(input.gameSessionId);
    ensureLive();
    const summary = discover();
    if (!summary) return publicResult("pending_none");
    return deepFreeze({
      schemaVersion: 1, resultType: "npc_publication_delivery_orchestration_summary",
      gameSessionId, publicationId: summary.publicationId, state: summary.state,
      consumerId: consumer.consumerId, consumerGeneration: consumer.consumerGeneration,
      sinkType: consumer.sinkType, retryRequired: summary.retryTokenId !== null
    });
  }

  function reset() {
    if (invalidated) return result("reset", { gameSessionId, observerStatus });
    generation += 1;
    invalidated = true;
    retries.clear();
    try { controller.reset(); } catch {}
    for (const usedSink of usedSinks) { try { usedSink.reset(); } catch {} }
    active = null;
    return result("reset", { gameSessionId, observerStatus });
  }

  return deepFreeze({
    handleNpcStructuredRouteResult,
    pumpPendingNpcPublications,
    retryNpcPublicationDelivery,
    replaceNpcPublicationDeliveryConsumer,
    reset,
    getPendingDeliverySummary
  });
}
