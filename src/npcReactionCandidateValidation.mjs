import { ID_PATTERN, SCHEMA_VERSION, SHA256_PATTERN, enums } from "./conversation/domain.mjs";
import { sha256CanonicalJson } from "./conversation/ids.mjs";
import { validateNpcKnownInformationProjection } from "./npcKnownInformationProjection.mjs";
import { LOGICAL_REACTION_STATUSES, REACTION_ATTEMPT_STATUSES } from "./npcReactionFoundation.mjs";

export const NPC_REACTION_CANDIDATE_VALIDATION_INVARIANT_CODES = Object.freeze([
  "invalid_validation_input",
  "invalid_expected_request",
  "invalid_expected_pending_attempt",
  "invalid_transport_evidence_shape",
  "invalid_observed_candidate",
  "invalid_live_applicability_snapshot",
  "validation_input_binding_mismatch"
]);

export const NPC_REACTION_CANDIDATE_REJECTION_CODES = Object.freeze([
  "body_too_large", "malformed_json", "invalid_envelope", "unsupported_schema_version",
  "binding_mismatch", "stale_request", "duplicate_response", "attempt_response_conflict",
  "idempotency_conflict", "invalid_candidate_schema", "unsupported_in_phase6",
  "duplicate_proposal", "contradictory_proposals", "unknown_reference", "target_ineligible",
  "permission_denied", "result_fact_mismatch", "fingerprint_mismatch"
]);

const REQUEST_FIELDS = Object.freeze([
  "schemaVersion", "operation", "gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId",
  "requestFingerprint", "correlationId", "causationId", "originatingInputRecordId", "turnId", "turnOrder",
  "preconditionPhase", "preconditionStateVersion", "npcId", "knownInformation", "limits"
]);
const BINDING_FIELDS = Object.freeze(REQUEST_FIELDS.filter((field) => !["schemaVersion", "operation", "knownInformation", "limits"].includes(field)));
const PENDING_FIELDS = Object.freeze([
  "schemaVersion", "pendingType", "gameSessionId", "requestId", "requestFingerprint", "correlationId",
  "causationId", "reactionPlanId", "reactionAttemptId", "originatingInputRecordId", "turnId", "turnOrder",
  "preconditionStateVersion", "preconditionPhase", "targetNpcId", "operation", "status", "startedAt"
]);
const PROVIDER_FIELDS = Object.freeze([
  "schemaVersion", "operation", "gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId",
  "requestFingerprint", "correlationId", "causationId", "originatingInputRecordId", "turnId", "turnOrder",
  "preconditionPhase", "preconditionStateVersion", "npcId", "candidate", "diagnostics"
]);
const HTTP_FIELDS = Object.freeze([
  "schemaVersion", "operation", "requestId", "correlationId", "serverCorrelationId",
  "reactionPlanId", "reactionAttemptId", "result"
]);
const AVAILABLE_FIELDS = Object.freeze([
  "schemaVersion", "snapshotStatus", "engineLifecycleStatus", "gameSessionId", "turnId", "turnOrder", "phase",
  "stateVersion", "reactionPlanId", "logicalReactionStatus", "reactionAttemptId", "reactionAttemptStatus", "requestId",
  "requestFingerprint", "correlationId", "causationId", "originatingInputRecordId", "npcId", "reactionCommit",
  "triggeringPlayerCommit", "triggeringInput", "participants"
]);
const ROLE_POLICIES = Object.freeze(["never_confess_werewolf", "claim_when_directly_asked_after_result", "avoid_unnecessary_claim"]);
const CANDIDATE_KINDS = Object.freeze(["role_claim", "result_claim", "vote_declaration", "suspicion"]);
const RESERVED_KINDS = new Set(["commentary", "answer", "acknowledgement", "decline", "clarification"]);
const INVARIANT_MESSAGE = "invalid NPC reaction candidate validation input";

export class NpcReactionCandidateValidationInvariantError extends Error {
  constructor(code) {
    if (!NPC_REACTION_CANDIDATE_VALIDATION_INVARIANT_CODES.includes(code)) code = "invalid_validation_input";
    super(INVARIANT_MESSAGE);
    this.name = "NpcReactionCandidateValidationInvariantError";
    this.code = code;
  }
}

export function validateNpcReactionCandidate(input) {
  const context = validateStageZero(input);
  const binding = createBinding(context.request);

  const metadataFailure = validateTransportMetadata(context.transportEvidence);
  if (metadataFailure) return rejected(binding, "transport", metadataFailure, "http_envelope");
  if (context.transportEvidence.bodyBytes.byteLength > 65_536) return rejected(binding, "transport", "body_too_large", "http_envelope");

  let bodyText;
  try {
    bodyText = new TextDecoder("utf-8", { fatal: true }).decode(context.transportEvidence.bodyBytes);
  } catch {
    return rejected(binding, "transport", "malformed_json", "http_envelope");
  }

  let decoded;
  try {
    decoded = JSON.parse(bodyText);
  } catch {
    return rejected(binding, "transport", "malformed_json", "http_envelope");
  }

  const envelopeShape = reconstructEnvelopeShape(decoded);
  if (!envelopeShape.ok) return rejected(binding, "transport", "invalid_envelope", envelopeShape.location);
  const envelope = envelopeShape.value;
  if (envelope.schemaVersion !== SCHEMA_VERSION || envelope.result.schemaVersion !== SCHEMA_VERSION) {
    return rejected(binding, "transport", "unsupported_schema_version", envelope.schemaVersion !== SCHEMA_VERSION ? "http_envelope" : "provider_result");
  }
  if (envelope.operation !== "generate_npc_reaction_candidate" || envelope.result.operation !== "generate_npc_reaction_candidate") {
    return rejected(binding, "transport", "invalid_envelope", envelope.operation !== "generate_npc_reaction_candidate" ? "http_envelope" : "provider_result");
  }
  for (const field of ["requestId", "correlationId", "reactionPlanId", "reactionAttemptId"]) {
    if (envelope[field] !== envelope.result[field]) return rejected(binding, "transport", "invalid_envelope", "provider_result");
  }

  if (sha256CanonicalJson(requestFingerprintInput(context.request)) !== context.request.requestFingerprint) {
    return rejected(binding, "fingerprint", "fingerprint_mismatch", "fingerprint");
  }

  for (const field of BINDING_FIELDS) {
    if (envelope.result[field] !== context.request[field]) return rejected(binding, "binding", "binding_mismatch", "binding");
  }

  if (identityConflict(context.request, context.liveApplicability)) {
    return rejected(binding, "duplicate", "idempotency_conflict", "binding");
  }

  const route = routeApplicability(context);
  if (route === "stale") return rejected(binding, "applicability", "stale_request", "live_state");

  const candidateShape = reconstructCandidate(envelope.result.candidate);
  if (!candidateShape.ok) return rejected(binding, "structure", candidateShape.code, candidateShape.location);
  const candidate = candidateShape.value;
  const candidateFingerprint = sha256CanonicalJson(candidate);

  if (route === "terminal" && context.observedCandidate.observationStatus === "none") {
    return rejected(binding, "duplicate", "duplicate_response", "provider_result");
  }
  if (context.observedCandidate.observationStatus === "observed") {
    return rejected(
      binding,
      "duplicate",
      context.observedCandidate.candidateFingerprint === candidateFingerprint ? "duplicate_response" : "attempt_response_conflict",
      "provider_result"
    );
  }

  const projection = clonePlain(context.request.knownInformation);
  try {
    validateNpcKnownInformationProjection(projection);
  } catch {
    throw invariant("invalid_expected_request");
  }
  const projectionFingerprint = sha256CanonicalJson(projection);
  const authorizationFailure = authorizeCandidate(candidate, projection, context.liveApplicability, context.request);
  if (authorizationFailure) return rejected(binding, "authorization", authorizationFailure.code, authorizationFailure.location);

  const coherenceFailure = validateCandidateCoherence(candidate);
  if (coherenceFailure) return rejected(binding, "authorization", coherenceFailure, "proposal");

  if (hardLiveMismatch(context.request, context.pendingAttempt, context.liveApplicability)) {
    return rejected(binding, "applicability", "stale_request", "live_state");
  }
  const finalAuthorizationFailure = authorizeCandidate(candidate, projection, context.liveApplicability, context.request);
  if (finalAuthorizationFailure) return rejected(binding, "authorization", finalAuthorizationFailure.code, finalAuthorizationFailure.location);

  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    status: "validated",
    value: {
      schemaVersion: SCHEMA_VERSION,
      binding,
      candidate,
      candidateFingerprint,
      validationContext: {
        projectionFingerprint,
        roleDisclosurePolicy: projection.constraints.roleDisclosurePolicy,
        permissionResult: "allowed",
        finalApplicabilityResult: "applicable"
      }
    }
  });
}

function validateStageZero(input) {
  if (!isExactObject(input, ["schemaVersion", "request", "pendingAttempt", "transportEvidence", "observedCandidate", "liveApplicability"]) || input.schemaVersion !== SCHEMA_VERSION) {
    throw invariant("invalid_validation_input");
  }
  const request = validateExpectedRequest(input.request);
  const pendingAttempt = validateExpectedPending(input.pendingAttempt);
  const transportEvidence = validateTransportEvidenceShape(input.transportEvidence);
  const observedCandidate = validateObservedCandidate(input.observedCandidate);
  const liveApplicability = validateLiveSnapshot(input.liveApplicability);
  if (!expectedBindingMatches(request, pendingAttempt) || (observedCandidate.observationStatus === "observed" && observedCandidate.reactionAttemptId !== request.reactionAttemptId)) {
    throw invariant("validation_input_binding_mismatch");
  }
  if (["validated", "accepted"].includes(pendingAttempt.status) && observedCandidate.observationStatus !== "observed") {
    throw invariant("invalid_observed_candidate");
  }
  return { request, pendingAttempt, transportEvidence, observedCandidate, liveApplicability };
}

function validateExpectedRequest(value) {
  try {
    if (!isExactObject(value, REQUEST_FIELDS) || value.schemaVersion !== SCHEMA_VERSION || value.operation !== "generate_npc_reaction_candidate") fail();
    for (const field of ["gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId", "correlationId", "causationId", "originatingInputRecordId", "turnId", "npcId"]) assertId(value[field]);
    assertFingerprint(value.requestFingerprint);
    assertSafeInteger(value.turnOrder);
    assertSafeInteger(value.preconditionStateVersion);
    if (value.preconditionPhase !== "player_question") fail();
    if (!isExactObject(value.limits, ["maxProposals", "maxNestingDepth"]) || value.limits.maxProposals !== 16 || value.limits.maxNestingDepth !== 5) fail();
    if (measureNesting(value, 8) > 8) fail();
    assertStrictDataTree(value.knownInformation);
    validateNpcKnownInformationProjection(value.knownInformation);
    validateExpectedProjectionRelations(value);
    return clonePlain(value);
  } catch {
    throw invariant("invalid_expected_request");
  }
}

function validateExpectedProjectionRelations(request) {
  const projection = request.knownInformation;
  if (projection.public.phase !== request.preconditionPhase || projection.actorPrivate.actorId !== request.npcId) fail();
  const input = projection.public.triggeringInput;
  if (input.requestId !== request.causationId || input.inputRecordId !== request.originatingInputRecordId || input.turnId !== request.turnId || input.capturedStateVersion + 1 !== request.preconditionStateVersion) fail();
  const actor = projection.public.participants.filter((entry) => entry.participantId === request.npcId);
  const player = projection.public.participants.filter((entry) => entry.participantId === "player");
  if (actor.length !== 1 || actor[0].publicStatus !== "alive" || player.length !== 1) fail();
  const expectedTargets = projection.public.participants.filter((entry) => ![request.npcId, "player"].includes(entry.participantId)).map((entry) => entry.participantId);
  const expectedLivingTargets = projection.public.participants.filter((entry) => ![request.npcId, "player"].includes(entry.participantId) && entry.publicStatus === "alive").map((entry) => entry.participantId);
  const expectedResultTargets = [...new Set(projection.actorPrivate.investigationResults.map((entry) => entry.targetId))];
  const canDisclose = projection.actorPrivate.ownRole === "seer" && expectedResultTargets.length > 0;
  const expectedResultValues = canDisclose ? [...new Set(projection.actorPrivate.investigationResults.map((entry) => entry.result))] : [];
  const expectedReferenceIds = [...new Set([
    ...projection.public.events.map((entry) => entry.eventId),
    ...projection.public.claims.map((entry) => entry.claimId),
    ...projection.public.votes.map((entry) => entry.voteEventId),
    ...projection.public.executions.map((entry) => entry.executionEventId),
    ...projection.public.attackDeaths.map((entry) => entry.attackEventId),
    input.inputRecordId
  ])];
  const participantIds = projection.public.participants.map((entry) => entry.participantId);
  if (!sameArray(participantIds, [...participantIds].sort())) fail();
  if (!ROLE_POLICIES.includes(projection.constraints.roleDisclosurePolicy)) fail();
  if (!sameArray(projection.constraints.allowedTargetIds, expectedTargets)
    || !sameArray(projection.constraints.allowedLivingTargetIds, expectedLivingTargets)
    || !sameArray(projection.constraints.allowedResultTargetIds, expectedResultTargets)
    || !sameArray(projection.constraints.allowedCandidateKinds, CANDIDATE_KINDS)
    || !sameArray(projection.constraints.allowedClaimRoles, canDisclose ? ["seer"] : [])
    || !sameArray(projection.constraints.allowedResultValues, expectedResultValues)
    || !sameArray(projection.constraints.allowedReferenceIds, expectedReferenceIds)) fail();
}

function validateExpectedPending(value) {
  try {
    if (!isExactObject(value, PENDING_FIELDS) || value.schemaVersion !== SCHEMA_VERSION || value.pendingType !== "npc_reaction" || value.operation !== "generate_npc_reaction_candidate") fail();
    for (const field of ["gameSessionId", "requestId", "correlationId", "causationId", "reactionPlanId", "reactionAttemptId", "originatingInputRecordId", "turnId", "targetNpcId"]) assertId(value[field]);
    assertFingerprint(value.requestFingerprint);
    assertSafeInteger(value.turnOrder);
    assertSafeInteger(value.preconditionStateVersion);
    if (!enums.gamePhase.includes(value.preconditionPhase) || !REACTION_ATTEMPT_STATUSES.includes(value.status) || !isRfc3339Utc(value.startedAt)) fail();
    return clonePlain(value);
  } catch {
    throw invariant("invalid_expected_pending_attempt");
  }
}

function validateTransportEvidenceShape(value) {
  try {
    if (!isExactObject(value, ["schemaVersion", "evidenceType", "httpStatus", "contentTypeHeader", "contentEncodingHeader", "bodyBytes"])) fail();
    if (value.schemaVersion !== SCHEMA_VERSION || value.evidenceType !== "npc_reaction_candidate_http_success" || value.httpStatus !== 200) fail();
    // Empty received field-values are well-shaped evidence but invalid media
    // content, so stage 1 classifies them instead of stage 0 throwing.
    assertNullableBoundedString(value.contentTypeHeader, 0, 256);
    assertNullableBoundedString(value.contentEncodingHeader, 0, 128);
    if (!(value.bodyBytes instanceof Uint8Array) || value.bodyBytes.byteLength > 65_537) fail();
    return { ...value, bodyBytes: new Uint8Array(value.bodyBytes) };
  } catch {
    throw invariant("invalid_transport_evidence_shape");
  }
}

function validateObservedCandidate(value) {
  try {
    if (value?.observationStatus === "none") {
      if (!isExactObject(value, ["schemaVersion", "observationStatus"]) || value.schemaVersion !== SCHEMA_VERSION) fail();
    } else if (value?.observationStatus === "observed") {
      if (!isExactObject(value, ["schemaVersion", "observationStatus", "reactionAttemptId", "candidateFingerprint"]) || value.schemaVersion !== SCHEMA_VERSION) fail();
      assertId(value.reactionAttemptId);
      assertFingerprint(value.candidateFingerprint);
    } else fail();
    return clonePlain(value);
  } catch {
    throw invariant("invalid_observed_candidate");
  }
}

function validateLiveSnapshot(value) {
  try {
    if (value?.snapshotStatus === "unavailable") {
      if (!isExactObject(value, ["schemaVersion", "snapshotStatus", "currentGameSessionId", "engineLifecycleStatus", "missingDimension"]) || value.schemaVersion !== SCHEMA_VERSION) fail();
      assertId(value.currentGameSessionId);
      if (!["active", "destroyed"].includes(value.engineLifecycleStatus) || !["session_replaced", "turn", "logical_reaction", "reaction_attempt", "trigger_graph", "roster"].includes(value.missingDimension)) fail();
      return clonePlain(value);
    }
    if (!isExactObject(value, AVAILABLE_FIELDS) || value.schemaVersion !== SCHEMA_VERSION || value.snapshotStatus !== "available" || value.engineLifecycleStatus !== "active") fail();
    for (const field of ["gameSessionId", "turnId", "reactionPlanId", "reactionAttemptId", "requestId", "correlationId", "causationId", "originatingInputRecordId", "npcId"]) assertId(value[field]);
    assertSafeInteger(value.turnOrder);
    assertSafeInteger(value.stateVersion);
    assertFingerprint(value.requestFingerprint);
    if (!enums.gamePhase.includes(value.phase) || !LOGICAL_REACTION_STATUSES.includes(value.logicalReactionStatus) || !REACTION_ATTEMPT_STATUSES.includes(value.reactionAttemptStatus)) fail();
    validateLiveCommit(value.reactionCommit, value);
    validateTriggerSnapshots(value);
    validateLiveParticipants(value.participants, value.npcId);
    validateLiveStatusCombination(value);
    return clonePlain(value);
  } catch {
    throw invariant("invalid_live_applicability_snapshot");
  }
}

function validateLiveCommit(commit, live) {
  if (commit?.commitStatus === "uncommitted") {
    if (!isExactObject(commit, ["commitStatus"]) || live.logicalReactionStatus === "committed") fail();
    return;
  }
  if (!isExactObject(commit, ["commitStatus", "reactionPlanId", "requestId", "requestFingerprint", "successfulAttemptId", "turnId", "preconditionPhase", "resultingPhase", "preconditionStateVersion", "resultingStateVersion"]) || commit.commitStatus !== "committed" || live.logicalReactionStatus !== "committed") fail();
  for (const field of ["reactionPlanId", "requestId", "successfulAttemptId", "turnId"]) assertId(commit[field]);
  assertFingerprint(commit.requestFingerprint);
  if (!enums.gamePhase.includes(commit.preconditionPhase) || !enums.gamePhase.includes(commit.resultingPhase)) fail();
  assertSafeInteger(commit.preconditionStateVersion);
  assertSafeInteger(commit.resultingStateVersion);
  if (commit.resultingStateVersion !== commit.preconditionStateVersion + 1 || commit.reactionPlanId !== live.reactionPlanId || commit.requestId !== live.requestId || commit.requestFingerprint !== live.requestFingerprint || commit.turnId !== live.turnId) fail();
}

function validateTriggerSnapshots(live) {
  const commit = live.triggeringPlayerCommit;
  const input = live.triggeringInput;
  if (!isExactObject(commit, ["requestId", "requestFingerprint", "correlationId", "inputRecordId", "turnId", "resultingStateVersion"])) fail();
  if (!isExactObject(input, ["inputRecordId", "requestId", "correlationId", "turnId", "capturedStateVersion", "actorId"])) fail();
  for (const value of [commit.requestId, commit.correlationId, commit.inputRecordId, commit.turnId, input.inputRecordId, input.requestId, input.correlationId, input.turnId]) assertId(value);
  assertFingerprint(commit.requestFingerprint);
  assertSafeInteger(commit.resultingStateVersion);
  assertSafeInteger(input.capturedStateVersion);
  if (commit.resultingStateVersion < 1 || input.actorId !== "player" || commit.requestId !== live.causationId || commit.inputRecordId !== live.originatingInputRecordId || commit.turnId !== live.turnId || input.inputRecordId !== commit.inputRecordId || input.requestId !== commit.requestId || input.correlationId !== commit.correlationId || input.turnId !== commit.turnId || input.capturedStateVersion + 1 !== commit.resultingStateVersion) fail();
}

function validateLiveParticipants(participants, npcId) {
  if (!isDenseArray(participants) || participants.length < 2 || participants.length > 16) fail();
  let last = null;
  for (const participant of participants) {
    if (!isExactObject(participant, ["participantId", "participantClass", "publicStatus"])) fail();
    assertId(participant.participantId);
    if (!["player", "npc"].includes(participant.participantClass) || !["alive", "dead"].includes(participant.publicStatus)) fail();
    if (last !== null && participant.participantId <= last) fail();
    last = participant.participantId;
  }
  if (participants.filter((entry) => entry.participantClass === "player").length !== 1 || participants.filter((entry) => entry.participantId === npcId && entry.participantClass === "npc").length !== 1) fail();
}

function validateLiveStatusCombination(live) {
  const logical = live.logicalReactionStatus;
  const attempt = live.reactionAttemptStatus;
  if (logical === "planned") fail();
  const compatible = {
    active: ["attempting", "candidate_received", "validated", "failed", "timed_out", "rejected", "aborted"],
    committed: ["accepted", "failed", "timed_out", "rejected", "aborted"],
    rejected: ["failed", "rejected", "aborted"],
    superseded: ["aborted"],
    cancelled: ["aborted"],
    exhausted: ["failed", "timed_out"]
  }[logical];
  if (!compatible?.includes(attempt)) fail();
  if (logical === "committed") {
    const winner = live.reactionCommit.successfulAttemptId === live.reactionAttemptId;
    if ((attempt === "accepted") !== winner) fail();
  }
}

function expectedBindingMatches(request, pending) {
  const mapping = {
    gameSessionId: "gameSessionId", requestId: "requestId", requestFingerprint: "requestFingerprint", correlationId: "correlationId",
    causationId: "causationId", reactionPlanId: "reactionPlanId", reactionAttemptId: "reactionAttemptId",
    originatingInputRecordId: "originatingInputRecordId", turnId: "turnId", turnOrder: "turnOrder",
    preconditionStateVersion: "preconditionStateVersion", preconditionPhase: "preconditionPhase", npcId: "targetNpcId", operation: "operation"
  };
  return Object.entries(mapping).every(([requestField, pendingField]) => request[requestField] === pending[pendingField]);
}

function validateTransportMetadata(evidence) {
  if (typeof evidence.contentTypeHeader !== "string" || !/^[\t ]*application\/json[\t ]*;[\t ]*charset[\t ]*=[\t ]*utf-8[\t ]*$/i.test(evidence.contentTypeHeader)) return "invalid_envelope";
  if (evidence.contentEncodingHeader !== null && (typeof evidence.contentEncodingHeader !== "string" || !/^[\t ]*identity[\t ]*$/i.test(evidence.contentEncodingHeader))) return "invalid_envelope";
  return null;
}

function reconstructEnvelopeShape(value) {
  if (!isExactObject(value, HTTP_FIELDS) || measureNesting(value, 10) > 10) return { ok: false, location: "http_envelope" };
  for (const field of ["requestId", "correlationId", "serverCorrelationId", "reactionPlanId", "reactionAttemptId"]) if (!isId(value[field])) return { ok: false, location: "http_envelope" };
  if (!isExactObject(value.result, PROVIDER_FIELDS)) return { ok: false, location: "provider_result" };
  for (const field of ["gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId", "correlationId", "causationId", "originatingInputRecordId", "turnId", "npcId"]) if (!isId(value.result[field])) return { ok: false, location: "provider_result" };
  if (!SHA256_PATTERN.test(value.result.requestFingerprint) || !isSafeInteger(value.result.turnOrder) || !isSafeInteger(value.result.preconditionStateVersion) || !enums.gamePhase.includes(value.result.preconditionPhase)) return { ok: false, location: "provider_result" };
  if (!validateProviderDiagnostics(value.result.diagnostics)) return { ok: false, location: "provider_result" };
  return { ok: true, value: clonePlain(value) };
}

function validateProviderDiagnostics(value) {
  return isExactObject(value, ["providerName", "model", "attemptCount", "elapsedMs"])
    && isBoundedString(value.providerName, 1, 64) && isBoundedString(value.model, 1, 128)
    && value.attemptCount === 1 && isSafeInteger(value.elapsedMs);
}

function requestFingerprintInput(request) {
  const result = {};
  for (const field of REQUEST_FIELDS) if (field !== "reactionAttemptId" && field !== "requestFingerprint") result[field] = clonePlain(request[field]);
  return result;
}

function identityConflict(request, live) {
  if (live.snapshotStatus !== "available") return false;
  if (live.reactionPlanId === request.reactionPlanId && live.requestId !== request.requestId) return true;
  if (live.reactionPlanId !== request.reactionPlanId && (live.requestId === request.requestId || live.causationId === request.causationId)) return true;
  return live.reactionPlanId === request.reactionPlanId && live.requestId === request.requestId && live.requestFingerprint !== request.requestFingerprint;
}

function routeApplicability(context) {
  const { request, pendingAttempt, liveApplicability: live } = context;
  if (hardLiveMismatch(request, pendingAttempt, live) || live.logicalReactionStatus === "superseded" || pendingAttempt.status !== live.reactionAttemptStatus) return "stale";
  if (pendingAttempt.status === "attempting") return "stale";
  if (pendingAttempt.status === "candidate_received" || pendingAttempt.status === "validated") return "ordinary";
  return "terminal";
}

function hardLiveMismatch(request, pending, live) {
  if (live.snapshotStatus !== "available") return true;
  for (const field of ["gameSessionId", "turnId", "turnOrder", "reactionPlanId", "reactionAttemptId", "requestId", "requestFingerprint", "correlationId", "causationId", "originatingInputRecordId", "npcId"]) {
    if (live[field] !== request[field]) return true;
  }
  if (pending.reactionAttemptId !== live.reactionAttemptId) return true;
  const expectedInput = request.knownInformation.public.triggeringInput;
  const playerCommit = live.triggeringPlayerCommit;
  const input = live.triggeringInput;
  if (playerCommit.requestId !== request.causationId || playerCommit.inputRecordId !== request.originatingInputRecordId || playerCommit.turnId !== request.turnId || playerCommit.resultingStateVersion !== request.preconditionStateVersion) return true;
  if (input.inputRecordId !== expectedInput.inputRecordId || input.requestId !== expectedInput.requestId || input.correlationId !== expectedInput.correlationId || input.turnId !== expectedInput.turnId || input.capturedStateVersion !== expectedInput.capturedStateVersion || input.actorId !== expectedInput.actorId) return true;
  if (!rosterMatches(request.knownInformation.public.participants, live.participants)) return true;
  const actor = live.participants.find((entry) => entry.participantId === request.npcId && entry.participantClass === "npc");
  if (!actor || actor.publicStatus !== "alive") return true;
  if (live.logicalReactionStatus === "committed") {
    const commit = live.reactionCommit;
    if (commit.commitStatus !== "committed" || commit.preconditionPhase !== request.preconditionPhase || commit.preconditionStateVersion !== request.preconditionStateVersion || commit.resultingPhase !== live.phase || commit.resultingStateVersion !== live.stateVersion) return true;
  } else if (live.phase !== request.preconditionPhase || live.stateVersion !== request.preconditionStateVersion) return true;
  return false;
}

function rosterMatches(expected, live) {
  if (expected.length !== live.length) return false;
  return expected.every((participant, index) => {
    const actual = live[index];
    return participant.participantId === actual.participantId
      && participant.publicStatus === actual.publicStatus
      && actual.participantClass === (participant.participantId === "player" ? "player" : "npc");
  });
}

function reconstructCandidate(value) {
  if (!isExactObject(value, ["schemaVersion", "proposals"]) || value.schemaVersion !== SCHEMA_VERSION || !isDenseArray(value.proposals) || value.proposals.length < 1 || value.proposals.length > 16 || measureNesting(value, 5) > 5) {
    return { ok: false, code: "invalid_candidate_schema", location: "candidate" };
  }
  const proposals = [];
  for (const proposal of value.proposals) {
    if (!isPlainObject(proposal) || typeof proposal.proposalType !== "string") return { ok: false, code: "invalid_candidate_schema", location: "proposal" };
    if (RESERVED_KINDS.has(proposal.proposalType)) return { ok: false, code: "unsupported_in_phase6", location: "proposal" };
    if (proposal.proposalType === "role_claim") {
      if (!isExactObject(proposal, ["proposalType", "claimedRole"]) || !enums.claimableRole.includes(proposal.claimedRole)) return { ok: false, code: "invalid_candidate_schema", location: "proposal" };
      proposals.push({ proposalType: "role_claim", claimedRole: proposal.claimedRole });
    } else if (proposal.proposalType === "result_claim") {
      if (!isExactObject(proposal, ["proposalType", "targetId", "result"]) || !isId(proposal.targetId) || !enums.claimResult.includes(proposal.result)) return { ok: false, code: "invalid_candidate_schema", location: "proposal" };
      proposals.push({ proposalType: "result_claim", targetId: proposal.targetId, result: proposal.result });
    } else if (["vote_declaration", "suspicion"].includes(proposal.proposalType)) {
      if (!isExactObject(proposal, ["proposalType", "targetId"]) || !isId(proposal.targetId)) return { ok: false, code: "invalid_candidate_schema", location: "proposal" };
      proposals.push({ proposalType: proposal.proposalType, targetId: proposal.targetId });
    } else return { ok: false, code: "invalid_candidate_schema", location: "proposal" };
  }
  return { ok: true, value: { schemaVersion: SCHEMA_VERSION, proposals } };
}

function authorizeCandidate(candidate, projection, live, request) {
  for (const proposal of candidate.proposals) if (!projection.constraints.allowedCandidateKinds.includes(proposal.proposalType)) return { code: "permission_denied", location: "policy" };
  const policy = projection.constraints.roleDisclosurePolicy;
  const directQuestion = projection.public.events.some((event) => event.projectionType === "public_question_event" && event.actorId === "player" && event.targetId === request.npcId && event.turnId === request.turnId && event.occurredPhase === "day_discussion" && ["role", "result"].includes(event.topic) && projection.constraints.allowedReferenceIds.includes(event.eventId));
  for (const proposal of candidate.proposals) {
    if (proposal.proposalType === "role_claim") {
      if (policy !== "claim_when_directly_asked_after_result" || !directQuestion || projection.actorPrivate.ownRole !== "seer" || projection.actorPrivate.investigationResults.length === 0 || projection.constraints.allowedClaimRoles.length !== 1 || projection.constraints.allowedClaimRoles[0] !== "seer" || proposal.claimedRole !== "seer") return { code: "permission_denied", location: "policy" };
    } else if (proposal.proposalType === "result_claim") {
      if (policy !== "claim_when_directly_asked_after_result" || !directQuestion || projection.actorPrivate.ownRole !== "seer" || projection.actorPrivate.investigationResults.length === 0) return { code: "permission_denied", location: "policy" };
      const targetFailure = validateCommonTarget(proposal.targetId, projection, live, request.npcId);
      if (targetFailure) return targetFailure;
      if (!projection.constraints.allowedResultTargetIds.includes(proposal.targetId)
        || !projection.constraints.allowedResultValues.includes(proposal.result)
        || !projection.actorPrivate.investigationResults.some((fact) => fact.targetId === proposal.targetId && fact.result === proposal.result)) {
        return { code: "result_fact_mismatch", location: "known_information" };
      }
    } else if (["vote_declaration", "suspicion"].includes(proposal.proposalType)) {
      const targetFailure = validateCommonTarget(proposal.targetId, projection, live, request.npcId);
      if (targetFailure) return targetFailure;
      if (!projection.constraints.allowedLivingTargetIds.includes(proposal.targetId)) return { code: "target_ineligible", location: "target" };
      const current = live.participants.find((entry) => entry.participantId === proposal.targetId);
      if (current?.publicStatus !== "alive") return { code: "target_ineligible", location: "target" };
    }
  }
  return null;
}

function validateCommonTarget(targetId, projection, live, npcId) {
  const captured = projection.public.participants.filter((entry) => entry.participantId === targetId);
  if (captured.length !== 1) return { code: "unknown_reference", location: "reference" };
  if (targetId === npcId || captured[0].participantId === "player" || !projection.constraints.allowedTargetIds.includes(targetId)) return { code: "target_ineligible", location: "target" };
  const current = live.snapshotStatus === "available" ? live.participants.filter((entry) => entry.participantId === targetId && entry.participantClass === "npc") : [];
  if (current.length !== 1) return { code: "target_ineligible", location: "target" };
  return null;
}

function validateCandidateCoherence(candidate) {
  const seenCanonical = new Set();
  const roleClaims = [];
  const votes = [];
  const results = new Map();
  const suspicions = new Set();
  for (const proposal of candidate.proposals) {
    const canonical = JSON.stringify(proposal);
    if (seenCanonical.has(canonical)) return "duplicate_proposal";
    seenCanonical.add(canonical);
    if (proposal.proposalType === "role_claim") roleClaims.push(proposal.claimedRole);
    if (proposal.proposalType === "vote_declaration") votes.push(proposal.targetId);
    if (proposal.proposalType === "result_claim") {
      if (results.has(proposal.targetId) && results.get(proposal.targetId) !== proposal.result) return "contradictory_proposals";
      results.set(proposal.targetId, proposal.result);
    }
    if (proposal.proposalType === "suspicion") suspicions.add(proposal.targetId);
  }
  if (roleClaims.length > 1 || votes.length > 1) return "contradictory_proposals";
  return null;
}

function createBinding(request) {
  return deepFreeze(Object.fromEntries(BINDING_FIELDS.map((field) => [field, request[field]])));
}

function rejected(binding, stage, reasonCode, location) {
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    status: "rejected",
    binding,
    rejection: {
      stage,
      reasonCode,
      retryable: false,
      diagnostics: [{ code: reasonCode, location }]
    }
  });
}

function invariant(code) { return new NpcReactionCandidateValidationInvariantError(code); }
function fail() { throw new TypeError("invalid"); }
function isId(value) { return typeof value === "string" && ID_PATTERN.test(value); }
function assertId(value) { if (!isId(value)) fail(); }
function assertFingerprint(value) { if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(); }
function isSafeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function assertSafeInteger(value) { if (!isSafeInteger(value)) fail(); }
function isBoundedString(value, minimum, maximum) { return typeof value === "string" && [...value].length >= minimum && [...value].length <= maximum; }
function assertNullableBoundedString(value, minimum, maximum) { if (value !== null && !isBoundedString(value, minimum, maximum)) fail(); }
function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) && Object.getOwnPropertySymbols(value).length === 0; }
function isExactObject(value, fields) { return isPlainObject(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)) && Object.keys(value).every((field) => fields.includes(field)); }
function isDenseArray(value) { if (!Array.isArray(value)) return false; for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false; return true; }
function isRfc3339Utc(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return false;
  const normalized = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const timestamp = Date.parse(normalized);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === normalized;
}
function sameArray(left, right) { return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]); }

function assertStrictDataTree(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) fail();
  if (Object.getOwnPropertySymbols(value).length > 0) fail();
  if (Array.isArray(value)) {
    if (!isDenseArray(value)) fail();
  } else if (!isPlainObject(value)) fail();
  seen.add(value);
  for (const child of Object.values(value)) assertStrictDataTree(child, seen);
  seen.delete(value);
}

function measureNesting(value, limit, depth = 1, seen = new Set()) {
  if (value === null || typeof value !== "object" || value instanceof Uint8Array) return depth;
  if (depth > limit) return depth;
  if (seen.has(value)) return limit + 1;
  seen.add(value);
  let maximum = depth;
  for (const child of Object.values(value)) maximum = Math.max(maximum, measureNesting(child, limit, depth + 1, seen));
  seen.delete(value);
  return maximum;
}

function clonePlain(value) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(clonePlain);
  return Object.fromEntries(Object.keys(value).map((key) => [key, clonePlain(value[key])]));
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  return value;
}
