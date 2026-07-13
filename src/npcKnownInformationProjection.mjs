import { ID_PATTERN, SCHEMA_VERSION, enums } from "./conversation/domain.mjs";

const EVENT_PROJECTION_TYPES = Object.freeze({
  public_statement_recorded: "public_statement_event",
  public_question_recorded: "public_question_event",
  suspicion_expressed: "suspicion_event",
  vote_declared: "vote_event",
  role_claim_recorded: "role_claim_event",
  result_claim_recorded: "result_claim_event"
});

const CANONICAL_CANDIDATE_KINDS = Object.freeze(["role_claim", "result_claim", "vote_declaration", "suspicion"]);
const MAX = Object.freeze({ participants: 16, events: 64, claims: 64, votes: 32, results: 16, suspicion: 16 });

export function buildNpcKnownInformationProjection(actorId, triggerId, snapshot) {
  assertId(actorId, "actorId");
  assertId(triggerId, "triggerId");
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw projectionError("invalid_authoritative_state");
  if (!Number.isSafeInteger(snapshot.stateVersion) || snapshot.stateVersion < 0 || !Number.isSafeInteger(snapshot.turnOrder) || snapshot.turnOrder < 0) throw projectionError("invalid_authoritative_state");
  if (snapshot.phase !== "player_question") throw projectionError("unsupported_projection_phase");

  const actor = uniqueBy(snapshot.players, "id", actorId, "actor_not_found");
  if (!actor.alive || !snapshot.alivePlayers?.includes(actorId)) throw projectionError("actor_not_eligible");

  const result = uniqueBy(snapshot.conversation?.commitResults, "requestId", triggerId, "trigger_not_found");
  if (result.commitType !== "player_conversation" || result.resultingStateVersion !== snapshot.stateVersion) throw projectionError("stale_reaction_trigger");
  const input = uniqueBy(snapshot.conversation?.inputRecords, "inputRecordId", result.inputRecordId, "trigger_input_not_found");
  if (input.requestId !== result.requestId || input.correlationId !== result.correlationId || input.turnId !== snapshot.turnId || input.actorId !== "player" || result.preconditionStateVersion !== input.capturedStateVersion || result.resultingStateVersion !== input.capturedStateVersion + 1) throw projectionError("stale_reaction_trigger");

  const npcParticipants = bounded(snapshot.players, MAX.participants - 1, "projection_participant_limit").map((player) => ({
    participantId: checkedId(player.id, "participantId"),
    displayName: checkedString(player.name, 1, 80, "displayName"),
    publicStatus: player.alive ? "alive" : "dead"
  }));
  const participants = [{ participantId: "player", displayName: "Player", publicStatus: "alive" }, ...npcParticipants];

  const claims = bounded(snapshot.conversation.claims, MAX.claims, "projection_claim_limit").map(projectClaim);
  const events = bounded(snapshot.conversation.events, MAX.events, "projection_event_limit").map(projectEvent);
  const allowedReferenceIds = [...events.map((event) => event.eventId), ...claims.map((claim) => claim.claimId), input.inputRecordId];
  assertUnique(allowedReferenceIds, "duplicate_public_reference");

  const investigationResults = bounded(
    actor.knownInfo.filter((fact) => fact?.type === "seer_result"),
    MAX.results,
    "projection_result_limit"
  ).map((fact) => ({
    day: checkedSafeInteger(fact.day, "investigationDay"),
    targetId: checkedParticipantId(fact.targetId, participants, "investigationTargetId"),
    result: checkedEnum(fact.result, enums.claimResult, "investigationResult"),
    disclosurePolicy: "engine_policy_required"
  }));

  const voteHistory = bounded(actor.voteHistory, MAX.votes, "projection_vote_limit").map((vote) => ({
    day: checkedSafeInteger(vote.day, "voteDay"),
    targetId: checkedParticipantId(vote.targetId, participants, "voteTargetId")
  }));

  const suspicionScores = Object.entries(actor.suspicionScores ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([targetId, score]) => ({
    targetId: checkedParticipantId(targetId, participants, "suspicionTargetId"),
    score: checkedFiniteNumber(score, "suspicionScore")
  }));
  if (suspicionScores.length > MAX.suspicion) throw projectionError("projection_suspicion_limit");

  const allowedTargetIds = participants.filter((participant) => participant.participantId !== actorId && participant.participantId !== "player").map((participant) => participant.participantId);
  const allowedLivingTargetIds = participants.filter((participant) => participant.participantId !== actorId && participant.participantId !== "player" && participant.publicStatus === "alive").map((participant) => participant.participantId);
  const allowedResultTargetIds = [...new Set(investigationResults.map((resultEntry) => resultEntry.targetId))];
  const canDiscloseResults = actor.role === "seer" && allowedResultTargetIds.length > 0;

  const projection = {
    schemaVersion: SCHEMA_VERSION,
    projectionType: "npc_known_information",
    trigger: {
      requestId: result.requestId,
      inputRecordId: input.inputRecordId,
      turnId: input.turnId,
      stateVersion: snapshot.stateVersion,
      phase: snapshot.phase,
      rawText: checkedString(input.rawText, 1, 2000, "triggerRawText")
    },
    public: {
      day: checkedSafeInteger(snapshot.day, "day"),
      phase: checkedEnum(snapshot.phase, enums.gamePhase, "phase"),
      participants,
      events,
      claims
    },
    actorPrivate: {
      actorId,
      ownRole: checkedEnum(actor.role, enums.gameRole, "ownRole"),
      ownTeam: checkedEnum(actor.team, ["village", "werewolf"], "ownTeam"),
      investigationResults,
      voteHistory,
      suspicionScores
    },
    constraints: {
      allowedTargetIds,
      allowedLivingTargetIds,
      allowedResultTargetIds,
      allowedCandidateKinds: CANONICAL_CANDIDATE_KINDS,
      allowedClaimRoles: canDiscloseResults ? ["seer"] : [],
      allowedResultValues: canDiscloseResults ? [...new Set(investigationResults.map((entry) => entry.result))] : [],
      allowedReferenceIds,
      roleDisclosurePolicy: checkedString(actor.conversationPolicy?.roleClaim, 1, 64, "roleDisclosurePolicy")
    },
    presentation: {
      speechStyleId: checkedString(actor.speechStyle, 1, 32, "speechStyleId")
    }
  };

  validateNpcKnownInformationProjection(projection);
  return deepFreeze(structuredClone(projection));
}

export function validateNpcKnownInformationProjection(value) {
  exact(value, ["schemaVersion", "projectionType", "trigger", "public", "actorPrivate", "constraints", "presentation"], "invalid_projection");
  if (value.schemaVersion !== SCHEMA_VERSION || value.projectionType !== "npc_known_information") throw projectionError("invalid_projection");
  exact(value.trigger, ["requestId", "inputRecordId", "turnId", "stateVersion", "phase", "rawText"], "invalid_projection");
  exact(value.public, ["day", "phase", "participants", "events", "claims"], "invalid_projection");
  exact(value.actorPrivate, ["actorId", "ownRole", "ownTeam", "investigationResults", "voteHistory", "suspicionScores"], "invalid_projection");
  exact(value.constraints, ["allowedTargetIds", "allowedLivingTargetIds", "allowedResultTargetIds", "allowedCandidateKinds", "allowedClaimRoles", "allowedResultValues", "allowedReferenceIds", "roleDisclosurePolicy"], "invalid_projection");
  exact(value.presentation, ["speechStyleId"], "invalid_projection");

  for (const key of ["requestId", "inputRecordId", "turnId"]) assertId(value.trigger[key], key);
  checkedSafeInteger(value.trigger.stateVersion, "triggerStateVersion");
  checkedEnum(value.trigger.phase, enums.gamePhase, "triggerPhase");
  checkedString(value.trigger.rawText, 1, 2000, "triggerRawText");
  checkedSafeInteger(value.public.day, "day");
  checkedEnum(value.public.phase, enums.gamePhase, "phase");
  if (value.public.phase !== value.trigger.phase) throw projectionError("projection_phase_mismatch");

  bounded(value.public.participants, MAX.participants, "projection_participant_limit").forEach((entry) => {
    exact(entry, ["participantId", "displayName", "publicStatus"], "invalid_projection");
    assertId(entry.participantId, "participantId");
    checkedString(entry.displayName, 1, 80, "displayName");
    checkedEnum(entry.publicStatus, ["alive", "dead"], "publicStatus");
  });
  assertUnique(value.public.participants.map((entry) => entry.participantId), "duplicate_participant");
  const participantIds = new Set(value.public.participants.map((entry) => entry.participantId));
  if (!participantIds.has(value.actorPrivate.actorId)) throw projectionError("actor_not_in_public_participants");

  bounded(value.public.events, MAX.events, "projection_event_limit").forEach(validateEventProjection);
  bounded(value.public.claims, MAX.claims, "projection_claim_limit").forEach(validateClaimProjection);
  assertUnique(value.public.events.map((entry) => entry.eventId), "duplicate_public_event");
  assertUnique(value.public.claims.map((entry) => entry.claimId), "duplicate_public_claim");
  for (const entry of [...value.public.events, ...value.public.claims]) {
    if (!participantIds.has(entry.actorId) || (entry.targetId !== undefined && !participantIds.has(entry.targetId))) throw projectionError("unknown_public_participant");
  }
  const claimsById = new Map(value.public.claims.map((entry) => [entry.claimId, entry]));
  for (const event of value.public.events.filter((entry) => entry.claimId !== undefined)) {
    const claim = claimsById.get(event.claimId);
    const expectedType = event.projectionType === "role_claim_event" ? "role_claim" : "result_claim";
    if (!claim || claim.projectionType !== expectedType || claim.actorId !== event.actorId) throw projectionError("invalid_public_claim_reference");
  }

  assertId(value.actorPrivate.actorId, "actorId");
  checkedEnum(value.actorPrivate.ownRole, enums.gameRole, "ownRole");
  checkedEnum(value.actorPrivate.ownTeam, ["village", "werewolf"], "ownTeam");
  bounded(value.actorPrivate.investigationResults, MAX.results, "projection_result_limit").forEach((entry) => {
    exact(entry, ["day", "targetId", "result", "disclosurePolicy"], "invalid_projection");
    checkedSafeInteger(entry.day, "investigationDay");
    if (!participantIds.has(entry.targetId)) throw projectionError("invalid_investigationTargetId");
    checkedEnum(entry.result, enums.claimResult, "investigationResult");
    if (entry.disclosurePolicy !== "engine_policy_required") throw projectionError("invalid_disclosure_policy");
  });
  bounded(value.actorPrivate.voteHistory, MAX.votes, "projection_vote_limit").forEach((entry) => {
    exact(entry, ["day", "targetId"], "invalid_projection");
    checkedSafeInteger(entry.day, "voteDay");
    if (!participantIds.has(entry.targetId)) throw projectionError("invalid_voteTargetId");
  });
  bounded(value.actorPrivate.suspicionScores, MAX.suspicion, "projection_suspicion_limit").forEach((entry) => {
    exact(entry, ["targetId", "score"], "invalid_projection");
    if (!participantIds.has(entry.targetId)) throw projectionError("invalid_suspicionTargetId");
    checkedFiniteNumber(entry.score, "suspicionScore");
  });
  assertUnique(value.actorPrivate.investigationResults.map((entry) => `${entry.targetId}:${entry.day}`), "duplicate_investigation_result");
  assertUnique(value.actorPrivate.suspicionScores.map((entry) => entry.targetId), "duplicate_suspicion_target");

  validateIdList(value.constraints.allowedTargetIds, MAX.participants, "allowedTargetIds");
  validateIdList(value.constraints.allowedLivingTargetIds, MAX.participants, "allowedLivingTargetIds");
  validateIdList(value.constraints.allowedResultTargetIds, MAX.participants, "allowedResultTargetIds");
  validateIdList(value.constraints.allowedReferenceIds, MAX.events + MAX.claims + 1, "allowedReferenceIds");
  for (const id of [...value.constraints.allowedTargetIds, ...value.constraints.allowedLivingTargetIds, ...value.constraints.allowedResultTargetIds]) if (!participantIds.has(id)) throw projectionError("unknown_allowed_target");
  for (const id of value.constraints.allowedLivingTargetIds) if (!value.constraints.allowedTargetIds.includes(id)) throw projectionError("invalid_living_target_subset");
  for (const id of value.constraints.allowedResultTargetIds) if (!value.constraints.allowedTargetIds.includes(id)) throw projectionError("invalid_result_target_subset");
  const referenceIds = new Set([...value.public.events.map((entry) => entry.eventId), ...value.public.claims.map((entry) => entry.claimId), value.trigger.inputRecordId]);
  if (value.constraints.allowedReferenceIds.some((id) => !referenceIds.has(id))) throw projectionError("unknown_public_reference");
  validateEnumList(value.constraints.allowedCandidateKinds, CANONICAL_CANDIDATE_KINDS, "allowedCandidateKinds");
  validateEnumList(value.constraints.allowedClaimRoles, enums.claimableRole, "allowedClaimRoles");
  validateEnumList(value.constraints.allowedResultValues, enums.claimResult, "allowedResultValues");
  checkedString(value.constraints.roleDisclosurePolicy, 1, 64, "roleDisclosurePolicy");
  checkedString(value.presentation.speechStyleId, 1, 32, "speechStyleId");
  return value;
}

function validateEventProjection(event) {
  const fields = {
    public_statement_event: [],
    public_question_event: ["targetId", "topic"],
    suspicion_event: ["targetId"],
    vote_event: ["targetId"],
    role_claim_event: ["claimId"],
    result_claim_event: ["claimId"]
  }[event?.projectionType];
  if (!fields) throw projectionError("invalid_public_event_type");
  exact(event, ["schemaVersion", "projectionType", "eventId", "actorId", "turnId", "occurredPhase", ...fields], "invalid_projection");
  if (event.schemaVersion !== SCHEMA_VERSION) throw projectionError("unsupported_projection_schema");
  for (const key of ["eventId", "actorId", "turnId", "targetId", "claimId"].filter((key) => Object.hasOwn(event, key))) assertId(event[key], key);
  checkedEnum(event.occurredPhase, enums.gamePhase, "eventPhase");
  if (event.topic !== undefined) checkedEnum(event.topic, enums.questionTopic, "eventTopic");
}

function validateClaimProjection(claim) {
  const fields = claim?.projectionType === "role_claim" ? ["claimedRole"] : claim?.projectionType === "result_claim" ? ["targetId", "result"] : null;
  if (!fields) throw projectionError("invalid_public_claim_type");
  exact(claim, ["schemaVersion", "projectionType", "claimId", "actorId", ...fields], "invalid_projection");
  if (claim.schemaVersion !== SCHEMA_VERSION) throw projectionError("unsupported_projection_schema");
  assertId(claim.claimId, "claimId");
  assertId(claim.actorId, "claimActorId");
  if (claim.targetId !== undefined) assertId(claim.targetId, "claimTargetId");
  if (claim.claimedRole !== undefined) checkedEnum(claim.claimedRole, enums.claimableRole, "claimedRole");
  if (claim.result !== undefined) checkedEnum(claim.result, enums.claimResult, "claimResult");
}

function validateIdList(values, maximum, name) {
  bounded(values, maximum, `invalid_${name}`);
  values.forEach((value) => assertId(value, name));
  assertUnique(values, `duplicate_${name}`);
}

function validateEnumList(values, allowed, name) {
  if (!Array.isArray(values) || values.length > allowed.length) throw projectionError(`invalid_${name}`);
  values.forEach((value) => checkedEnum(value, allowed, name));
  assertUnique(values, `duplicate_${name}`);
}

function projectEvent(event) {
  const projectionType = EVENT_PROJECTION_TYPES[event.eventType];
  if (!projectionType) throw projectionError("unsupported_public_event");
  const projection = {
    schemaVersion: SCHEMA_VERSION,
    projectionType,
    eventId: checkedId(event.eventId, "eventId"),
    actorId: checkedId(event.actorId, "eventActorId"),
    turnId: checkedId(event.turnId, "eventTurnId"),
    occurredPhase: checkedEnum(event.occurredPhase, enums.gamePhase, "eventPhase")
  };
  if (event.targetId !== undefined) projection.targetId = checkedId(event.targetId, "eventTargetId");
  if (event.topic !== undefined) projection.topic = checkedEnum(event.topic, enums.questionTopic, "eventTopic");
  if (event.claimId !== undefined) projection.claimId = checkedId(event.claimId, "eventClaimId");
  return projection;
}

function projectClaim(claim) {
  const projection = {
    schemaVersion: SCHEMA_VERSION,
    projectionType: checkedEnum(claim.type, ["role_claim", "result_claim"], "claimType"),
    claimId: checkedId(claim.claimId, "claimId"),
    actorId: checkedId(claim.actorId, "claimActorId")
  };
  if (claim.type === "role_claim") projection.claimedRole = checkedEnum(claim.claimedRole, enums.claimableRole, "claimedRole");
  else {
    projection.targetId = checkedId(claim.targetId, "claimTargetId");
    projection.result = checkedEnum(claim.result, enums.claimResult, "claimResult");
  }
  return projection;
}

function uniqueBy(values, key, identity, code) {
  if (!Array.isArray(values)) throw projectionError("invalid_authoritative_state");
  const matches = values.filter((value) => value?.[key] === identity);
  if (matches.length !== 1) throw projectionError(code);
  return matches[0];
}

function bounded(values, maximum, code) {
  if (!Array.isArray(values)) throw projectionError("invalid_authoritative_state");
  if (values.length > maximum) throw projectionError(code);
  return values;
}

function exact(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw projectionError(code);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) || actual.some((key) => !keys.includes(key))) throw projectionError(code);
}

function checkedId(value, name) { assertId(value, name); return value; }
function assertId(value, name) { if (typeof value !== "string" || !ID_PATTERN.test(value)) throw projectionError(`invalid_${name}`); }
function checkedSafeInteger(value, name) { if (!Number.isSafeInteger(value) || value < 0) throw projectionError(`invalid_${name}`); return value; }
function checkedFiniteNumber(value, name) { if (typeof value !== "number" || !Number.isFinite(value)) throw projectionError(`invalid_${name}`); return value; }
function checkedString(value, minimum, maximum, name) { if (typeof value !== "string" || [...value].length < minimum || [...value].length > maximum) throw projectionError(`invalid_${name}`); return value; }
function checkedEnum(value, values, name) { if (!values.includes(value)) throw projectionError(`invalid_${name}`); return value; }
function checkedParticipantId(value, participants, name) { assertId(value, name); if (!participants.some((entry) => entry.participantId === value)) throw projectionError(`invalid_${name}`); return value; }
function assertUnique(values, code) { if (new Set(values).size !== values.length) throw projectionError(code); }

function projectionError(code) {
  const error = new Error(code);
  error.name = "NpcKnownInformationProjectionError";
  error.code = code;
  return error;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  return value;
}
