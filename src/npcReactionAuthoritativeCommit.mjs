import { ID_PATTERN, SCHEMA_VERSION, SHA256_PATTERN, enums } from "./conversation/domain.mjs";
import { canonicalJson, sha256CanonicalJson } from "./conversation/ids.mjs";
import { validateConversationCommitResult, validateNpcReactionPlan } from "./conversation/validators.mjs";
import { validateCommittedConversationGraph, validateReactionPlanReferences } from "./conversation/references.mjs";
import { validateNpcReactionCoordinatorRoot } from "./npcReactionCoordinator.mjs";

export const NPC_REACTION_COMMIT_REJECTION_CODES = Object.freeze([
  "idempotency_conflict", "identity_conflict", "stale_session", "stale_turn",
  "stale_phase", "stale_state_version", "logical_reaction_mismatch",
  "attempt_mismatch", "actor_ineligible", "target_ineligible",
  "invalid_reference", "permission_denied", "result_fact_mismatch",
  "artifact_id_collision", "order_precondition_mismatch",
  "state_version_exhausted", "order_exhausted"
]);

export const NPC_REACTION_COMMIT_INVARIANT_CODES = Object.freeze([
  "invalid_commit_input", "unsupported_commit_schema", "invalid_prepared_reaction",
  "preparation_fingerprint_mismatch", "invalid_commit_delta",
  "corrupt_committed_reaction_graph", "invalid_idempotency_record",
  "invalid_authoritative_registry", "invalid_terminal_slot_reservation",
  "invalid_committed_tombstone_attempt_summary",
  "invalid_non_commit_tombstone_attempt_summary",
  "terminal_lifecycle_graph_mismatch",
  "invalid_canonical_publication_counter_state", "commit_application_failure",
  "working_copy_validation_failure"
]);

const INVARIANT_MESSAGE = "Invalid NPC reaction commit operation.";
const ZERO_FINGERPRINT = "0".repeat(64);
const INPUT_FIELDS = Object.freeze([
  "schemaVersion", "currentState", "preparedReaction",
  "preCommitReferenceContext", "coordinatorRoot", "liveValidationContext"
]);
const LIVE_FIELDS = Object.freeze([
  "schemaVersion", "contextType", "gameSessionId", "turnId", "turnOrder",
  "currentPhase", "currentStateVersion", "actorApplicability",
  "currentAuthorization", "currentTargetIds"
]);
const REQUIRED_CONVERSATION_ARRAYS = Object.freeze([
  "inputRecords", "acceptedSpeechActs", "claims", "events", "displayPlans",
  "reactionPlans", "publications", "commitResults",
  "npcReactionCommitIdempotencyRecords"
]);

export class NpcReactionCommitInvariantError extends Error {
  constructor(code) {
    super(INVARIANT_MESSAGE);
    this.name = "NpcReactionCommitInvariantError";
    this.code = NPC_REACTION_COMMIT_INVARIANT_CODES.includes(code)
      ? code
      : "invalid_commit_input";
  }
}

export function commitNpcReactionAuthoritatively(input) {
  const context = reconstructInput(input);
  const { currentState, preparedReaction, preCommitReferenceContext, coordinatorRoot, liveValidationContext } = context;
  const delta = preparedReaction.delta;
  const binding = delta.binding;
  const rejectionBinding = buildRejectionBinding(binding);

  validateAuthoritativeRegistry(currentState);
  validatePreparationFingerprint(preparedReaction);
  try {
    validateReactionPlanReferences(delta.plan, preCommitReferenceContext);
  } catch {
    throw invariant("invalid_commit_delta");
  }

  const replay = resolveReplay(currentState, preparedReaction);
  if (replay) return replay;

  const identityConflict = findIdentityConflict(currentState, delta);
  if (identityConflict) return rejected(rejectionBinding, "idempotency", "identity_conflict", "identity_index");

  const applicability = validateApplicability({
    currentState, delta, coordinatorRoot, liveValidationContext, rejectionBinding
  });
  if (applicability) return applicability;

  const authorization = validateFinalAuthorization(currentState, delta, liveValidationContext, rejectionBinding);
  if (authorization) return authorization;

  const collision = validateArtifactAvailability(currentState, delta, rejectionBinding);
  if (collision) return collision;

  const ordering = validateOrdering(currentState, delta, rejectionBinding);
  if (ordering) return ordering;

  let replacementState;
  let idempotencyRecord;
  try {
    replacementState = clone(currentState);
    idempotencyRecord = buildIdempotencyRecord(delta, preparedReaction.preparationFingerprint);
    applyDelta(replacementState, delta, idempotencyRecord);
    validateCommittedState(replacementState, delta, idempotencyRecord);
  } catch (error) {
    if (error instanceof NpcReactionCommitInvariantError) throw error;
    throw invariant("commit_application_failure");
  }

  const result = clone(delta.expectedCommitResult);
  const cleanupHandoff = {
    schemaVersion: SCHEMA_VERSION,
    gameSessionId: binding.gameSessionId,
    reactionPlanId: binding.reactionPlanId,
    successfulAttemptId: binding.successfulAttemptId,
    preparationFingerprint: preparedReaction.preparationFingerprint,
    npcPublicationId: delta.publication.publicationId,
    commitResultRequestId: delta.expectedCommitResult.requestId
  };
  return freeze({
    schemaVersion: SCHEMA_VERSION,
    status: "committed",
    replacementState,
    result,
    coordinatorCleanupHandoff: cleanupHandoff
  });
}

function reconstructInput(input) {
  if (!sameKeys(input, INPUT_FIELDS)) throw invariant("invalid_commit_input");
  if (input.schemaVersion !== SCHEMA_VERSION) throw invariant("unsupported_commit_schema");
  const currentState = clonePlainObject(input.currentState, "invalid_commit_input");
  const preparedReaction = reconstructPreparedReaction(input.preparedReaction);
  const preCommitReferenceContext = clonePlainObject(input.preCommitReferenceContext, "invalid_commit_input");
  const coordinatorRoot = clonePlainObject(input.coordinatorRoot, "invalid_commit_input");
  const liveValidationContext = reconstructLiveContext(input.liveValidationContext);
  if (preCommitReferenceContext.contextType !== "pre_commit"
    || canonicalJson(preCommitReferenceContext.commitDelta) !== canonicalJson(preparedReaction.delta)) {
    throw invariant("invalid_commit_delta");
  }
  try { validateNpcReactionCoordinatorRoot(coordinatorRoot); }
  catch { throw invariant("invalid_authoritative_registry"); }
  return { currentState, preparedReaction, preCommitReferenceContext, coordinatorRoot, liveValidationContext };
}

function reconstructPreparedReaction(value) {
  if (!sameKeys(value, ["schemaVersion", "preparationType", "delta", "preparationFingerprint"])
    || value.schemaVersion !== SCHEMA_VERSION
    || value.preparationType !== "canonical_npc_reaction"
    || !SHA256_PATTERN.test(value.preparationFingerprint)) {
    throw invariant("invalid_prepared_reaction");
  }
  const copy = clonePlainObject(value, "invalid_prepared_reaction");
  try {
    validateNpcReactionPlan(copy.delta?.plan);
    validateConversationCommitResult(copy.delta?.expectedCommitResult);
  } catch {
    throw invariant("invalid_prepared_reaction");
  }
  return copy;
}

function reconstructLiveContext(value) {
  if (!sameKeys(value, LIVE_FIELDS)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.contextType !== "npc_reaction_commit_live") {
    throw invariant("invalid_commit_input");
  }
  for (const field of ["gameSessionId", "turnId"]) assertId(value[field]);
  assertSafe(value.turnOrder);
  assertSafe(value.currentStateVersion);
  if (!enums.gamePhase.includes(value.currentPhase)) throw invariant("invalid_commit_input");
  validateActorApplicability(value.actorApplicability);
  validateAuthorization(value.currentAuthorization);
  if (!denseUniqueIds(value.currentTargetIds, 0, 16)) throw invariant("invalid_commit_input");
  return clonePlainObject(value, "invalid_commit_input");
}

function validateAuthoritativeRegistry(state) {
  if (!isPlainObject(state) || !isPlainObject(state.conversation)
    || !Array.isArray(state.players)) throw invariant("invalid_authoritative_registry");
  for (const field of ["gameSessionId", "turnId"]) assertId(state[field], "invalid_authoritative_registry");
  assertSafe(state.turnOrder, "invalid_authoritative_registry");
  assertSafe(state.stateVersion, "invalid_authoritative_registry");
  if (!enums.gamePhase.includes(state.phase)) throw invariant("invalid_authoritative_registry");
  for (const field of REQUIRED_CONVERSATION_ARRAYS) {
    if (!Array.isArray(state.conversation[field])) throw invariant("invalid_authoritative_registry");
  }
  for (const field of ["nextCreatedOrder", "nextPublicationSlotOrder", "nextRecordAppendOrder"]) {
    assertSafe(state.conversation[field], field.includes("Publication") || field.includes("Record")
      ? "invalid_canonical_publication_counter_state"
      : "invalid_authoritative_registry");
  }
  const ids = new Set();
  for (const player of state.players) {
    if (!isPlainObject(player) || typeof player.alive !== "boolean"
      || typeof player.maySpeak !== "boolean" || !["player", "npc"].includes(player.participantClass)) {
      throw invariant("invalid_authoritative_registry");
    }
    assertId(player.participantId, "invalid_authoritative_registry");
    if (ids.has(player.participantId)) throw invariant("invalid_authoritative_registry");
    ids.add(player.participantId);
  }
  validatePublicationCounters(state.conversation);
  try { validateCommittedConversationGraph(state.conversation); }
  catch { throw invariant("invalid_authoritative_registry"); }
}

function validatePreparationFingerprint(prepared) {
  const delta = prepared.delta;
  if (!isPlainObject(delta)
    || delta.preparationFingerprint !== prepared.preparationFingerprint
    || delta.idempotencyReservation?.preparationFingerprint !== prepared.preparationFingerprint) {
    throw invariant("preparation_fingerprint_mismatch");
  }
  const hashInput = clone(delta);
  hashInput.preparationFingerprint = ZERO_FINGERPRINT;
  hashInput.idempotencyReservation.preparationFingerprint = ZERO_FINGERPRINT;
  if (sha256CanonicalJson(hashInput) !== prepared.preparationFingerprint) {
    throw invariant("preparation_fingerprint_mismatch");
  }
}

function resolveReplay(state, prepared) {
  const delta = prepared.delta;
  const binding = delta.binding;
  const records = state.conversation.npcReactionCommitIdempotencyRecords;
  const primary = records.find((record) =>
    record.gameSessionId === binding.gameSessionId
    && record.reactionPlanId === binding.reactionPlanId
    && record.requestId === binding.requestId);
  if (!primary) return null;
  if (primary.requestFingerprint !== binding.requestFingerprint
    || primary.preparationFingerprint !== prepared.preparationFingerprint) {
    return rejected(buildRejectionBinding(binding), "idempotency", "idempotency_conflict", "idempotency_record");
  }
  try { validateCommittedConversationGraph(state.conversation); }
  catch { throw invariant("corrupt_committed_reaction_graph"); }
  const expected = buildIdempotencyRecord(delta, prepared.preparationFingerprint);
  if (canonicalJson(primary) !== canonicalJson(expected)) {
    return rejected(buildRejectionBinding(binding), "idempotency", "identity_conflict", "identity_index");
  }
  const result = state.conversation.commitResults.find((item) =>
    item.commitType === "npc_reaction" && item.requestId === primary.commitResultRequestId);
  if (!result) throw invariant("corrupt_committed_reaction_graph");
  return freeze({ schemaVersion: SCHEMA_VERSION, status: "replayed", result: clone(result) });
}

function findIdentityConflict(state, delta) {
  const b = delta.binding;
  const records = state.conversation.npcReactionCommitIdempotencyRecords;
  return records.some((record) =>
    record.requestId === b.requestId
    || record.reactionPlanId === b.reactionPlanId
    || record.successfulAttemptId === b.successfulAttemptId
    || (record.causationId === b.causationId
      && record.originatingInputRecordId === b.originatingInputRecordId
      && record.npcId === b.npcId))
    || state.conversation.commitResults.some((result) => result.requestId === b.requestId)
    || state.conversation.reactionPlans.some((plan) => plan.reactionPlanId === b.reactionPlanId)
    || state.conversation.publications.some((publication) =>
      publication.publicationId === delta.publication.publicationId);
}

function validateApplicability({ currentState: state, delta, coordinatorRoot, liveValidationContext: live, rejectionBinding }) {
  const b = delta.binding;
  if (state.gameSessionId !== b.gameSessionId || live.gameSessionId !== state.gameSessionId || coordinatorRoot.gameSessionId !== state.gameSessionId) {
    return rejected(rejectionBinding, "applicability", "stale_session", "session");
  }
  if (state.turnId !== b.turnId || state.turnOrder !== b.turnOrder
    || live.turnId !== state.turnId || live.turnOrder !== state.turnOrder) {
    return rejected(rejectionBinding, "applicability", "stale_turn", "turn");
  }
  if (state.phase !== b.preconditionPhase || live.currentPhase !== state.phase
    || delta.preconditionPhase !== state.phase || delta.resultingPhase !== state.phase) {
    return rejected(rejectionBinding, "applicability", "stale_phase", "phase");
  }
  if (state.stateVersion !== b.preconditionStateVersion
    || live.currentStateVersion !== state.stateVersion
    || delta.preconditionStateVersion !== state.stateVersion
    || delta.plan.preconditionStateVersion !== state.stateVersion) {
    return rejected(rejectionBinding, "applicability", "stale_state_version", "state_version");
  }
  if (state.stateVersion === Number.MAX_SAFE_INTEGER) {
    return rejected(rejectionBinding, "ordering", "state_version_exhausted", "state_version");
  }
  if (delta.resultingStateVersion !== state.stateVersion + 1
    || delta.plan.resultingStateVersion !== state.stateVersion + 1) {
    throw invariant("invalid_commit_delta");
  }
  const logical = coordinatorRoot.logicalReactions[b.reactionPlanId];
  if (!logical || logical.status !== "active"
    || logical.requestId !== b.requestId
    || logical.requestFingerprint !== b.requestFingerprint
    || logical.correlationId !== b.correlationId
    || logical.causationId !== b.causationId
    || logical.originatingInputRecordId !== b.originatingInputRecordId
    || logical.turnId !== b.turnId
    || logical.turnOrder !== b.turnOrder
    || logical.preconditionPhase !== b.preconditionPhase
    || logical.preconditionStateVersion !== b.preconditionStateVersion
    || logical.npcId !== b.npcId
    || logical.projectionFingerprint !== delta.projectionFingerprint) {
    return rejected(rejectionBinding, "applicability", "logical_reaction_mismatch", "logical_reaction");
  }
  const attempt = coordinatorRoot.reactionAttempts[b.successfulAttemptId];
  if (!attempt || attempt.reactionPlanId !== b.reactionPlanId
    || attempt.status !== "validated"
    || attempt.candidateFingerprint !== delta.candidateFingerprint
    || attempt.requestId !== b.requestId
    || attempt.requestFingerprint !== b.requestFingerprint) {
    return rejected(rejectionBinding, "applicability", "attempt_mismatch", "attempt");
  }
  const reservation = coordinatorRoot.terminalSlotReservations[b.reactionPlanId];
  if (!reservation || reservation.gameSessionId !== b.gameSessionId) {
    throw invariant("invalid_terminal_slot_reservation");
  }
  return null;
}

function validateFinalAuthorization(state, delta, live, binding) {
  const actor = state.players.find((item) => item.participantId === delta.binding.npcId);
  const actorEvidence = live.actorApplicability;
  const authorization = live.currentAuthorization;
  if (actorEvidence.actorId !== delta.binding.npcId
    || authorization.actorId !== delta.binding.npcId
    || (actorEvidence.presence === "present" && authorization.availability !== "available")
    || (actorEvidence.presence === "absent" && authorization.availability !== "unavailable")
    || (actor && actorEvidence.presence !== "present")
    || (!actor && actorEvidence.presence !== "absent")
    || (actor && (actorEvidence.alive !== actor.alive || actorEvidence.maySpeak !== actor.maySpeak))) {
    throw invariant("invalid_commit_input");
  }
  if (!actor || actor.participantClass !== "npc" || !actor.alive || !actor.maySpeak) {
    return rejected(binding, "authorization", "actor_ineligible", "actor");
  }
  if (!currentReferencesResolve(state.conversation, delta)) {
    return rejected(binding, "authorization", "invalid_reference", "reference");
  }
  const descriptors = delta.plan.intendedSpeechActs;
  for (const descriptor of descriptors) {
    if (!Object.hasOwn(descriptor, "targetId")) continue;
    const target = state.players.find((item) => item.participantId === descriptor.targetId);
    const aliveRequired = ["vote_declaration", "suspicion"].includes(descriptor.descriptorType);
    if (!target || target.participantClass !== "npc"
      || descriptor.targetId === actor.participantId
      || !live.currentTargetIds.includes(descriptor.targetId)
      || (aliveRequired && !target.alive)) {
      return rejected(binding, "authorization", "target_ineligible", "target");
    }
  }
  const hasClaims = descriptors.some((item) => ["role_claim", "result_claim"].includes(item.descriptorType));
  if (hasClaims && authorization.roleDisclosurePolicy !== "claim_when_directly_asked_after_result") {
    return rejected(binding, "authorization", "permission_denied", "policy");
  }
  for (const descriptor of descriptors) {
    if (descriptor.descriptorType === "role_claim"
      && !authorization.allowedClaimRoles.includes(descriptor.claimedRole)) {
      return rejected(binding, "authorization", "permission_denied", "policy");
    }
  }
  for (const descriptor of descriptors) {
    if (descriptor.descriptorType === "result_claim"
      && !authorization.authorizedResultFacts.some((fact) =>
        fact.targetId === descriptor.targetId && fact.result === descriptor.result)) {
      return rejected(binding, "authorization", "result_fact_mismatch", "known_information");
    }
  }
  return null;
}

function validateArtifactAvailability(state, delta, binding) {
  const occupied = collectIds(state);
  const ids = [
    delta.plan.reactionPlanId,
    ...delta.artifactAllocation.descriptorIds,
    ...delta.artifactAllocation.claimAllocations.map((item) => item.claimId),
    ...delta.artifactAllocation.eventIds,
    ...delta.artifactAllocation.segmentIds,
    delta.artifactAllocation.publicationId
  ];
  if (ids.some((id) => occupied.has(id))) {
    return rejected(binding, "allocation", "artifact_id_collision", "artifact_allocation");
  }
  return null;
}

function validateOrdering(state, delta, binding) {
  const order = delta.orderReservation;
  const conversation = state.conversation;
  const expectedEventOrders = delta.events.map((_, index) =>
    order.preconditionNextCreatedOrder + index);
  if (canonicalJson(order.eventCreatedOrders) !== canonicalJson(expectedEventOrders)
    || order.commitResultCreatedAtOrder !== order.preconditionNextCreatedOrder + delta.events.length
    || order.resultingNextCreatedOrder !== order.commitResultCreatedAtOrder + 1
    || order.publicationSlotOrder !== order.preconditionNextPublicationSlotOrder
    || order.resultingNextPublicationSlotOrder !== order.publicationSlotOrder + 1
    || order.publicationRecordAppendOrder !== order.preconditionNextRecordAppendOrder
    || order.resultingNextRecordAppendOrder !== order.publicationRecordAppendOrder + 1) {
    throw invariant("invalid_commit_delta");
  }
  if (order.preconditionNextCreatedOrder !== conversation.nextCreatedOrder
    || order.preconditionNextPublicationSlotOrder !== conversation.nextPublicationSlotOrder
    || order.preconditionNextRecordAppendOrder !== conversation.nextRecordAppendOrder
    || order.priorClaimCount !== conversation.claims.length
    || order.priorEventCount !== conversation.events.length) {
    return rejected(binding, "ordering", "order_precondition_mismatch", "order_reservation");
  }
  if (conversation.nextCreatedOrder === Number.MAX_SAFE_INTEGER
    || conversation.nextPublicationSlotOrder === Number.MAX_SAFE_INTEGER
    || conversation.nextRecordAppendOrder === Number.MAX_SAFE_INTEGER
    || order.resultingNextCreatedOrder > Number.MAX_SAFE_INTEGER) {
    return rejected(binding, "ordering", "order_exhausted", "order_reservation");
  }
  return null;
}

function buildIdempotencyRecord(delta, preparationFingerprint) {
  const b = delta.binding;
  return {
    schemaVersion: SCHEMA_VERSION,
    recordType: "npc_reaction_commit_idempotency",
    gameSessionId: b.gameSessionId,
    reactionPlanId: b.reactionPlanId,
    requestId: b.requestId,
    requestFingerprint: b.requestFingerprint,
    preparationFingerprint,
    successfulAttemptId: b.successfulAttemptId,
    correlationId: b.correlationId,
    causationId: b.causationId,
    originatingInputRecordId: b.originatingInputRecordId,
    turnId: b.turnId,
    turnOrder: b.turnOrder,
    npcId: b.npcId,
    preconditionStateVersion: b.preconditionStateVersion,
    resultingStateVersion: delta.resultingStateVersion,
    npcPublicationId: delta.publication.publicationId,
    commitResultRequestId: delta.expectedCommitResult.requestId
  };
}

function applyDelta(state, delta, record) {
  const c = state.conversation;
  c.reactionPlans.push(clone(delta.plan));
  c.claims.push(...clone(delta.claims));
  c.events.push(...clone(delta.events));
  c.publications.push(clone(delta.publication));
  c.npcReactionCommitIdempotencyRecords.push(clone(record));
  c.commitResults.push(clone(delta.expectedCommitResult));
  c.nextCreatedOrder = delta.orderReservation.resultingNextCreatedOrder;
  c.nextPublicationSlotOrder = delta.orderReservation.resultingNextPublicationSlotOrder;
  c.nextRecordAppendOrder = delta.orderReservation.resultingNextRecordAppendOrder;
  state.stateVersion = delta.resultingStateVersion;
  state.phase = delta.resultingPhase;
}

function validateCommittedState(state, delta, record) {
  try {
    validateCommittedConversationGraph(state.conversation);
    validateReactionPlanReferences(delta.plan, {
      schemaVersion: SCHEMA_VERSION,
      contextType: "committed_graph",
      reactionPlan: delta.plan,
      idempotencyRecord: record,
      commitResult: delta.expectedCommitResult,
      publication: delta.publication,
      claims: delta.claims,
      events: delta.events,
      segments: delta.plan.canonicalSegments
    });
    validatePublicationCounters(state.conversation);
  } catch {
    throw invariant("working_copy_validation_failure");
  }
  if (record.successfulAttemptId !== delta.plan.successfulAttemptId
    || record.turnOrder !== delta.binding.turnOrder
    || state.stateVersion !== delta.resultingStateVersion) {
    throw invariant("working_copy_validation_failure");
  }
}

function validatePublicationCounters(conversation) {
  const publications = conversation.publications;
  if (conversation.nextRecordAppendOrder !== publications.length) {
    throw invariant("invalid_canonical_publication_counter_state");
  }
  publications.forEach((record, index) => {
    if (record.recordAppendOrder !== index) throw invariant("invalid_canonical_publication_counter_state");
  });
  const slots = publications.map((record) => record.publicationSlotOrder);
  const expected = slots.length === 0 ? 0 : Math.max(...slots) + 1;
  if (conversation.nextPublicationSlotOrder !== expected) {
    throw invariant("invalid_canonical_publication_counter_state");
  }
}

function currentReferencesResolve(conversation, delta) {
  const input = conversation.inputRecords.find((item) =>
    item.inputRecordId === delta.binding.originatingInputRecordId);
  if (!input || input.turnId !== delta.binding.turnId) return false;
  return delta.plan.causationEventIds.every((id) =>
    conversation.events.some((event) => event.eventId === id));
}

function validateActorApplicability(value) {
  if (value?.presence === "present") {
    if (!sameKeys(value, ["schemaVersion", "presence", "actorId", "alive", "maySpeak"])
      || value.schemaVersion !== SCHEMA_VERSION
      || typeof value.alive !== "boolean" || typeof value.maySpeak !== "boolean") {
      throw invariant("invalid_commit_input");
    }
    assertId(value.actorId);
    return;
  }
  if (value?.presence === "absent") {
    if (!sameKeys(value, ["schemaVersion", "presence", "actorId", "absenceReason"])
      || value.schemaVersion !== SCHEMA_VERSION
      || value.absenceReason !== "removed_from_roster") throw invariant("invalid_commit_input");
    assertId(value.actorId);
    return;
  }
  throw invariant("invalid_commit_input");
}

function validateAuthorization(value) {
  if (value?.availability === "unavailable") {
    if (!sameKeys(value, ["schemaVersion", "availability", "actorId", "reason"])
      || value.schemaVersion !== SCHEMA_VERSION || value.reason !== "actor_absent") {
      throw invariant("invalid_commit_input");
    }
    assertId(value.actorId);
    return;
  }
  if (!sameKeys(value, [
    "schemaVersion", "availability", "actorId", "roleDisclosurePolicy",
    "allowedClaimRoles", "authorizedResultFacts"
  ]) || value.schemaVersion !== SCHEMA_VERSION || value.availability !== "available") {
    throw invariant("invalid_commit_input");
  }
  assertId(value.actorId);
  if (!["never_confess_werewolf", "claim_when_directly_asked_after_result", "avoid_unnecessary_claim"]
    .includes(value.roleDisclosurePolicy)
    || !Array.isArray(value.allowedClaimRoles)
    || value.allowedClaimRoles.length > 1
    || new Set(value.allowedClaimRoles).size !== value.allowedClaimRoles.length
    || value.allowedClaimRoles.some((role) => !enums.claimableRole.includes(role))
    || !Array.isArray(value.authorizedResultFacts)
    || value.authorizedResultFacts.length > 16) throw invariant("invalid_commit_input");
  const pairs = new Set();
  value.authorizedResultFacts.forEach((fact) => {
    if (!sameKeys(fact, ["targetId", "result"])) throw invariant("invalid_commit_input");
    assertId(fact.targetId);
    if (!enums.claimResult.includes(fact.result)) throw invariant("invalid_commit_input");
    const key = `${fact.targetId}\0${fact.result}`;
    if (pairs.has(key)) throw invariant("invalid_commit_input");
    pairs.add(key);
  });
}

function buildRejectionBinding(binding) {
  return {
    schemaVersion: SCHEMA_VERSION,
    gameSessionId: binding.gameSessionId,
    reactionPlanId: binding.reactionPlanId,
    successfulAttemptId: binding.successfulAttemptId,
    requestId: binding.requestId,
    correlationId: binding.correlationId,
    turnId: binding.turnId,
    preconditionStateVersion: binding.preconditionStateVersion,
    npcId: binding.npcId
  };
}

function rejected(binding, stage, reasonCode, location) {
  return freeze({
    schemaVersion: SCHEMA_VERSION,
    status: "rejected",
    binding: clone(binding),
    rejection: {
      stage,
      reasonCode,
      retryable: false,
      diagnostics: [{ code: reasonCode, location }]
    }
  });
}

function collectIds(value, ids = new Set(), key = "") {
  if (typeof value === "string" && (key.endsWith("Id") || key.endsWith("Ids"))) {
    if (ID_PATTERN.test(value)) ids.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectIds(item, ids, key));
  } else if (isPlainObject(value)) {
    for (const [childKey, child] of Object.entries(value)) collectIds(child, ids, childKey);
  }
  return ids;
}

function clonePlainObject(value, code) {
  if (!isPlainObject(value)) throw invariant(code);
  try { return clone(value); } catch { throw invariant(code); }
}
function clone(value) { return structuredClone(value); }
function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  }
  return value;
}
function invariant(code) { return new NpcReactionCommitInvariantError(code); }
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function sameKeys(value, fields) {
  return isPlainObject(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => fields.includes(field));
}
function denseUniqueIds(value, min, max) {
  return Array.isArray(value) && value.length >= min && value.length <= max
    && new Set(value).size === value.length
    && value.every((item) => typeof item === "string" && ID_PATTERN.test(item));
}
function assertId(value, code = "invalid_commit_input") {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw invariant(code);
}
function assertSafe(value, code = "invalid_commit_input") {
  if (!Number.isSafeInteger(value) || value < 0) throw invariant(code);
}
