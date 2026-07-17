import { sha256CanonicalJson } from "../../src/conversation/ids.mjs";
import { resolveNpcCanonicalDeliveryPayload } from "../../src/npcCanonicalRenderer.mjs";
import { createNpcPublicationDeliveryControllerForTesting } from "../../src/npcPublicationDelivery.mjs";

const REQUEST_FINGERPRINT = "a".repeat(64);
const PREPARATION_FINGERPRINT = "b".repeat(64);

export function committedGraphFixture({ number = 1, slot = number - 1, append = number - 1, locale = "en" } = {}) {
  const suffix = String(number);
  const reactionPlanId = `reaction-plan-${suffix}`;
  const requestId = `reaction-request-${suffix}`;
  const inputId = `input-record-${suffix}`;
  const turnId = `turn-${suffix}`;
  const attemptId = `reaction-attempt-${suffix}`;
  const publicationId = `npc-publication-${suffix}`;
  const descriptorId = `descriptor-${suffix}`;
  const claimId = `claim-${suffix}`;
  const eventId = `event-${suffix}`;
  const segmentId = `segment-${suffix}`;
  const correlationId = `correlation-${suffix}`;
  const causationId = `causation-${suffix}`;
  const source = { sourceType: "npc_reaction", reactionPlanId, descriptorId, originatingInputRecordId: inputId, reactionCommitRequestId: requestId };
  const descriptor = { descriptorId, descriptorType: "role_claim", claimedRole: "seer" };
  const segment = { segmentId, descriptorId, type: "canonical_claim", claimId };
  const claim = {
    schemaVersion: 1,
    claimId,
    claimRevision: 1,
    actorId: "npc-1",
    source,
    idempotencyKey: sha256CanonicalJson({ claimId }),
    createdTurnId: turnId,
    createdStateVersion: number + 1,
    repeatsClaimId: null,
    contradictsClaimIds: [],
    status: "asserted",
    type: "role_claim",
    claimedRole: "seer"
  };
  const event = {
    schemaVersion: 1,
    eventId,
    requestId,
    turnId,
    actorId: "npc-1",
    causationId,
    correlationId,
    idempotencyKey: `event-idempotency-${suffix}`,
    source,
    stateVersion: number + 1,
    occurredPhase: "player_question",
    createdOrder: number - 1,
    eventType: "role_claim_recorded",
    claimId
  };
  const reactionPlan = {
    schemaVersion: 1,
    requestId,
    correlationId,
    causationId,
    originatingInputRecordId: inputId,
    locale,
    causationEventIds: [],
    reactionPlanId,
    successfulAttemptId: attemptId,
    turnId,
    preconditionStateVersion: number,
    resultingStateVersion: number + 1,
    npcId: "npc-1",
    renderMode: "canonical_only",
    intendedSpeechActs: [descriptor],
    policies: {
      policyType: "reaction_policies",
      allowStateChanges: true,
      allowClaims: true,
      allowVoteDeclaration: false,
      allowSuspicionUpdate: false,
      allowMemoryUpdate: false
    },
    maxChars: 1000,
    canonicalSegments: [segment]
  };
  const publication = {
    schemaVersion: 1,
    recordType: "npc_canonical_published",
    publicationId,
    reactionPlanId,
    reactionCommitRequestId: requestId,
    originatingInputRecordId: inputId,
    correlationId,
    turnId,
    reactionResultingStateVersion: number + 1,
    actorId: "npc-1",
    locale,
    canonicalRendererVersion: 1,
    canonicalSegmentIds: [segmentId],
    publicationSlotOrder: slot,
    recordAppendOrder: append
  };
  const commitResult = {
    schemaVersion: 1,
    requestId,
    correlationId,
    requestFingerprint: REQUEST_FINGERPRINT,
    commitType: "npc_reaction",
    preconditionStateVersion: number,
    resultingStateVersion: number + 1,
    reactionPlanId,
    npcPublicationId: publicationId,
    createdEventIds: [eventId],
    createdClaimIds: [claimId],
    createdAtOrder: number,
    resultMode: "canonical_only"
  };
  const idempotencyRecord = {
    schemaVersion: 1,
    recordType: "npc_reaction_commit_idempotency",
    gameSessionId: "game-session-1",
    reactionPlanId,
    requestId,
    requestFingerprint: REQUEST_FINGERPRINT,
    preparationFingerprint: PREPARATION_FINGERPRINT,
    successfulAttemptId: attemptId,
    correlationId,
    causationId,
    originatingInputRecordId: inputId,
    turnId,
    turnOrder: number,
    npcId: "npc-1",
    preconditionStateVersion: number,
    resultingStateVersion: number + 1,
    npcPublicationId: publicationId,
    commitResultRequestId: requestId
  };
  return {
    schemaVersion: 1,
    contextType: "committed_graph",
    reactionPlan,
    idempotencyRecord,
    commitResult,
    publication,
    claims: [claim],
    events: [event],
    segments: [segment]
  };
}

export function createDeliveryHarness({
  graphs = [committedGraphFixture()],
  sinkType = "browser",
  initialRuntimeOrders = {},
  renderer = resolveNpcCanonicalDeliveryPayload,
  observer = null,
  beforeRootPublication = null,
  beforeCapabilityRegistryPublication = null
} = {}) {
  let now = 0;
  let idOrder = 0;
  const observations = [];
  const timers = [];
  const abortControllers = [];
  const counts = { graphReads: 0, contextReads: 0, rendererCalls: 0 };
  const authoritativeSnapshot = structuredClone(graphs);
  const contexts = new Map(graphs.map((graph) => [graph.publication.publicationId, {
    locale: graph.publication.locale,
    publicParticipantsById: {
      "npc-1": { participantId: "npc-1", displayName: "Actor" }
    }
  }]));
  const scheduleTimer = (callback, delayMs) => {
    const handle = { callback, delayMs, cancelled: false, order: timers.length };
    timers.push(handle);
    return handle;
  };
  const cancelTimer = (handle) => { handle.cancelled = true; };
  const createAbortController = () => {
    const controller = new AbortController();
    abortControllers.push(controller);
    return controller;
  };
  const orders = {
    consumerGeneration: 0,
    nextDeliveryAttemptOrder: 0,
    nextSinkStartedOrder: 0,
    nextSinkSucceededOrder: 0,
    nextAcknowledgedOrder: 0,
    nextObservationRuntimeOrder: 0,
    ...initialRuntimeOrders
  };
  const testing = createNpcPublicationDeliveryControllerForTesting({
    gameSessionId: "game-session-1",
    initialConsumer: { consumerId: "consumer-1", sinkType },
    createId: () => `npc-delivery-id-${++idOrder}`,
    listCommittedNpcPublicationGraphs: () => { counts.graphReads += 1; return graphs; },
    getCanonicalRenderingContext: ({ publicationId }) => { counts.contextReads += 1; return contexts.get(publicationId); },
    nowMonotonicMs: () => now,
    scheduleTimer,
    cancelTimer,
    createAbortController,
    observer: (value) => {
      observations.push(value);
      if (observer) observer(value);
    },
    resolveCanonicalDeliveryPayloadForTesting: (input) => { counts.rendererCalls += 1; return renderer(input); },
    initialRuntimeOrdersForTesting: orders,
    beforeRootPublicationForTesting: beforeRootPublication,
    beforeCapabilityRegistryPublicationForTesting: beforeCapabilityRegistryPublication
  });
  return {
    ...testing,
    graphs,
    contexts,
    observations,
    timers,
    abortControllers,
    counts,
    authoritativeSnapshot,
    setNow(value) { now = value; },
    get now() { return now; },
    fire(handle) { handle.callback(); },
    latestActiveTimer() { return [...timers].reverse().find((handle) => !handle.cancelled); }
  };
}

export function discoveryInput(overrides = {}) {
  return {
    schemaVersion: 1,
    gameSessionId: "game-session-1",
    consumerId: "consumer-1",
    consumerGeneration: 0,
    sinkType: "browser",
    afterPublicationSlotOrder: null,
    limit: 32,
    ...overrides
  };
}

export function prepareInput(publicationId = "npc-publication-1", overrides = {}) {
  return {
    schemaVersion: 1,
    gameSessionId: "game-session-1",
    publicationId,
    consumerId: "consumer-1",
    consumerGeneration: 0,
    sinkType: "browser",
    ...overrides
  };
}

export function browserFailure(overrides = {}) {
  return {
    schemaVersion: 1,
    evidenceType: "npc_sink_failure_evidence",
    sinkType: "browser",
    failureCode: "browser_sink_attachment_failed",
    visibleEffect: "none",
    cleanupStatus: "complete",
    ...overrides
  };
}

export function retryLookup(token) {
  return {
    schemaVersion: token.schemaVersion,
    gameSessionId: token.gameSessionId,
    publicationId: token.publicationId,
    consumerId: token.consumerId,
    consumerGeneration: token.consumerGeneration,
    sinkType: token.sinkType,
    deliveryAttemptId: token.deliveryAttemptId,
    deliveryAttemptOrder: token.deliveryAttemptOrder,
    attemptNumber: token.attemptNumber,
    payloadFingerprint: token.payloadFingerprint,
    retryTokenId: token.retryTokenId
  };
}
