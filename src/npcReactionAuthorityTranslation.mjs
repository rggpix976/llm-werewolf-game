import { ID_PATTERN, SCHEMA_VERSION, SHA256_PATTERN, enums } from "./conversation/domain.mjs";
import { canonicalJson, sha256CanonicalJson } from "./conversation/ids.mjs";
import {
  validateCanonicalClaim,
  validateConversationCommitResult,
  validateDisplayPublicationRecord,
  validateNpcReactionPlan,
  validatePublicEvent
} from "./conversation/validators.mjs";
import { validateCommittedConversationGraph } from "./conversation/references.mjs";
import { validateNpcAuthoritativeStateFoundation } from "./npcAuthoritativeStateFoundation.mjs";

export const NPC_REACTION_AUTHORITY_TRANSLATION_INVARIANT_CODES = Object.freeze([
  "invalid_npc_reaction_authority_translation_input",
  "invalid_npc_reaction_game_state",
  "invalid_npc_reaction_participant_projection",
  "invalid_npc_reaction_commit_projection",
  "invalid_npc_reaction_prepared_reaction",
  "invalid_npc_reaction_replacement_projection",
  "invalid_npc_reaction_authorized_delta",
  "npc_reaction_projection_identity_conflict",
  "npc_reaction_projection_prefix_mismatch",
  "npc_reaction_projection_forbidden_delta",
  "npc_reaction_projection_counter_mismatch",
  "npc_reaction_projection_fingerprint_mismatch",
  "npc_reaction_projection_alias_detected"
]);

const DEFAULT_CODE = "invalid_npc_reaction_authority_translation_input";
const ERROR_MESSAGE = "Invalid NPC reaction authority translation.";
const ZERO_FINGERPRINT = "0".repeat(64);
const PROJECTION_FIELDS = Object.freeze([
  "gameSessionId", "turnId", "turnOrder", "stateVersion", "phase", "players", "conversation"
]);
const CONVERSATION_ARRAY_FIELDS = Object.freeze([
  "inputRecords", "acceptedSpeechActs", "claims", "events", "displayPlans",
  "reactionPlans", "publications", "commitResults", "npcReactionCommitIdempotencyRecords"
]);
const CONVERSATION_COUNTER_FIELDS = Object.freeze([
  "nextCreatedOrder", "nextPublicationSlotOrder", "nextRecordAppendOrder"
]);
const CONVERSATION_FIELDS = Object.freeze([
  ...CONVERSATION_ARRAY_FIELDS, ...CONVERSATION_COUNTER_FIELDS
]);
const PARTICIPANT_FIELDS = Object.freeze([
  "participantId", "participantClass", "alive", "maySpeak"
]);
const PREPARED_FIELDS = Object.freeze([
  "schemaVersion", "preparationType", "delta", "preparationFingerprint"
]);
const DELTA_FIELDS = Object.freeze([
  "schemaVersion", "commitType", "resultMode", "binding", "preparationFingerprint",
  "requestFingerprint", "candidateFingerprint", "projectionFingerprint", "preconditionPhase",
  "resultingPhase", "preconditionStateVersion", "resultingStateVersion", "plan", "claims",
  "events", "publication", "effects", "artifactAllocation", "orderReservation",
  "expectedCommitResult", "idempotencyReservation"
]);
const BINDING_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "reactionPlanId", "successfulAttemptId", "requestId", "requestFingerprint",
  "correlationId", "causationId", "originatingInputRecordId", "turnId", "turnOrder",
  "preconditionPhase", "preconditionStateVersion", "npcId"
]);
const ARTIFACT_ALLOCATION_FIELDS = Object.freeze([
  "schemaVersion", "allocationType", "descriptorIds", "claimAllocations", "eventIds",
  "segmentIds", "publicationId"
]);
const ORDER_FIELDS = Object.freeze([
  "schemaVersion", "reservationType", "preconditionNextCreatedOrder", "eventCreatedOrders",
  "commitResultCreatedAtOrder", "resultingNextCreatedOrder",
  "preconditionNextPublicationSlotOrder", "publicationSlotOrder",
  "resultingNextPublicationSlotOrder", "preconditionNextRecordAppendOrder",
  "publicationRecordAppendOrder", "resultingNextRecordAppendOrder", "priorClaimCount",
  "priorEventCount"
]);
const IDEMPOTENCY_RESERVATION_FIELDS = Object.freeze([
  "schemaVersion", "requestId", "requestFingerprint", "reactionPlanId",
  "successfulAttemptId", "preparationFingerprint"
]);
const IDEMPOTENCY_RECORD_FIELDS = Object.freeze([
  "schemaVersion", "recordType", "gameSessionId", "reactionPlanId", "requestId",
  "requestFingerprint", "preparationFingerprint", "successfulAttemptId", "correlationId",
  "causationId", "originatingInputRecordId", "turnId", "turnOrder", "npcId",
  "preconditionStateVersion", "resultingStateVersion", "npcPublicationId",
  "commitResultRequestId"
]);
const TRANSLATOR_INPUT_FIELDS = Object.freeze([
  "currentProjection", "replacementProjection", "preparedReaction"
]);
const AUTHORIZED_DELTA_FIELDS = Object.freeze([
  "schemaVersion", "deltaType", "precondition", "resultingStateVersion", "appends", "counters"
]);
const PRECONDITION_FIELDS = Object.freeze([
  "gameSessionId", "turnId", "turnOrder", "stateVersion", "phase"
]);
const APPEND_FIELDS = Object.freeze([
  "reactionPlans", "claims", "events", "publications",
  "npcReactionCommitIdempotencyRecords", "commitResults"
]);

export class NpcReactionAuthorityTranslationInvariantError extends Error {
  constructor(code = DEFAULT_CODE) {
    super(ERROR_MESSAGE);
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "NpcReactionAuthorityTranslationInvariantError",
      writable: true
    });
    Object.defineProperty(this, "code", {
      configurable: false,
      enumerable: false,
      value: NPC_REACTION_AUTHORITY_TRANSLATION_INVARIANT_CODES.includes(code) ? code : DEFAULT_CODE,
      writable: false
    });
  }
}

export function buildNpcReactionCommitTransactionProjection(gameState) {
  try {
    validateNpcAuthoritativeStateFoundation(gameState);
  } catch {
    throw invariant("invalid_npc_reaction_game_state");
  }
  assertPlainObjectContainer(gameState, "invalid_npc_reaction_game_state");
  const gameSessionId = readRequired(gameState, "gameSessionId", "invalid_npc_reaction_game_state");
  const turnId = readRequired(gameState, "turnId", "invalid_npc_reaction_game_state");
  const turnOrder = readRequired(gameState, "turnOrder", "invalid_npc_reaction_game_state");
  const stateVersion = readRequired(gameState, "stateVersion", "invalid_npc_reaction_game_state");
  const phase = readRequired(gameState, "phase", "invalid_npc_reaction_game_state");
  const storedPlayers = readRequired(gameState, "players", "invalid_npc_reaction_game_state");
  const winner = readRequired(gameState, "winner", "invalid_npc_reaction_game_state");
  const conversation = readRequired(gameState, "conversation", "invalid_npc_reaction_game_state");
  assertId(gameSessionId, "invalid_npc_reaction_game_state");
  assertId(turnId, "invalid_npc_reaction_game_state");
  assertSafe(turnOrder, "invalid_npc_reaction_game_state");
  assertSafe(stateVersion, "invalid_npc_reaction_game_state");
  if (!enums.gamePhase.includes(phase) || ![null, "village", "werewolf"].includes(winner)) {
    throw invariant("invalid_npc_reaction_game_state");
  }
  if (!isDenseArray(storedPlayers) || storedPlayers.length < 1 || storedPlayers.length > 15) {
    throw invariant("invalid_npc_reaction_participant_projection");
  }

  const seen = new Set(["player"]);
  const players = [{
    participantId: "player",
    participantClass: "player",
    alive: true,
    maySpeak: winner === null
  }];
  for (const storedPlayer of storedPlayers) {
    assertStoredPlayer(storedPlayer);
    const participantId = readRequired(storedPlayer, "id", "invalid_npc_reaction_participant_projection");
    const alive = readRequired(storedPlayer, "alive", "invalid_npc_reaction_participant_projection");
    assertId(participantId, "invalid_npc_reaction_participant_projection");
    if (seen.has(participantId) || typeof alive !== "boolean") {
      throw invariant(seen.has(participantId)
        ? "npc_reaction_projection_identity_conflict"
        : "invalid_npc_reaction_participant_projection");
    }
    seen.add(participantId);
    players.push({
      participantId,
      participantClass: "npc",
      alive,
      maySpeak: alive && winner === null
    });
  }

  const projectedConversation = {};
  for (const field of CONVERSATION_FIELDS) {
    const value = readRequired(conversation, field, "invalid_npc_reaction_game_state");
    assertPlainData(value, "invalid_npc_reaction_game_state");
    projectedConversation[field] = clone(value, "invalid_npc_reaction_game_state");
  }
  const projection = {
    gameSessionId,
    turnId,
    turnOrder,
    stateVersion,
    phase,
    players,
    conversation: projectedConversation
  };
  validateProjectionInternal(projection, "invalid_npc_reaction_commit_projection", true);
  return deepFreeze(projection);
}

export function validateNpcReactionCommitTransactionProjection(value) {
  validateProjectionInternal(value, "invalid_npc_reaction_commit_projection", true);
}

export function translateNpcReactionCommitReplacementToAuthorizedDelta(input) {
  assertExactObject(input, TRANSLATOR_INPUT_FIELDS, "invalid_npc_reaction_authority_translation_input");
  const current = input.currentProjection;
  const replacement = input.replacementProjection;
  const prepared = input.preparedReaction;
  validateProjectionInternal(current, "invalid_npc_reaction_commit_projection", true);
  validateProjectionInternal(replacement, "invalid_npc_reaction_replacement_projection", false);
  assertProjectionNonAlias(current, replacement);
  validatePreparedReaction(prepared);

  const preparedDelta = prepared.delta;
  const binding = preparedDelta.binding;
  if (binding.gameSessionId !== current.gameSessionId
    || binding.turnId !== current.turnId
    || binding.turnOrder !== current.turnOrder
    || binding.preconditionPhase !== current.phase
    || binding.preconditionStateVersion !== current.stateVersion) {
    throw invariant("invalid_npc_reaction_prepared_reaction");
  }
  if (current.stateVersion === Number.MAX_SAFE_INTEGER
    || preparedDelta.resultingStateVersion !== current.stateVersion + 1
    || preparedDelta.resultingPhase !== current.phase) {
    throw invariant("npc_reaction_projection_counter_mismatch");
  }

  for (const field of ["gameSessionId", "turnId", "turnOrder", "phase"]) {
    assertCanonicalEqual(current[field], replacement[field], "npc_reaction_projection_forbidden_delta");
  }
  assertCanonicalEqual(current.players, replacement.players, "npc_reaction_projection_forbidden_delta");
  for (const field of ["inputRecords", "acceptedSpeechActs", "displayPlans"]) {
    assertCanonicalEqual(
      current.conversation[field], replacement.conversation[field],
      "npc_reaction_projection_forbidden_delta"
    );
  }

  const expectedAppends = {
    reactionPlans: [preparedDelta.plan],
    claims: preparedDelta.claims,
    events: preparedDelta.events,
    publications: [preparedDelta.publication],
    npcReactionCommitIdempotencyRecords: [buildIdempotencyRecord(prepared)],
    commitResults: [preparedDelta.expectedCommitResult]
  };
  for (const field of APPEND_FIELDS) {
    assertAppendOnly(
      current.conversation[field], replacement.conversation[field], expectedAppends[field]
    );
  }

  const order = preparedDelta.orderReservation;
  const currentConversation = current.conversation;
  const replacementConversation = replacement.conversation;
  if (order.preconditionNextCreatedOrder !== currentConversation.nextCreatedOrder
    || order.preconditionNextPublicationSlotOrder !== currentConversation.nextPublicationSlotOrder
    || order.preconditionNextRecordAppendOrder !== currentConversation.nextRecordAppendOrder
    || order.priorClaimCount !== currentConversation.claims.length
    || order.priorEventCount !== currentConversation.events.length
    || replacementConversation.nextCreatedOrder !== order.resultingNextCreatedOrder
    || replacementConversation.nextPublicationSlotOrder !== currentConversation.nextPublicationSlotOrder + 1
    || replacementConversation.nextPublicationSlotOrder !== order.resultingNextPublicationSlotOrder
    || replacementConversation.nextRecordAppendOrder !== currentConversation.nextRecordAppendOrder + 1
    || replacementConversation.nextRecordAppendOrder !== order.resultingNextRecordAppendOrder
    || replacement.stateVersion !== current.stateVersion + 1
    || replacement.stateVersion !== preparedDelta.resultingStateVersion) {
    throw invariant("npc_reaction_projection_counter_mismatch");
  }
  for (const value of [
    replacementConversation.nextCreatedOrder,
    replacementConversation.nextPublicationSlotOrder,
    replacementConversation.nextRecordAppendOrder,
    replacement.stateVersion
  ]) assertSafe(value, "npc_reaction_projection_counter_mismatch");

  validateProjectionCompleteGraph(replacement, "invalid_npc_reaction_replacement_projection");
  const delta = {
    schemaVersion: 1,
    deltaType: "npc_reaction_authorized_game_delta",
    precondition: {
      gameSessionId: current.gameSessionId,
      turnId: current.turnId,
      turnOrder: current.turnOrder,
      stateVersion: current.stateVersion,
      phase: current.phase
    },
    resultingStateVersion: replacement.stateVersion,
    appends: Object.fromEntries(APPEND_FIELDS.map((field) => [
      field,
      clone(replacement.conversation[field].slice(current.conversation[field].length),
        "invalid_npc_reaction_authorized_delta")
    ])),
    counters: {
      nextCreatedOrder: replacementConversation.nextCreatedOrder,
      nextPublicationSlotOrder: replacementConversation.nextPublicationSlotOrder,
      nextRecordAppendOrder: replacementConversation.nextRecordAppendOrder
    }
  };
  validateNpcReactionAuthorizedDelta(delta);
  assertNoAliasBetween(delta, [current, replacement, prepared]);
  return deepFreeze(delta);
}

export function validateNpcReactionAuthorizedDelta(value) {
  assertExactObject(value, AUTHORIZED_DELTA_FIELDS, "invalid_npc_reaction_authorized_delta");
  if (value.schemaVersion !== 1 || value.deltaType !== "npc_reaction_authorized_game_delta") {
    throw invariant("invalid_npc_reaction_authorized_delta");
  }
  assertExactObject(value.precondition, PRECONDITION_FIELDS, "invalid_npc_reaction_authorized_delta");
  assertId(value.precondition.gameSessionId, "invalid_npc_reaction_authorized_delta");
  assertId(value.precondition.turnId, "invalid_npc_reaction_authorized_delta");
  assertSafe(value.precondition.turnOrder, "invalid_npc_reaction_authorized_delta");
  assertSafe(value.precondition.stateVersion, "invalid_npc_reaction_authorized_delta");
  if (!enums.gamePhase.includes(value.precondition.phase)
    || value.precondition.stateVersion === Number.MAX_SAFE_INTEGER
    || value.resultingStateVersion !== value.precondition.stateVersion + 1) {
    throw invariant("invalid_npc_reaction_authorized_delta");
  }
  assertExactObject(value.appends, APPEND_FIELDS, "invalid_npc_reaction_authorized_delta");
  assertExactObject(value.counters, CONVERSATION_COUNTER_FIELDS, "invalid_npc_reaction_authorized_delta");
  for (const counter of CONVERSATION_COUNTER_FIELDS) {
    assertSafe(value.counters[counter], "invalid_npc_reaction_authorized_delta");
  }
  for (const field of APPEND_FIELDS) {
    if (!isDenseArray(value.appends[field])) throw invariant("invalid_npc_reaction_authorized_delta");
  }
  if (value.appends.reactionPlans.length !== 1
    || value.appends.claims.length > 4
    || value.appends.events.length < 1 || value.appends.events.length > 16
    || value.appends.publications.length !== 1
    || value.appends.npcReactionCommitIdempotencyRecords.length !== 1
    || value.appends.commitResults.length !== 1) {
    throw invariant("invalid_npc_reaction_authorized_delta");
  }
  assertPlainData(value, "invalid_npc_reaction_authorized_delta");
  assertNoDuplicateObjectReferences(value, "npc_reaction_projection_alias_detected");
  const plan = value.appends.reactionPlans[0];
  const publication = value.appends.publications[0];
  const record = value.appends.npcReactionCommitIdempotencyRecords[0];
  const result = value.appends.commitResults[0];
  try {
    validateNpcReactionPlan(plan);
    value.appends.claims.forEach(validateCanonicalClaim);
    value.appends.events.forEach(validatePublicEvent);
    validateDisplayPublicationRecord(publication);
    validateConversationCommitResult(result);
  } catch {
    throw invariant("invalid_npc_reaction_authorized_delta");
  }
  validateIdempotencyRecord(record, "invalid_npc_reaction_authorized_delta");
  if (plan.reactionPlanId !== record.reactionPlanId
    || plan.successfulAttemptId !== record.successfulAttemptId
    || plan.requestId !== record.requestId
    || plan.turnId !== record.turnId
    || plan.npcId !== record.npcId
    || plan.preconditionStateVersion !== record.preconditionStateVersion
    || plan.resultingStateVersion !== record.resultingStateVersion
    || publication.publicationId !== record.npcPublicationId
    || result.requestId !== record.commitResultRequestId
    || result.reactionPlanId !== record.reactionPlanId
    || result.npcPublicationId !== record.npcPublicationId
    || result.resultingStateVersion !== value.resultingStateVersion
    || record.resultingStateVersion !== value.resultingStateVersion
    || record.gameSessionId !== value.precondition.gameSessionId
    || record.turnId !== value.precondition.turnId
    || record.turnOrder !== value.precondition.turnOrder
    || record.preconditionStateVersion !== value.precondition.stateVersion) {
    throw invariant("invalid_npc_reaction_authorized_delta");
  }
}

function validateProjectionInternal(value, code, completeGraph) {
  assertExactObject(value, PROJECTION_FIELDS, code);
  assertId(value.gameSessionId, code);
  assertId(value.turnId, code);
  assertSafe(value.turnOrder, code);
  assertSafe(value.stateVersion, code);
  if (!enums.gamePhase.includes(value.phase)) throw invariant(code);
  validateParticipants(value.players, code);
  assertExactObject(value.conversation, CONVERSATION_FIELDS, code);
  const arrays = [];
  for (const field of CONVERSATION_ARRAY_FIELDS) {
    const array = value.conversation[field];
    if (!isDenseArray(array)) throw invariant(code);
    assertPlainData(array, code);
    arrays.push(array);
  }
  if (new Set(arrays).size !== arrays.length || arrays.includes(value.players)) {
    throw invariant("npc_reaction_projection_alias_detected");
  }
  for (const field of CONVERSATION_COUNTER_FIELDS) assertSafe(value.conversation[field], code);
  assertNoDuplicateObjectReferences(value, "npc_reaction_projection_alias_detected");
  validatePublicationCounters(value.conversation, code);
  if (completeGraph) validateProjectionCompleteGraph(value, code);
}

function validateProjectionCompleteGraph(value, code) {
  try { validateCommittedConversationGraph(value.conversation); }
  catch { throw invariant(code); }
}

function validateParticipants(players, code) {
  if (!isDenseArray(players) || players.length < 2 || players.length > 16) throw invariant(code);
  const ids = new Set();
  players.forEach((participant, index) => {
    assertExactObject(participant, PARTICIPANT_FIELDS, code);
    assertId(participant.participantId, code);
    if (typeof participant.alive !== "boolean" || typeof participant.maySpeak !== "boolean") throw invariant(code);
    if (index === 0) {
      if (participant.participantId !== "player" || participant.participantClass !== "player"
        || participant.alive !== true) throw invariant(code);
    } else if (participant.participantId === "player" || participant.participantClass !== "npc") {
      throw invariant(code);
    }
    if (ids.has(participant.participantId)) throw invariant("npc_reaction_projection_identity_conflict");
    ids.add(participant.participantId);
  });
}

function validatePreparedReaction(prepared) {
  assertExactObject(prepared, PREPARED_FIELDS, "invalid_npc_reaction_prepared_reaction");
  if (prepared.schemaVersion !== SCHEMA_VERSION
    || prepared.preparationType !== "canonical_npc_reaction"
    || !SHA256_PATTERN.test(prepared.preparationFingerprint)) {
    throw invariant("invalid_npc_reaction_prepared_reaction");
  }
  const delta = prepared.delta;
  assertExactObject(delta, DELTA_FIELDS, "invalid_npc_reaction_prepared_reaction");
  assertExactObject(delta.binding, BINDING_FIELDS, "invalid_npc_reaction_prepared_reaction");
  assertExactObject(delta.effects, [
    "suspicionScoreUpdates", "memoryUpdates", "legacyPublicHistoryEntries",
    "voteStateUpdates", "phaseTransitions"
  ], "invalid_npc_reaction_prepared_reaction");
  assertExactObject(delta.artifactAllocation, ARTIFACT_ALLOCATION_FIELDS, "invalid_npc_reaction_prepared_reaction");
  assertExactObject(delta.orderReservation, ORDER_FIELDS, "invalid_npc_reaction_prepared_reaction");
  assertExactObject(delta.idempotencyReservation, IDEMPOTENCY_RESERVATION_FIELDS, "invalid_npc_reaction_prepared_reaction");
  assertPlainData(prepared, "invalid_npc_reaction_prepared_reaction");
  if (delta.preparationFingerprint !== prepared.preparationFingerprint
    || delta.idempotencyReservation.preparationFingerprint !== prepared.preparationFingerprint) {
    throw invariant("npc_reaction_projection_fingerprint_mismatch");
  }
  if (delta.schemaVersion !== 1 || delta.commitType !== "npc_reaction" || delta.resultMode !== "canonical_only"
    || delta.requestFingerprint !== delta.binding.requestFingerprint
    || delta.idempotencyReservation.requestFingerprint !== delta.binding.requestFingerprint
    || delta.idempotencyReservation.requestId !== delta.binding.requestId
    || delta.idempotencyReservation.reactionPlanId !== delta.binding.reactionPlanId
    || delta.idempotencyReservation.successfulAttemptId !== delta.binding.successfulAttemptId
    || delta.preconditionPhase !== delta.binding.preconditionPhase
    || delta.resultingPhase !== delta.preconditionPhase
    || delta.preconditionStateVersion !== delta.binding.preconditionStateVersion
    || delta.resultingStateVersion !== delta.preconditionStateVersion + 1) {
    throw invariant("invalid_npc_reaction_prepared_reaction");
  }
  if (delta.binding.schemaVersion !== 1) throw invariant("invalid_npc_reaction_prepared_reaction");
  for (const field of BINDING_FIELDS.filter((field) => ![
    "schemaVersion", "requestFingerprint", "turnOrder", "preconditionPhase", "preconditionStateVersion"
  ].includes(field))) assertId(delta.binding[field], "invalid_npc_reaction_prepared_reaction");
  assertFingerprint(delta.binding.requestFingerprint, "invalid_npc_reaction_prepared_reaction");
  assertFingerprint(delta.candidateFingerprint, "invalid_npc_reaction_prepared_reaction");
  assertFingerprint(delta.projectionFingerprint, "invalid_npc_reaction_prepared_reaction");
  assertSafe(delta.binding.turnOrder, "invalid_npc_reaction_prepared_reaction");
  assertSafe(delta.binding.preconditionStateVersion, "invalid_npc_reaction_prepared_reaction");
  if (!enums.gamePhase.includes(delta.binding.preconditionPhase)) throw invariant("invalid_npc_reaction_prepared_reaction");
  if (!isDenseArray(delta.claims) || delta.claims.length > 4
    || !isDenseArray(delta.events) || delta.events.length < 1 || delta.events.length > 16) {
    throw invariant("invalid_npc_reaction_prepared_reaction");
  }
  try {
    validateNpcReactionPlan(delta.plan);
    delta.claims.forEach(validateCanonicalClaim);
    delta.events.forEach(validatePublicEvent);
    validateDisplayPublicationRecord(delta.publication);
    validateConversationCommitResult(delta.expectedCommitResult);
  } catch {
    throw invariant("invalid_npc_reaction_prepared_reaction");
  }
  if (delta.plan.reactionPlanId !== delta.binding.reactionPlanId
    || delta.plan.successfulAttemptId !== delta.binding.successfulAttemptId
    || delta.plan.requestId !== delta.binding.requestId
    || delta.plan.turnId !== delta.binding.turnId
    || delta.plan.npcId !== delta.binding.npcId
    || delta.plan.preconditionStateVersion !== delta.binding.preconditionStateVersion
    || delta.plan.resultingStateVersion !== delta.resultingStateVersion
    || delta.publication.publicationId !== delta.artifactAllocation.publicationId
    || delta.expectedCommitResult.reactionPlanId !== delta.binding.reactionPlanId
    || delta.expectedCommitResult.requestId !== delta.binding.requestId
    || delta.expectedCommitResult.npcPublicationId !== delta.publication.publicationId
    || delta.expectedCommitResult.resultingStateVersion !== delta.resultingStateVersion) {
    throw invariant("invalid_npc_reaction_prepared_reaction");
  }
  for (const field of Object.keys(delta.effects)) {
    if (!isDenseArray(delta.effects[field]) || delta.effects[field].length !== 0) {
      throw invariant("invalid_npc_reaction_prepared_reaction");
    }
  }
  for (const field of ORDER_FIELDS.filter((field) => !["reservationType"].includes(field))) {
    if (field === "eventCreatedOrders") {
      if (!isDenseArray(delta.orderReservation[field])) throw invariant("invalid_npc_reaction_prepared_reaction");
    } else if (field !== "schemaVersion") assertSafe(delta.orderReservation[field], "invalid_npc_reaction_prepared_reaction");
  }
  const hashInput = clone(delta, "invalid_npc_reaction_prepared_reaction");
  hashInput.preparationFingerprint = ZERO_FINGERPRINT;
  hashInput.idempotencyReservation.preparationFingerprint = ZERO_FINGERPRINT;
  if (sha256CanonicalJson(hashInput) !== prepared.preparationFingerprint) {
    throw invariant("npc_reaction_projection_fingerprint_mismatch");
  }
}

function buildIdempotencyRecord(prepared) {
  const delta = prepared.delta;
  const binding = delta.binding;
  return {
    schemaVersion: 1,
    recordType: "npc_reaction_commit_idempotency",
    gameSessionId: binding.gameSessionId,
    reactionPlanId: binding.reactionPlanId,
    requestId: binding.requestId,
    requestFingerprint: binding.requestFingerprint,
    preparationFingerprint: prepared.preparationFingerprint,
    successfulAttemptId: binding.successfulAttemptId,
    correlationId: binding.correlationId,
    causationId: binding.causationId,
    originatingInputRecordId: binding.originatingInputRecordId,
    turnId: binding.turnId,
    turnOrder: binding.turnOrder,
    npcId: binding.npcId,
    preconditionStateVersion: binding.preconditionStateVersion,
    resultingStateVersion: delta.resultingStateVersion,
    npcPublicationId: delta.publication.publicationId,
    commitResultRequestId: delta.expectedCommitResult.requestId
  };
}

function validateIdempotencyRecord(value, code) {
  assertExactObject(value, IDEMPOTENCY_RECORD_FIELDS, code);
  if (value.schemaVersion !== 1 || value.recordType !== "npc_reaction_commit_idempotency") throw invariant(code);
  for (const field of IDEMPOTENCY_RECORD_FIELDS.filter((field) => ![
    "schemaVersion", "recordType", "requestFingerprint", "preparationFingerprint",
    "turnOrder", "preconditionStateVersion", "resultingStateVersion"
  ].includes(field))) assertId(value[field], code);
  assertFingerprint(value.requestFingerprint, code);
  assertFingerprint(value.preparationFingerprint, code);
  assertSafe(value.turnOrder, code);
  assertSafe(value.preconditionStateVersion, code);
  if (value.resultingStateVersion !== value.preconditionStateVersion + 1) throw invariant(code);
}

function assertAppendOnly(current, replacement, expected) {
  if (replacement.length !== current.length + expected.length) {
    throw invariant("npc_reaction_projection_prefix_mismatch");
  }
  for (let index = 0; index < current.length; index += 1) {
    assertCanonicalEqual(current[index], replacement[index], "npc_reaction_projection_prefix_mismatch");
    if (current[index] === replacement[index]) throw invariant("npc_reaction_projection_alias_detected");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actual = replacement[current.length + index];
    assertCanonicalEqual(expected[index], actual, "npc_reaction_projection_forbidden_delta");
    if (actual === expected[index]) throw invariant("npc_reaction_projection_alias_detected");
  }
}

function assertProjectionNonAlias(current, replacement) {
  if (current === replacement || current.players === replacement.players
    || current.conversation === replacement.conversation) {
    throw invariant("npc_reaction_projection_alias_detected");
  }
  for (const field of CONVERSATION_ARRAY_FIELDS) {
    if (current.conversation[field] === replacement.conversation[field]) {
      throw invariant("npc_reaction_projection_alias_detected");
    }
  }
}

function assertNoAliasBetween(value, sources) {
  const sourceReferences = new WeakSet();
  sources.forEach((source) => collectReferences(source, sourceReferences));
  walkObjects(value, (object) => {
    if (sourceReferences.has(object)) throw invariant("npc_reaction_projection_alias_detected");
  });
}

function validatePublicationCounters(conversation, code) {
  if (conversation.nextRecordAppendOrder !== conversation.publications.length) throw invariant(code);
  conversation.publications.forEach((publication, index) => {
    if (publication.recordAppendOrder !== index) throw invariant(code);
  });
  const slots = conversation.publications.map((publication) => publication.publicationSlotOrder);
  const expected = slots.length === 0 ? 0 : Math.max(...slots) + 1;
  if (conversation.nextPublicationSlotOrder !== expected) throw invariant(code);
}

function assertStoredPlayer(value) {
  assertPlainObjectContainer(value, "invalid_npc_reaction_participant_projection");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw invariant("invalid_npc_reaction_participant_projection");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!isEnumerableDataDescriptor(descriptor)) throw invariant("invalid_npc_reaction_participant_projection");
  }
}

function assertExactObject(value, fields, code) {
  assertPlainObjectContainer(value, code);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    throw invariant(code);
  }
  for (const field of fields) {
    if (!isEnumerableDataDescriptor(Object.getOwnPropertyDescriptor(value, field))) throw invariant(code);
  }
}

function readRequired(value, field, code) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!isEnumerableDataDescriptor(descriptor)) throw invariant(code);
  return descriptor.value;
}

function assertPlainObjectContainer(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw invariant(code);
  }
}

function assertPlainData(value, code, stack = new Set()) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invariant(code);
    return;
  }
  if (typeof value !== "object" || stack.has(value)) throw invariant(code);
  stack.add(value);
  if (Array.isArray(value)) {
    if (!isDenseArray(value)) throw invariant(code);
    const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) throw invariant(code);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!isEnumerableDataDescriptor(descriptor)) throw invariant(code);
      assertPlainData(descriptor.value, code, stack);
    }
  } else {
    assertPlainObjectContainer(value, code);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw invariant(code);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isEnumerableDataDescriptor(descriptor)) throw invariant(code);
      assertPlainData(descriptor.value, code, stack);
    }
  }
  stack.delete(value);
}

function assertNoDuplicateObjectReferences(value, code) {
  const seen = new WeakSet();
  walkObjects(value, (object) => {
    if (seen.has(object)) throw invariant(code);
    seen.add(object);
  });
}

function collectReferences(value, output) {
  walkObjects(value, (object) => output.add(object));
}

function walkObjects(value, visit, stack = new Set()) {
  if (value === null || typeof value !== "object") return;
  if (stack.has(value)) throw invariant("npc_reaction_projection_alias_detected");
  visit(value);
  stack.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit, stack);
  } else {
    for (const key of Object.keys(value)) walkObjects(value[key], visit, stack);
  }
  stack.delete(value);
}

function assertCanonicalEqual(left, right, code) {
  try {
    if (canonicalJson(left) !== canonicalJson(right)) throw invariant(code);
  } catch (error) {
    if (error instanceof NpcReactionAuthorityTranslationInvariantError) throw error;
    throw invariant(code);
  }
}

function clone(value, code) {
  try { return structuredClone(value); }
  catch { throw invariant(code); }
}

function deepFreeze(value, stack = new Set()) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (stack.has(value)) throw invariant("npc_reaction_projection_alias_detected");
  stack.add(value);
  for (const child of Object.values(value)) deepFreeze(child, stack);
  stack.delete(value);
  return Object.freeze(value);
}

function isDenseArray(value) {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false;
  return true;
}

function isEnumerableDataDescriptor(descriptor) {
  return descriptor !== undefined && descriptor.enumerable === true && Object.hasOwn(descriptor, "value");
}

function assertId(value, code) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw invariant(code);
}

function assertFingerprint(value, code) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw invariant(code);
}

function assertSafe(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw invariant(code);
}

function invariant(code) {
  return new NpcReactionAuthorityTranslationInvariantError(code);
}
