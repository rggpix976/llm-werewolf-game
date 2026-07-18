import { ID_PATTERN } from "./conversation/domain.mjs";
import { sha256CanonicalJson } from "./conversation/ids.mjs";
import { validateNpcStructuredReactionAuthoritySnapshot } from "./npcStructuredReactionAuthorityPort.mjs";

const REQUEST_FIELDS = Object.freeze([
  "schemaVersion", "operation", "gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId",
  "requestFingerprint", "correlationId", "causationId", "originatingInputRecordId", "turnId", "turnOrder",
  "preconditionPhase", "preconditionStateVersion", "npcId", "knownInformation", "limits"
]);

export function createNpcStructuredRoutePolicy() {
  return freeze({
    routeSnapshot: { schemaVersion: 1, route: "structured" },
    retryPolicy: {
      schemaVersion: 1,
      maxAttempts: 3,
      backoffDelaysMs: [1000, 2000],
      logicalDeadlineMs: 15000
    }
  });
}

export function buildNpcStructuredLogicalReaction({ foundation, snapshot, createdAt, policy }) {
  validateNpcStructuredReactionAuthoritySnapshot(snapshot);
  const projectionFingerprint = sha256CanonicalJson(snapshot.knownInformationProjection);
  const requestSeed = buildRequest({
    logical: { ...foundation, requestFingerprint: "0".repeat(64) },
    reactionAttemptId: "reaction-attempt-placeholder",
    knownInformation: snapshot.knownInformationProjection
  });
  const requestFingerprint = sha256CanonicalJson(requestFingerprintInput(requestSeed));
  return freeze({
    schemaVersion: 1,
    gameSessionId: foundation.gameSessionId,
    reactionPlanId: foundation.reactionPlanId,
    requestId: foundation.requestId,
    requestFingerprint,
    correlationId: foundation.correlationId,
    causationId: foundation.causationId,
    originatingInputRecordId: foundation.originatingInputRecordId,
    turnId: foundation.turnId,
    turnOrder: foundation.turnOrder,
    preconditionPhase: foundation.preconditionPhase,
    preconditionStateVersion: foundation.preconditionStateVersion,
    npcId: foundation.npcId,
    routeSnapshot: policy.routeSnapshot,
    projectionFingerprint,
    status: "planned",
    attemptIds: [],
    createdAt,
    retryPolicy: policy.retryPolicy
  });
}

export function buildNpcStructuredProviderRequest(logical, reactionAttemptId, knownInformation) {
  const value = buildRequest({ logical, reactionAttemptId, knownInformation });
  value.requestFingerprint = sha256CanonicalJson(requestFingerprintInput(value));
  if (value.requestFingerprint !== logical.requestFingerprint) throw new TypeError("request fingerprint mismatch");
  return freeze(value);
}

export function buildNpcStructuredPendingAttempt(logical, attemptFoundation, startedAt) {
  return freeze({
    schemaVersion: 1,
    pendingType: "npc_reaction",
    gameSessionId: logical.gameSessionId,
    requestId: logical.requestId,
    requestFingerprint: logical.requestFingerprint,
    correlationId: logical.correlationId,
    causationId: logical.causationId,
    reactionPlanId: logical.reactionPlanId,
    reactionAttemptId: attemptFoundation.reactionAttemptId,
    originatingInputRecordId: logical.originatingInputRecordId,
    turnId: logical.turnId,
    turnOrder: logical.turnOrder,
    preconditionStateVersion: logical.preconditionStateVersion,
    preconditionPhase: logical.preconditionPhase,
    targetNpcId: logical.npcId,
    operation: "generate_npc_reaction_candidate",
    status: "attempting",
    candidateFingerprint: null,
    startedAt
  });
}

export function buildNpcStructuredValidationPending(attempt) {
  const { candidateFingerprint: _candidateFingerprint, ...value } = attempt;
  value.status = "candidate_received";
  return freeze(value);
}

export function buildNpcStructuredLiveApplicability({ snapshot, logical, attempt, attemptStatus }) {
  validateNpcStructuredReactionAuthoritySnapshot(snapshot);
  return freeze({
    schemaVersion: 1,
    snapshotStatus: "available",
    engineLifecycleStatus: "active",
    gameSessionId: snapshot.gameSessionId,
    turnId: snapshot.turnId,
    turnOrder: snapshot.turnOrder,
    phase: snapshot.currentPhase,
    stateVersion: snapshot.stateVersion,
    reactionPlanId: logical.reactionPlanId,
    logicalReactionStatus: "active",
    reactionAttemptId: attempt.reactionAttemptId,
    reactionAttemptStatus: attemptStatus,
    requestId: logical.requestId,
    requestFingerprint: logical.requestFingerprint,
    correlationId: logical.correlationId,
    causationId: logical.causationId,
    originatingInputRecordId: logical.originatingInputRecordId,
    npcId: logical.npcId,
    reactionCommit: { commitStatus: "uncommitted" },
    triggeringPlayerCommit: {
      requestId: snapshot.triggeringCommitResult.requestId,
      requestFingerprint: snapshot.triggeringCommitResult.requestFingerprint,
      correlationId: snapshot.triggeringCommitResult.correlationId,
      inputRecordId: snapshot.triggeringCommitResult.inputRecordId,
      turnId: snapshot.originatingInputRecord.turnId,
      resultingStateVersion: snapshot.triggeringCommitResult.resultingStateVersion
    },
    triggeringInput: {
      inputRecordId: snapshot.originatingInputRecord.inputRecordId,
      requestId: snapshot.originatingInputRecord.requestId,
      correlationId: snapshot.originatingInputRecord.correlationId,
      turnId: snapshot.originatingInputRecord.turnId,
      capturedStateVersion: snapshot.originatingInputRecord.capturedStateVersion,
      actorId: snapshot.originatingInputRecord.actorId
    },
    participants: [...snapshot.currentRoster].sort((a, b) => a.participantId.localeCompare(b.participantId))
  });
}

export function buildNpcStructuredPreparationInput({
  validatedCandidate, snapshot, logical, attempt, createId
}) {
  validateNpcStructuredReactionAuthoritySnapshot(snapshot);
  const proposals = validatedCandidate.candidate.proposals;
  const occupied = new Set(snapshot.occupiedArtifactIds);
  const staged = new Set();
  const allocate = (kind) => {
    const raw = createId();
    const value = `${kind}-${raw}`;
    if (typeof raw !== "string" || !ID_PATTERN.test(raw) || !ID_PATTERN.test(value)
      || occupied.has(value) || staged.has(value)) throw new TypeError("invalid artifact allocation");
    staged.add(value);
    return value;
  };
  const descriptorIds = proposals.map(() => allocate("reaction-descriptor"));
  const claimAllocations = proposals.flatMap((proposal, proposalIndex) =>
    ["role_claim", "result_claim"].includes(proposal.proposalType)
      ? [{ proposalIndex, claimId: allocate("reaction-claim") }]
      : []);
  const eventIds = proposals.map(() => allocate("reaction-event"));
  const segmentIds = proposals.map(() => allocate("reaction-segment"));
  const publicationId = allocate("reaction-publication");
  const next = snapshot.nextOrderEvidence;
  const eventCreatedOrders = addRange(next.nextCreatedOrder, proposals.length);
  const commitResultCreatedAtOrder = safeAdd(next.nextCreatedOrder, proposals.length);
  const resultingNextCreatedOrder = safeAdd(commitResultCreatedAtOrder, 1);
  const resultingNextPublicationSlotOrder = safeAdd(next.nextPublicationSlotOrder, 1);
  const resultingNextRecordAppendOrder = safeAdd(next.nextRecordAppendOrder, 1);
  return freeze({
    schemaVersion: 1,
    validatedCandidate,
    preparationSnapshot: {
      schemaVersion: 1,
      snapshotType: "npc_reaction_preparation",
      gameSessionId: snapshot.gameSessionId,
      turnId: snapshot.turnId,
      turnOrder: snapshot.turnOrder,
      currentPhase: snapshot.currentPhase,
      currentStateVersion: snapshot.stateVersion,
      logicalReaction: {
        schemaVersion: 1,
        gameSessionId: logical.gameSessionId,
        reactionPlanId: logical.reactionPlanId,
        requestId: logical.requestId,
        requestFingerprint: logical.requestFingerprint,
        correlationId: logical.correlationId,
        causationId: logical.causationId,
        originatingInputRecordId: logical.originatingInputRecordId,
        turnId: logical.turnId,
        turnOrder: logical.turnOrder,
        preconditionPhase: logical.preconditionPhase,
        preconditionStateVersion: logical.preconditionStateVersion,
        npcId: logical.npcId,
        status: "active"
      },
      winningAttempt: {
        schemaVersion: 1,
        reactionPlanId: logical.reactionPlanId,
        reactionAttemptId: attempt.reactionAttemptId,
        status: "validated"
      },
      triggeringCommitResult: snapshot.triggeringCommitResult,
      originatingInputRecord: snapshot.originatingInputRecord,
      triggeringEvents: snapshot.triggeringEvents,
      currentRoster: [...snapshot.currentRoster].sort((a, b) => a.participantId.localeCompare(b.participantId)),
      actorApplicability: snapshot.actorApplicability,
      currentAuthorization: snapshot.currentAuthorization,
      currentTargetIds: snapshot.currentTargetIds,
      existingClaims: snapshot.existingClaims,
      existingEvents: snapshot.existingEvents,
      nextOrderEvidence: snapshot.nextOrderEvidence,
      occupiedArtifactIds: snapshot.occupiedArtifactIds
    },
    artifactAllocation: {
      schemaVersion: 1,
      allocationType: "npc_reaction_artifacts",
      descriptorIds,
      claimAllocations,
      eventIds,
      segmentIds,
      publicationId
    },
    orderReservation: {
      schemaVersion: 1,
      reservationType: "npc_reaction_orders",
      preconditionNextCreatedOrder: next.nextCreatedOrder,
      eventCreatedOrders,
      commitResultCreatedAtOrder,
      resultingNextCreatedOrder,
      preconditionNextPublicationSlotOrder: next.nextPublicationSlotOrder,
      publicationSlotOrder: next.nextPublicationSlotOrder,
      resultingNextPublicationSlotOrder,
      preconditionNextRecordAppendOrder: next.nextRecordAppendOrder,
      publicationRecordAppendOrder: next.nextRecordAppendOrder,
      resultingNextRecordAppendOrder,
      priorClaimCount: snapshot.existingClaims.length,
      priorEventCount: snapshot.existingEvents.length
    }
  });
}

export function buildNpcStructuredPreCommitReferenceContext(preparedReaction, validatedCandidate) {
  return freeze({
    schemaVersion: 1,
    contextType: "pre_commit",
    preparationBinding: clone(preparedReaction.delta.binding),
    commitDelta: clone(preparedReaction.delta),
    validatedCandidateBinding: clone(validatedCandidate.binding)
  });
}

export function sameNpcStructuredSnapshotBinding(first, second) {
  validateNpcStructuredReactionAuthoritySnapshot(first);
  validateNpcStructuredReactionAuthoritySnapshot(second);
  for (const field of ["gameSessionId", "turnId", "turnOrder", "currentPhase", "stateVersion", "targetNpcId"]) {
    if (first[field] !== second[field]) return false;
  }
  return sha256CanonicalJson(first) === sha256CanonicalJson(second);
}

function buildRequest({ logical, reactionAttemptId, knownInformation }) {
  return {
    schemaVersion: 1,
    operation: "generate_npc_reaction_candidate",
    gameSessionId: logical.gameSessionId,
    reactionPlanId: logical.reactionPlanId,
    reactionAttemptId,
    requestId: logical.requestId,
    requestFingerprint: logical.requestFingerprint,
    correlationId: logical.correlationId,
    causationId: logical.causationId,
    originatingInputRecordId: logical.originatingInputRecordId,
    turnId: logical.turnId,
    turnOrder: logical.turnOrder,
    preconditionPhase: logical.preconditionPhase,
    preconditionStateVersion: logical.preconditionStateVersion,
    npcId: logical.npcId,
    knownInformation: clone(knownInformation),
    limits: { maxProposals: 16, maxNestingDepth: 5 }
  };
}

function requestFingerprintInput(request) {
  return Object.fromEntries(REQUEST_FIELDS
    .filter((field) => !["reactionAttemptId", "requestFingerprint"].includes(field))
    .map((field) => [field, clone(request[field])]));
}

function addRange(start, count) {
  return Array.from({ length: count }, (_, index) => safeAdd(start, index));
}

function safeAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError("order exhausted");
  return result;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}

function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  return value;
}
