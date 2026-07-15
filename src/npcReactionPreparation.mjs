import { ID_PATTERN, SCHEMA_VERSION, SHA256_PATTERN, enums } from "./conversation/domain.mjs";
import { canonicalJson, npcClaimIdempotencyKey, sha256CanonicalJson, sha256Fingerprint } from "./conversation/ids.mjs";
import {
  validateCanonicalClaim,
  validateConversationCommitResult,
  validateDisplayPublicationRecord,
  validateNpcReactionPlan,
  validatePlayerInputRecord,
  validatePublicEvent
} from "./conversation/validators.mjs";
import { validateReactionPlanReferences } from "./conversation/references.mjs";
import { LOGICAL_REACTION_STATUSES, REACTION_ATTEMPT_STATUSES } from "./npcReactionFoundation.mjs";

export const NPC_REACTION_PREPARATION_REJECTION_CODES = Object.freeze([
  "stale_validated_binding", "stale_session", "stale_turn", "stale_phase", "stale_state_version",
  "logical_reaction_mismatch", "attempt_mismatch", "actor_ineligible", "target_ineligible",
  "invalid_reference", "permission_denied", "result_fact_mismatch", "state_version_exhausted",
  "order_exhausted", "artifact_id_collision", "causation_event_overflow"
]);

export const NPC_REACTION_PREPARATION_STAGES = Object.freeze([
  "binding", "applicability", "authorization", "allocation", "ordering", "construction"
]);

export const NPC_REACTION_PREPARATION_INVARIANT_CODES = Object.freeze([
  "invalid_preparation_input", "unsupported_preparation_schema", "invalid_validated_candidate",
  "invalid_snapshot", "contradictory_snapshot", "invalid_artifact_allocation",
  "invalid_order_reservation", "duplicate_engine_id", "invalid_committed_graph_projection",
  "preparation_fingerprint_failure"
]);

const ZERO_FINGERPRINT = "0".repeat(64);
const BINDING_FIELDS = Object.freeze([
  "gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId", "requestFingerprint",
  "correlationId", "causationId", "originatingInputRecordId", "turnId", "turnOrder",
  "preconditionPhase", "preconditionStateVersion", "npcId"
]);
const LOGICAL_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "reactionPlanId", "requestId", "requestFingerprint", "correlationId",
  "causationId", "originatingInputRecordId", "turnId", "turnOrder", "preconditionPhase",
  "preconditionStateVersion", "npcId", "status"
]);
const SNAPSHOT_FIELDS = Object.freeze([
  "schemaVersion", "snapshotType", "gameSessionId", "turnId", "turnOrder", "currentPhase",
  "currentStateVersion", "logicalReaction", "winningAttempt", "triggeringCommitResult",
  "originatingInputRecord", "triggeringEvents", "currentRoster", "actorApplicability",
  "currentAuthorization", "currentTargetIds", "existingClaims", "existingEvents",
  "nextOrderEvidence", "occupiedArtifactIds"
]);
const ROLE_POLICIES = Object.freeze([
  "never_confess_werewolf", "claim_when_directly_asked_after_result", "avoid_unnecessary_claim"
]);
const PROPOSAL_FIELDS = Object.freeze({
  role_claim: ["proposalType", "claimedRole"],
  result_claim: ["proposalType", "targetId", "result"],
  vote_declaration: ["proposalType", "targetId"],
  suspicion: ["proposalType", "targetId"]
});
const INVARIANT_MESSAGE = "Invalid NPC reaction preparation input.";

export class NpcReactionPreparationInvariantError extends Error {
  constructor(code) {
    const closedCode = NPC_REACTION_PREPARATION_INVARIANT_CODES.includes(code) ? code : "invalid_preparation_input";
    super(INVARIANT_MESSAGE);
    this.name = "NpcReactionPreparationInvariantError";
    this.code = closedCode;
  }
}

export function prepareNpcReaction(input) {
  const context = reconstructInput(input);
  const { validatedCandidate, preparationSnapshot: snapshot, artifactAllocation: allocation, orderReservation: order } = context;
  const candidateBinding = validatedCandidate.binding;
  const logical = snapshot.logicalReaction;
  const rejectionBinding = buildRejectionBinding(snapshot);

  if (sha256CanonicalJson(validatedCandidate.candidate) !== validatedCandidate.candidateFingerprint) {
    throw invariant("invalid_validated_candidate");
  }
  if (candidateBinding.gameSessionId !== snapshot.gameSessionId) return rejected(rejectionBinding, "applicability", "stale_session", "session");
  if (candidateBinding.turnId !== snapshot.turnId || candidateBinding.turnOrder !== snapshot.turnOrder) return rejected(rejectionBinding, "applicability", "stale_turn", "turn");
  if (candidateBinding.preconditionPhase !== snapshot.currentPhase) return rejected(rejectionBinding, "applicability", "stale_phase", "phase");
  if (candidateBinding.preconditionStateVersion !== snapshot.currentStateVersion) return rejected(rejectionBinding, "applicability", "stale_state_version", "state_version");
  if (snapshot.currentStateVersion === Number.MAX_SAFE_INTEGER) return rejected(rejectionBinding, "ordering", "state_version_exhausted", "state_version");

  const immutableFields = ["reactionPlanId", "requestId", "requestFingerprint", "correlationId", "causationId", "originatingInputRecordId", "npcId"];
  if (immutableFields.some((field) => candidateBinding[field] !== logical[field])) return rejected(rejectionBinding, "binding", "stale_validated_binding", "validated_candidate");
  if (logical.status !== "active") return rejected(rejectionBinding, "applicability", "logical_reaction_mismatch", "logical_reaction");
  if (snapshot.winningAttempt.reactionPlanId !== logical.reactionPlanId || snapshot.winningAttempt.reactionAttemptId !== candidateBinding.reactionAttemptId || snapshot.winningAttempt.status !== "validated") {
    return rejected(rejectionBinding, "applicability", "attempt_mismatch", "attempt");
  }
  if (snapshot.actorApplicability.presence === "absent" || !snapshot.actorApplicability.alive || !snapshot.actorApplicability.maySpeak) {
    return rejected(rejectionBinding, "authorization", "actor_ineligible", "actor");
  }

  const proposals = validatedCandidate.candidate.proposals;
  const authorization = snapshot.currentAuthorization;
  const hasRole = proposals.some((proposal) => proposal.proposalType === "role_claim");
  const hasResult = proposals.some((proposal) => proposal.proposalType === "result_claim");
  const hasDirectQuestion = deriveCausationEventIds(snapshot).length > 0;
  if (authorization.availability !== "available"
    || authorization.roleDisclosurePolicy !== validatedCandidate.validationContext.roleDisclosurePolicy
    || ((hasRole || hasResult) && !hasDirectQuestion)
    || ((hasRole || hasResult) && authorization.roleDisclosurePolicy !== "claim_when_directly_asked_after_result")
    || (hasRole && proposals.some((proposal) => proposal.proposalType === "role_claim" && !authorization.allowedClaimRoles.includes(proposal.claimedRole)))
    || (hasResult && authorization.authorizedResultFacts.length === 0)) {
    return rejected(rejectionBinding, "authorization", "permission_denied", "policy");
  }

  if (!triggerReferencesResolve(snapshot)) return rejected(rejectionBinding, "authorization", "invalid_reference", "reference");
  for (const proposal of proposals) {
    if (!Object.hasOwn(proposal, "targetId")) continue;
    const target = snapshot.currentRoster.find((entry) => entry.participantId === proposal.targetId);
    if (!snapshot.currentTargetIds.includes(proposal.targetId) || !target || target.participantClass !== "npc" || proposal.targetId === logical.npcId || (["vote_declaration", "suspicion"].includes(proposal.proposalType) && target.publicStatus !== "alive")) {
      return rejected(rejectionBinding, "authorization", "target_ineligible", "target");
    }
  }
  for (const proposal of proposals) {
    if (proposal.proposalType === "result_claim" && !authorization.authorizedResultFacts.some((fact) => fact.targetId === proposal.targetId && fact.result === proposal.result)) {
      return rejected(rejectionBinding, "authorization", "result_fact_mismatch", "known_information");
    }
  }

  const allocatedIds = allocationIds(allocation);
  if (allocatedIds.some((id) => snapshot.occupiedArtifactIds.includes(id))) return rejected(rejectionBinding, "allocation", "artifact_id_collision", "artifact_allocation");
  if (reservationWouldOverflow(order, proposals.length)) return rejected(rejectionBinding, "ordering", "order_exhausted", "order_reservation");
  assertReservationArithmetic(order, snapshot.nextOrderEvidence, proposals.length, snapshot.existingClaims.length, snapshot.existingEvents.length);

  const causationEventIds = deriveCausationEventIds(snapshot);
  if (causationEventIds.length > 16) return rejected(rejectionBinding, "construction", "causation_event_overflow", "causation_events");

  let prepared;
  try {
    prepared = buildPrepared(context, causationEventIds);
    validatePreparedArtifacts(prepared, validatedCandidate.binding);
  } catch (error) {
    if (error instanceof NpcReactionPreparationInvariantError) throw error;
    throw invariant("invalid_preparation_input");
  }
  return deepFreeze({ schemaVersion: SCHEMA_VERSION, status: "prepared", value: prepared });
}

function reconstructInput(input) {
  if (!isPlainObject(input) || !sameKeys(input, ["schemaVersion", "validatedCandidate", "preparationSnapshot", "artifactAllocation", "orderReservation"])) throw invariant("invalid_preparation_input");
  if (input.schemaVersion !== SCHEMA_VERSION) throw invariant("unsupported_preparation_schema");
  return {
    schemaVersion: SCHEMA_VERSION,
    validatedCandidate: reconstructValidatedCandidate(input.validatedCandidate),
    preparationSnapshot: reconstructSnapshot(input.preparationSnapshot),
    artifactAllocation: reconstructAllocation(input.artifactAllocation, input.validatedCandidate?.candidate?.proposals),
    orderReservation: reconstructOrder(input.orderReservation)
  };
}

function reconstructValidatedCandidate(value) {
  try {
    exact(value, ["schemaVersion", "binding", "candidate", "candidateFingerprint", "validationContext"]);
    if (value.schemaVersion !== SCHEMA_VERSION) fail();
    exact(value.binding, BINDING_FIELDS);
    for (const field of BINDING_FIELDS.filter((field) => !["turnOrder", "preconditionPhase", "preconditionStateVersion", "requestFingerprint"].includes(field))) assertId(value.binding[field]);
    assertFingerprint(value.binding.requestFingerprint); assertSafe(value.binding.turnOrder); assertSafe(value.binding.preconditionStateVersion);
    if (value.binding.preconditionPhase !== "player_question") fail();
    exact(value.candidate, ["schemaVersion", "proposals"]); if (value.candidate.schemaVersion !== SCHEMA_VERSION) fail();
    if (!denseArray(value.candidate.proposals, 1, 16)) fail();
    let claimCount = 0;
    const proposals = value.candidate.proposals.map((proposal) => {
      const fields = PROPOSAL_FIELDS[proposal?.proposalType]; if (!fields) fail(); exact(proposal, fields);
      if (["role_claim", "result_claim"].includes(proposal.proposalType)) claimCount += 1;
      if (Object.hasOwn(proposal, "targetId")) assertId(proposal.targetId);
      if (Object.hasOwn(proposal, "claimedRole") && !enums.claimableRole.includes(proposal.claimedRole)) fail();
      if (Object.hasOwn(proposal, "result") && !enums.claimResult.includes(proposal.result)) fail();
      return clonePlain(proposal);
    });
    if (claimCount > 4) fail();
    assertFingerprint(value.candidateFingerprint);
    exact(value.validationContext, ["projectionFingerprint", "roleDisclosurePolicy", "permissionResult", "finalApplicabilityResult"]);
    assertFingerprint(value.validationContext.projectionFingerprint);
    if (!ROLE_POLICIES.includes(value.validationContext.roleDisclosurePolicy) || value.validationContext.permissionResult !== "allowed" || value.validationContext.finalApplicabilityResult !== "applicable") fail();
    return { schemaVersion: SCHEMA_VERSION, binding: clonePlain(value.binding), candidate: { schemaVersion: SCHEMA_VERSION, proposals }, candidateFingerprint: value.candidateFingerprint, validationContext: clonePlain(value.validationContext) };
  } catch { throw invariant("invalid_validated_candidate"); }
}

function reconstructSnapshot(value) {
  try {
    exact(value, SNAPSHOT_FIELDS); if (value.schemaVersion !== SCHEMA_VERSION || value.snapshotType !== "npc_reaction_preparation") fail();
    for (const field of ["gameSessionId", "turnId"]) assertId(value[field]); assertSafe(value.turnOrder); assertSafe(value.currentStateVersion); if (!enums.gamePhase.includes(value.currentPhase)) fail();
    exact(value.logicalReaction, LOGICAL_FIELDS); if (value.logicalReaction.schemaVersion !== SCHEMA_VERSION) fail();
    for (const field of LOGICAL_FIELDS.filter((field) => !["schemaVersion", "turnOrder", "preconditionPhase", "preconditionStateVersion", "requestFingerprint", "status"].includes(field))) assertId(value.logicalReaction[field]);
    assertFingerprint(value.logicalReaction.requestFingerprint); assertSafe(value.logicalReaction.turnOrder); assertSafe(value.logicalReaction.preconditionStateVersion);
    if (!enums.gamePhase.includes(value.logicalReaction.preconditionPhase) || !LOGICAL_REACTION_STATUSES.includes(value.logicalReaction.status)) fail();
    exact(value.winningAttempt, ["schemaVersion", "reactionPlanId", "reactionAttemptId", "status"]); if (value.winningAttempt.schemaVersion !== SCHEMA_VERSION) fail();
    assertId(value.winningAttempt.reactionPlanId); assertId(value.winningAttempt.reactionAttemptId); if (!REACTION_ATTEMPT_STATUSES.includes(value.winningAttempt.status)) fail();
    validateConversationCommitResult(value.triggeringCommitResult); if (value.triggeringCommitResult.commitType !== "player_conversation") fail();
    validatePlayerInputRecord(value.originatingInputRecord);
    if (!denseArray(value.triggeringEvents, 0, 64)) fail(); value.triggeringEvents.forEach(validatePublicEvent);
    if (!denseArray(value.currentRoster, 2, 16)) fail();
    const rosterIds = new Set(); value.currentRoster.forEach((entry) => { exact(entry, ["participantId", "participantClass", "publicStatus"]); assertId(entry.participantId); if (!["player", "npc"].includes(entry.participantClass) || !["alive", "dead"].includes(entry.publicStatus) || rosterIds.has(entry.participantId)) fail(); rosterIds.add(entry.participantId); });
    if (value.currentRoster.filter((entry) => entry.participantClass === "player").length !== 1 || canonicalJson(value.currentRoster.map((entry) => entry.participantId)) !== canonicalJson([...value.currentRoster.map((entry) => entry.participantId)].sort())) fail();
    reconstructActor(value.actorApplicability); reconstructAuthorization(value.currentAuthorization);
    if (!denseUniqueIds(value.currentTargetIds, 0, 16)) fail();
    if (!denseArray(value.existingClaims, 0, 4096) || !denseArray(value.existingEvents, 0, 4096)) fail();
    value.existingClaims.forEach(validateCanonicalClaim); value.existingEvents.forEach(validatePublicEvent);
    if (new Set(value.existingClaims.map((claim) => claim.claimId)).size !== value.existingClaims.length || new Set(value.existingEvents.map((event) => event.eventId)).size !== value.existingEvents.length) throw invariant("invalid_committed_graph_projection");
    exact(value.nextOrderEvidence, ["nextCreatedOrder", "nextPublicationSlotOrder", "nextRecordAppendOrder"]); Object.values(value.nextOrderEvidence).forEach(assertSafe);
    if (!denseUniqueIds(value.occupiedArtifactIds, 0, 65536) || canonicalJson(value.occupiedArtifactIds) !== canonicalJson([...value.occupiedArtifactIds].sort())) fail();
    validateSnapshotConsistency(value);
    return clonePlain(value);
  } catch (error) {
    if (error instanceof NpcReactionPreparationInvariantError) throw error;
    throw invariant("invalid_snapshot");
  }
}

function reconstructActor(value) {
  if (value?.presence === "present") { exact(value, ["schemaVersion", "presence", "actorId", "alive", "maySpeak"]); if (value.schemaVersion !== 1 || typeof value.alive !== "boolean" || typeof value.maySpeak !== "boolean") fail(); assertId(value.actorId); }
  else if (value?.presence === "absent") { exact(value, ["schemaVersion", "presence", "actorId", "absenceReason"]); if (value.schemaVersion !== 1 || value.absenceReason !== "removed_from_roster") fail(); assertId(value.actorId); }
  else fail();
}

function reconstructAuthorization(value) {
  if (value?.availability === "available") {
    exact(value, ["schemaVersion", "availability", "actorId", "roleDisclosurePolicy", "allowedClaimRoles", "authorizedResultFacts"]); if (value.schemaVersion !== 1) fail(); assertId(value.actorId);
    if (!ROLE_POLICIES.includes(value.roleDisclosurePolicy) || !denseArray(value.allowedClaimRoles, 0, 1) || new Set(value.allowedClaimRoles).size !== value.allowedClaimRoles.length || value.allowedClaimRoles.some((role) => !enums.claimableRole.includes(role))) fail();
    if (!denseArray(value.authorizedResultFacts, 0, 16)) fail(); const pairs = new Set(); value.authorizedResultFacts.forEach((fact) => { exact(fact, ["targetId", "result"]); assertId(fact.targetId); if (!enums.claimResult.includes(fact.result)) fail(); const key = `${fact.targetId}\0${fact.result}`; if (pairs.has(key)) fail(); pairs.add(key); });
  } else if (value?.availability === "unavailable") { exact(value, ["schemaVersion", "availability", "actorId", "reason"]); if (value.schemaVersion !== 1 || value.reason !== "actor_absent") fail(); assertId(value.actorId); }
  else fail();
}

function validateSnapshotConsistency(snapshot) {
  const logical = snapshot.logicalReaction, result = snapshot.triggeringCommitResult, input = snapshot.originatingInputRecord;
  if (snapshot.gameSessionId !== logical.gameSessionId || snapshot.turnId !== logical.turnId || snapshot.turnOrder !== logical.turnOrder || logical.causationId !== result.requestId || logical.originatingInputRecordId !== result.inputRecordId || logical.preconditionStateVersion !== result.resultingStateVersion || input.inputRecordId !== result.inputRecordId || input.requestId !== result.requestId || input.correlationId !== result.correlationId || input.turnId !== logical.turnId || input.capturedStateVersion + 1 !== result.resultingStateVersion || input.actorId !== "player") throw invariant("contradictory_snapshot");
  if (canonicalJson(snapshot.triggeringEvents.map((event) => event.eventId)) !== canonicalJson(result.createdEventIds)) throw invariant("contradictory_snapshot");
  const byId = new Map(snapshot.triggeringEvents.map((event) => [event.eventId, event])); if (byId.size !== snapshot.triggeringEvents.length) throw invariant("contradictory_snapshot");
  const actorEntries = snapshot.currentRoster.filter((entry) => entry.participantId === logical.npcId);
  const actor = snapshot.actorApplicability, authorization = snapshot.currentAuthorization;
  if (actor.actorId !== logical.npcId || authorization.actorId !== logical.npcId) throw invariant("contradictory_snapshot");
  if (actor.presence === "present") {
    if (actorEntries.length !== 1 || actorEntries[0].participantClass !== "npc" || actor.alive !== (actorEntries[0].publicStatus === "alive") || authorization.availability !== "available") throw invariant("contradictory_snapshot");
  } else if (actorEntries.length !== 0 || authorization.availability !== "unavailable") throw invariant("contradictory_snapshot");
  if (authorization.availability === "available") {
    const canClaimSeer = authorization.authorizedResultFacts.length > 0 && authorization.roleDisclosurePolicy === "claim_when_directly_asked_after_result";
    if (canonicalJson(authorization.allowedClaimRoles) !== canonicalJson(canClaimSeer ? ["seer"] : [])) throw invariant("contradictory_snapshot");
  }
}

function reconstructAllocation(value, proposals) {
  try {
    exact(value, ["schemaVersion", "allocationType", "descriptorIds", "claimAllocations", "eventIds", "segmentIds", "publicationId"]);
    if (value.schemaVersion !== 1 || value.allocationType !== "npc_reaction_artifacts" || !Array.isArray(proposals)) fail();
    const count = proposals.length; for (const field of ["descriptorIds", "eventIds", "segmentIds"]) if (!denseUniqueIds(value[field], count, count)) fail();
    assertId(value.publicationId); if (!denseArray(value.claimAllocations, 0, 4)) fail();
    const claimIndexes = proposals.map((proposal, index) => ["role_claim", "result_claim"].includes(proposal.proposalType) ? index : -1).filter((index) => index >= 0);
    if (value.claimAllocations.length !== claimIndexes.length) fail();
    value.claimAllocations.forEach((item, index) => { exact(item, ["proposalIndex", "claimId"]); if (!Number.isSafeInteger(item.proposalIndex) || item.proposalIndex !== claimIndexes[index]) fail(); assertId(item.claimId); });
    const ids = allocationIds(value); if (new Set(ids).size !== ids.length) throw invariant("duplicate_engine_id");
    return clonePlain(value);
  } catch (error) { if (error instanceof NpcReactionPreparationInvariantError) throw error; throw invariant("invalid_artifact_allocation"); }
}

function reconstructOrder(value) {
  try {
    exact(value, ["schemaVersion", "reservationType", "preconditionNextCreatedOrder", "eventCreatedOrders", "commitResultCreatedAtOrder", "resultingNextCreatedOrder", "preconditionNextPublicationSlotOrder", "publicationSlotOrder", "resultingNextPublicationSlotOrder", "preconditionNextRecordAppendOrder", "publicationRecordAppendOrder", "resultingNextRecordAppendOrder", "priorClaimCount", "priorEventCount"]);
    if (value.schemaVersion !== 1 || value.reservationType !== "npc_reaction_orders" || !denseArray(value.eventCreatedOrders, 1, 16)) fail();
    for (const field of Object.keys(value).filter((field) => !["schemaVersion", "reservationType", "eventCreatedOrders"].includes(field))) assertSafe(value[field]); value.eventCreatedOrders.forEach(assertSafe);
    return clonePlain(value);
  } catch { throw invariant("invalid_order_reservation"); }
}

function assertReservationArithmetic(order, evidence, proposalCount, claimCount, eventCount) {
  const events = Array.from({ length: proposalCount }, (_, index) => order.preconditionNextCreatedOrder + index);
  if (canonicalJson(order.eventCreatedOrders) !== canonicalJson(events) || order.commitResultCreatedAtOrder !== order.preconditionNextCreatedOrder + proposalCount || order.resultingNextCreatedOrder !== order.preconditionNextCreatedOrder + proposalCount + 1 || order.publicationSlotOrder !== order.preconditionNextPublicationSlotOrder || order.resultingNextPublicationSlotOrder !== order.preconditionNextPublicationSlotOrder + 1 || order.publicationRecordAppendOrder !== order.preconditionNextRecordAppendOrder || order.resultingNextRecordAppendOrder !== order.preconditionNextRecordAppendOrder + 1 || order.preconditionNextCreatedOrder !== evidence.nextCreatedOrder || order.preconditionNextPublicationSlotOrder !== evidence.nextPublicationSlotOrder || order.preconditionNextRecordAppendOrder !== evidence.nextRecordAppendOrder || order.priorClaimCount !== claimCount || order.priorEventCount !== eventCount) throw invariant("invalid_order_reservation");
}

function reservationWouldOverflow(order, count) {
  return order.preconditionNextCreatedOrder > Number.MAX_SAFE_INTEGER - count - 1 || order.preconditionNextPublicationSlotOrder === Number.MAX_SAFE_INTEGER || order.preconditionNextRecordAppendOrder === Number.MAX_SAFE_INTEGER;
}

function triggerReferencesResolve(snapshot) {
  const current = new Map(snapshot.existingEvents.map((event) => [event.eventId, event]));
  return snapshot.triggeringEvents.every((event) => current.has(event.eventId) && canonicalJson(current.get(event.eventId)) === canonicalJson(event));
}

function deriveCausationEventIds(snapshot) {
  return snapshot.triggeringEvents.filter((event) => event.eventType === "public_question_recorded" && event.source.sourceType === "player_accepted_act" && event.source.inputRecordId === snapshot.logicalReaction.originatingInputRecordId && event.source.requestId === snapshot.logicalReaction.causationId && event.targetId === snapshot.logicalReaction.npcId).map((event) => event.eventId);
}

function buildPrepared(context, causationEventIds) {
  const { validatedCandidate, preparationSnapshot: snapshot, artifactAllocation: allocation, orderReservation: order } = context;
  const proposals = validatedCandidate.candidate.proposals, logical = snapshot.logicalReaction, resultingVersion = logical.preconditionStateVersion + 1;
  const claimByProposal = new Map(allocation.claimAllocations.map((item) => [item.proposalIndex, item.claimId]));
  const descriptors = [], claims = [], events = [], segments = [];
  proposals.forEach((proposal, index) => {
    const descriptorId = allocation.descriptorIds[index], eventId = allocation.eventIds[index], segmentId = allocation.segmentIds[index], claimId = claimByProposal.get(index);
    const source = { sourceType: "npc_reaction", reactionPlanId: logical.reactionPlanId, descriptorId, originatingInputRecordId: logical.originatingInputRecordId, reactionCommitRequestId: logical.requestId };
    const commonEvent = { schemaVersion: 1, eventId, requestId: logical.requestId, turnId: logical.turnId, actorId: logical.npcId, causationId: logical.causationId, correlationId: logical.correlationId, source, stateVersion: resultingVersion, occurredPhase: logical.preconditionPhase, createdOrder: order.eventCreatedOrders[index] };
    if (proposal.proposalType === "role_claim") {
      descriptors.push({ descriptorId, descriptorType: "role_claim", claimedRole: proposal.claimedRole });
      claims.push(buildClaim({ claimId, descriptorId, proposal, snapshot, logical, resultingVersion }));
      events.push({ ...commonEvent, idempotencyKey: sha256Fingerprint(logical.reactionPlanId, descriptorId, "role_claim_recorded"), eventType: "role_claim_recorded", claimId });
      segments.push({ segmentId, descriptorId, type: "canonical_claim", claimId });
    } else if (proposal.proposalType === "result_claim") {
      descriptors.push({ descriptorId, descriptorType: "result_claim", targetId: proposal.targetId, result: proposal.result });
      claims.push(buildClaim({ claimId, descriptorId, proposal, snapshot, logical, resultingVersion }));
      events.push({ ...commonEvent, idempotencyKey: sha256Fingerprint(logical.reactionPlanId, descriptorId, "result_claim_recorded"), eventType: "result_claim_recorded", claimId });
      segments.push({ segmentId, descriptorId, type: "canonical_claim", claimId });
    } else if (proposal.proposalType === "vote_declaration") {
      descriptors.push({ descriptorId, descriptorType: "vote_declaration", targetId: proposal.targetId });
      events.push({ ...commonEvent, idempotencyKey: sha256Fingerprint(logical.reactionPlanId, descriptorId, "vote_declared"), eventType: "vote_declared", targetId: proposal.targetId });
      segments.push({ segmentId, descriptorId, type: "canonical_vote", voteEventId: eventId });
    } else {
      descriptors.push({ descriptorId, descriptorType: "suspicion", targetId: proposal.targetId });
      events.push({ ...commonEvent, idempotencyKey: sha256Fingerprint(logical.reactionPlanId, descriptorId, "suspicion_expressed"), eventType: "suspicion_expressed", targetId: proposal.targetId });
      segments.push({ segmentId, descriptorId, type: "canonical_suspicion", suspicionEventId: eventId });
    }
  });
  const types = new Set(proposals.map((proposal) => proposal.proposalType));
  const plan = { schemaVersion: 1, requestId: logical.requestId, correlationId: logical.correlationId, causationId: logical.causationId, originatingInputRecordId: logical.originatingInputRecordId, locale: snapshot.originatingInputRecord.locale, causationEventIds, reactionPlanId: logical.reactionPlanId, successfulAttemptId: validatedCandidate.binding.reactionAttemptId, turnId: logical.turnId, preconditionStateVersion: logical.preconditionStateVersion, resultingStateVersion: resultingVersion, npcId: logical.npcId, renderMode: "canonical_only", intendedSpeechActs: descriptors, policies: { policyType: "reaction_policies", allowStateChanges: true, allowClaims: types.has("role_claim") || types.has("result_claim"), allowVoteDeclaration: types.has("vote_declaration"), allowSuspicionUpdate: types.has("suspicion"), allowMemoryUpdate: false }, canonicalSegments: segments, maxChars: 1000 };
  const publication = { schemaVersion: 1, recordType: "npc_canonical_published", publicationId: allocation.publicationId, reactionPlanId: logical.reactionPlanId, reactionCommitRequestId: logical.requestId, originatingInputRecordId: logical.originatingInputRecordId, correlationId: logical.correlationId, turnId: logical.turnId, reactionResultingStateVersion: resultingVersion, actorId: logical.npcId, locale: snapshot.originatingInputRecord.locale, canonicalRendererVersion: 1, canonicalSegmentIds: segments.map((segment) => segment.segmentId), publicationSlotOrder: order.publicationSlotOrder, recordAppendOrder: order.publicationRecordAppendOrder };
  const binding = { schemaVersion: 1, gameSessionId: logical.gameSessionId, reactionPlanId: logical.reactionPlanId, successfulAttemptId: validatedCandidate.binding.reactionAttemptId, requestId: logical.requestId, requestFingerprint: logical.requestFingerprint, correlationId: logical.correlationId, causationId: logical.causationId, originatingInputRecordId: logical.originatingInputRecordId, turnId: logical.turnId, turnOrder: logical.turnOrder, preconditionPhase: logical.preconditionPhase, preconditionStateVersion: logical.preconditionStateVersion, npcId: logical.npcId };
  const expectedCommitResult = { schemaVersion: 1, requestId: logical.requestId, correlationId: logical.correlationId, requestFingerprint: logical.requestFingerprint, commitType: "npc_reaction", preconditionStateVersion: logical.preconditionStateVersion, resultingStateVersion: resultingVersion, reactionPlanId: logical.reactionPlanId, npcPublicationId: allocation.publicationId, createdEventIds: events.map((event) => event.eventId), createdClaimIds: claims.map((claim) => claim.claimId), createdAtOrder: order.commitResultCreatedAtOrder, resultMode: "canonical_only" };
  const delta = { schemaVersion: 1, commitType: "npc_reaction", resultMode: "canonical_only", binding, preparationFingerprint: ZERO_FINGERPRINT, requestFingerprint: validatedCandidate.binding.requestFingerprint, candidateFingerprint: validatedCandidate.candidateFingerprint, projectionFingerprint: validatedCandidate.validationContext.projectionFingerprint, preconditionPhase: logical.preconditionPhase, resultingPhase: logical.preconditionPhase, preconditionStateVersion: logical.preconditionStateVersion, resultingStateVersion: resultingVersion, plan, claims, events, publication, effects: { suspicionScoreUpdates: [], memoryUpdates: [], legacyPublicHistoryEntries: [], voteStateUpdates: [], phaseTransitions: [] }, artifactAllocation: clonePlain(allocation), orderReservation: clonePlain(order), expectedCommitResult, idempotencyReservation: { schemaVersion: 1, requestId: logical.requestId, requestFingerprint: logical.requestFingerprint, reactionPlanId: logical.reactionPlanId, successfulAttemptId: validatedCandidate.binding.reactionAttemptId, preparationFingerprint: ZERO_FINGERPRINT } };
  let fingerprint;
  try { fingerprint = sha256CanonicalJson(delta); } catch { throw invariant("preparation_fingerprint_failure"); }
  if (!SHA256_PATTERN.test(fingerprint)) throw invariant("preparation_fingerprint_failure");
  delta.preparationFingerprint = fingerprint; delta.idempotencyReservation.preparationFingerprint = fingerprint;
  const value = { schemaVersion: 1, preparationType: "canonical_npc_reaction", delta, preparationFingerprint: fingerprint };
  const check = clonePlain(delta); check.preparationFingerprint = ZERO_FINGERPRINT; check.idempotencyReservation.preparationFingerprint = ZERO_FINGERPRINT;
  if (sha256CanonicalJson(check) !== fingerprint || delta.preparationFingerprint !== delta.idempotencyReservation.preparationFingerprint || delta.preparationFingerprint !== value.preparationFingerprint) throw invariant("preparation_fingerprint_failure");
  return value;
}

function buildClaim({ claimId, descriptorId, proposal, snapshot, logical, resultingVersion }) {
  const prior = snapshot.existingClaims.filter((claim) => claim.createdStateVersion < resultingVersion);
  const sameSubject = (claim) => claim.actorId === logical.npcId && claim.type === proposal.proposalType && (proposal.proposalType === "role_claim" || claim.targetId === proposal.targetId);
  const samePayload = (claim) => proposal.proposalType === "role_claim" ? claim.claimedRole === proposal.claimedRole : claim.targetId === proposal.targetId && claim.result === proposal.result;
  const exact = prior.find((claim) => sameSubject(claim) && samePayload(claim));
  const contradictions = exact ? [] : prior.filter((claim) => sameSubject(claim) && !samePayload(claim)).map((claim) => claim.claimId);
  const source = { sourceType: "npc_reaction", reactionPlanId: logical.reactionPlanId, descriptorId, originatingInputRecordId: logical.originatingInputRecordId, reactionCommitRequestId: logical.requestId };
  const common = { schemaVersion: 1, claimId, claimRevision: 1, actorId: logical.npcId, source, idempotencyKey: npcClaimIdempotencyKey({ reactionCommitRequestId: logical.requestId, reactionPlanId: logical.reactionPlanId, descriptorId, actorId: logical.npcId, claimKind: proposal.proposalType }), createdTurnId: logical.turnId, createdStateVersion: resultingVersion, repeatsClaimId: exact?.claimId ?? null, contradictsClaimIds: contradictions, status: "asserted", type: proposal.proposalType };
  return proposal.proposalType === "role_claim" ? { ...common, claimedRole: proposal.claimedRole } : { ...common, targetId: proposal.targetId, result: proposal.result };
}

function validatePreparedArtifacts(value, candidateBinding) {
  const delta = value.delta;
  validateNpcReactionPlan(delta.plan); delta.claims.forEach(validateCanonicalClaim); delta.events.forEach(validatePublicEvent); validateDisplayPublicationRecord(delta.publication); validateConversationCommitResult(delta.expectedCommitResult);
  validateReactionPlanReferences(delta.plan, { schemaVersion: 1, contextType: "pre_commit", preparationBinding: delta.binding, commitDelta: delta, validatedCandidateBinding: candidateBinding });
}

function buildRejectionBinding(snapshot) { const logical = snapshot.logicalReaction; return { schemaVersion: 1, gameSessionId: logical.gameSessionId, reactionPlanId: logical.reactionPlanId, successfulAttemptId: snapshot.winningAttempt.reactionAttemptId, requestId: logical.requestId, correlationId: logical.correlationId, turnId: logical.turnId, preconditionStateVersion: logical.preconditionStateVersion, npcId: logical.npcId }; }
function rejected(binding, stage, reasonCode, location) { return deepFreeze({ schemaVersion: 1, status: "rejected", binding: clonePlain(binding), rejection: { stage, reasonCode, retryable: false, diagnostics: [{ code: reasonCode, location }] } }); }
function allocationIds(allocation) { return [...allocation.descriptorIds, ...allocation.claimAllocations.map((item) => item.claimId), ...allocation.eventIds, ...allocation.segmentIds, allocation.publicationId]; }
function invariant(code) { return new NpcReactionPreparationInvariantError(code); }
function clonePlain(value) { if (Array.isArray(value)) return value.map(clonePlain); if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clonePlain(child)])); return value; }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function sameKeys(value, fields) { return isPlainObject(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)) && Object.keys(value).every((field) => fields.includes(field)); }
function exact(value, fields) { if (!sameKeys(value, fields)) fail(); }
function denseArray(value, min, max) { if (!Array.isArray(value) || value.length < min || value.length > max) return false; for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false; return true; }
function denseUniqueIds(value, min, max) { if (!denseArray(value, min, max)) return false; try { value.forEach(assertId); return new Set(value).size === value.length; } catch { return false; } }
function assertId(value) { if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(); }
function assertFingerprint(value) { if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(); }
function assertSafe(value) { if (!Number.isSafeInteger(value) || value < 0) fail(); }
function fail() { throw new TypeError("invalid"); }
