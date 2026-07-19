import { ID_PATTERN } from "./conversation/domain.mjs";
import {
  NPC_STRUCTURED_REACTION_ROUTE_ERROR_CODES,
  NPC_STRUCTURED_REACTION_ROUTE_INVARIANT_CODES,
  createNpcStructuredReactionRoute
} from "./npcStructuredReactionRoute.mjs";
import { createNpcPublicationDeliveryController } from "./npcPublicationDelivery.mjs";
import {
  NPC_PUBLICATION_DELIVERY_ORCHESTRATOR_ERROR_CODES,
  createNpcPublicationDeliveryOrchestrator
} from "./npcPublicationDeliveryOrchestrator.mjs";

const CONFIG_FIELDS = [
  "gameSessionId", "authorityPort", "deliveryReadPort", "candidateTransport", "sink", "consumer",
  "createId", "nowUtc", "nowMonotonicMs", "scheduleTimer", "cancelTimer", "createAbortController", "observer"
];
const EXPOSED_ERROR_CODES = new Set([
  ...NPC_STRUCTURED_REACTION_ROUTE_ERROR_CODES,
  ...NPC_STRUCTURED_REACTION_ROUTE_INVARIANT_CODES,
  ...NPC_PUBLICATION_DELIVERY_ORCHESTRATOR_ERROR_CODES
]);

export function createProductionNpcStructuredDeliveryIntegration(configuration) {
  assertExact(configuration, CONFIG_FIELDS);
  if (!ID_PATTERN.test(configuration.gameSessionId ?? "")
      || !exactMethods(configuration.authorityPort, ["readNpcStructuredReactionSnapshot", "commitPreparedNpcReactionAtomically"])
      || !exactMethods(configuration.deliveryReadPort, ["listCommittedNpcPublicationGraphs", "getCanonicalRenderingContext"])
      || !exactMethods(configuration.candidateTransport, ["generateCandidateTransport"])
      || !isExact(configuration.consumer, ["consumerId", "sinkType"])
      || !ID_PATTERN.test(configuration.consumer.consumerId ?? "")
      || !["browser", "cli"].includes(configuration.consumer.sinkType)
      || !validSink(configuration.sink, configuration.consumer.sinkType)) throw new TypeError("Invalid NPC production integration configuration.");
  for (const field of ["createId", "nowUtc", "nowMonotonicMs", "scheduleTimer", "cancelTimer", "createAbortController", "observer"]) {
    if (typeof configuration[field] !== "function") throw new TypeError("Invalid NPC production integration configuration.");
  }
  const route = createNpcStructuredReactionRoute({
    gameSessionId: configuration.gameSessionId,
    createId: configuration.createId,
    nowUtc: configuration.nowUtc,
    nowMonotonicMs: configuration.nowMonotonicMs,
    scheduleTimer: configuration.scheduleTimer,
    cancelTimer: configuration.cancelTimer,
    createAbortController: configuration.createAbortController,
    authorityPort: configuration.authorityPort,
    candidateTransport: configuration.candidateTransport,
    observer: configuration.observer
  });
  const controller = createNpcPublicationDeliveryController({
    gameSessionId: configuration.gameSessionId,
    initialConsumer: configuration.consumer,
    createId: configuration.createId,
    listCommittedNpcPublicationGraphs: configuration.deliveryReadPort.listCommittedNpcPublicationGraphs,
    getCanonicalRenderingContext: configuration.deliveryReadPort.getCanonicalRenderingContext,
    nowMonotonicMs: configuration.nowMonotonicMs,
    scheduleTimer: configuration.scheduleTimer,
    cancelTimer: configuration.cancelTimer,
    createAbortController: configuration.createAbortController,
    observer: configuration.observer
  });
  const orchestrator = createNpcPublicationDeliveryOrchestrator({
    gameSessionId: configuration.gameSessionId,
    controller,
    initialConsumer: configuration.consumer,
    resolveSinkConsumer: ({ sinkType }) => sinkType === configuration.consumer.sinkType ? configuration.sink : null,
    createId: configuration.createId,
    observer: configuration.observer
  });
  let reset = false;

  async function executeNpcReaction(trigger) {
    if (reset) return publicResult("reset", null, null, "npc_structured_route_reset");
    let routeResult;
    try { routeResult = await route.executeStructuredReaction(trigger); }
    catch (error) { return publicResult("route_failed", null, null, closedCode(error)); }
    let deliveryResult = null;
    if (["committed", "committed_cleanup_pending"].includes(routeResult.status)) {
      try {
        deliveryResult = await orchestrator.handleNpcStructuredRouteResult({
          schemaVersion: 1, gameSessionId: configuration.gameSessionId, routeResult
        });
      } catch (error) {
        return publicResult(routeResult.status, "delivery_failed", routeResult, closedCode(error));
      }
    }
    return publicResult(routeResult.status, deliveryResult?.status ?? "skipped_not_eligible", routeResult, routeResult.reason ?? null, deliveryResult);
  }

  function resetIntegration() {
    if (reset) return undefined;
    reset = true;
    try { route.reset(); } catch {}
    try { orchestrator.reset(); } catch {}
    return undefined;
  }

  return Object.freeze({ executeNpcReaction, reset: resetIntegration });
}

function publicResult(routeStatus, deliveryStatus, routeResult, errorCode, deliveryResult = null) {
  return deepFreeze({
    schemaVersion: 1,
    resultType: "npc_structured_production_integration",
    enabled: true,
    routeStatus,
    deliveryStatus,
    publicationId: deliveryResult?.publicationId ?? routeResult?.commitResult?.npcPublicationId ?? null,
    retryId: deliveryResult?.retryId ?? null,
    errorCode,
    legacyUsed: false,
    legacySuppressed: true
  });
}

function closedCode(error) { return EXPOSED_ERROR_CODES.has(error?.code) ? error.code : "integration_invariant"; }
function validSink(value, type) { return exactMethods(value, type === "browser" ? ["deliver", "getAttachedDeliveryEvidence", "reset"] : ["deliver", "getCompletedOutputEvidence", "reset"]); }
function exactMethods(value, fields) { return isExact(value, fields) && fields.every((field) => typeof value[field] === "function"); }
function isExact(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every((key) => typeof key === "string")
    && fields.every((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    });
}
function assertExact(value, fields) { if (!isExact(value, fields)) throw new TypeError("Invalid NPC production integration configuration."); }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
