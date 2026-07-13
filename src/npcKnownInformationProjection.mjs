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
const MAX = Object.freeze({ participants: 16, events: 64, claims: 64, votes: 32, executions: 16, attackDeaths: 16, results: 16, suspicion: 16 });

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
  const publication = uniqueBy(snapshot.conversation?.publications, "publicationId", result.playerPublicationId, "trigger_publication_not_found");
  if (publication.recordType !== "player_utterance_published" || publication.requestId !== result.requestId || publication.correlationId !== result.correlationId || publication.inputRecordId !== input.inputRecordId || publication.turnId !== input.turnId || publication.actorId !== input.actorId || publication.gameStateVersion !== result.resultingStateVersion) throw projectionError("stale_reaction_trigger");

  const npcParticipants = bounded(snapshot.players, MAX.participants - 1, "projection_participant_limit").map((player) => ({
    participantId: checkedId(player.id, "participantId"),
    displayName: checkedString(player.name, 1, 80, "displayName"),
    publicStatus: player.alive ? "alive" : "dead"
  })).sort(compareBy("participantId"));
  const participants = [{ participantId: "player", displayName: "Player", publicStatus: "alive" }, ...npcParticipants].sort(compareBy("participantId"));

  const claimSources = bounded(snapshot.conversation.claims, MAX.claims, "projection_claim_limit").map((claim) => ({
    claim,
    order: checkedSafeInteger(claim?.createdStateVersion, "claimCreatedStateVersion"),
    id: checkedId(claim?.claimId, "claimId")
  })).sort(compareOrderedSource);
  const eventSources = bounded(snapshot.conversation.events, MAX.events, "projection_event_limit").map((event) => ({
    event,
    order: checkedSafeInteger(event?.createdOrder, "eventCreatedOrder"),
    id: checkedId(event?.eventId, "eventId")
  })).sort(compareOrderedSource);
  assertUnique(eventSources.map(({ order }) => order), "duplicate_public_event_order");
  const claims = claimSources.map(({ claim }) => projectClaim(claim));
  const events = eventSources.map(({ event }) => projectEvent(event));
  const votes = bounded(
    eventSources.filter(({ event }) => event.eventType === "vote_declared"),
    MAX.votes,
    "projection_public_vote_limit"
  ).map(({ event }) => projectVote(event));
  // The current engine has no public execution or attack-death collection with
  // authoritative structured IDs. Legacy prose and vote/death state are not sources.
  const executions = [];
  const attackDeaths = [];
  const triggeringInput = {
    schemaVersion: SCHEMA_VERSION,
    inputRecordId: checkedId(input.inputRecordId, "inputRecordId"),
    requestId: checkedId(input.requestId, "requestId"),
    correlationId: checkedId(input.correlationId, "correlationId"),
    turnId: checkedId(input.turnId, "turnId"),
    capturedStateVersion: checkedSafeInteger(input.capturedStateVersion, "capturedStateVersion"),
    actorId: checkedId(input.actorId, "triggerActorId"),
    rawText: checkedString(input.rawText, 1, 2000, "triggerRawText"),
    locale: checkedEnum(input.locale, enums.supportedLocale, "triggerLocale")
  };
  const allowedReferenceIds = [...new Set([
    ...events.map((event) => event.eventId),
    ...claims.map((claim) => claim.claimId),
    ...votes.map((vote) => vote.voteEventId),
    ...executions.map((execution) => execution.executionEventId),
    ...attackDeaths.map((death) => death.attackEventId),
    triggeringInput.inputRecordId
  ])];

  const investigationResults = bounded(
    actor.knownInfo.filter((fact) => fact?.type === "seer_result"),
    MAX.results,
    "projection_result_limit"
  ).map((fact) => ({
    day: checkedSafeInteger(fact.day, "investigationDay"),
    targetId: checkedParticipantId(fact.targetId, participants, "investigationTargetId"),
    result: checkedEnum(fact.result, enums.claimResult, "investigationResult"),
    disclosurePolicy: "engine_policy_required"
  })).sort(compareDayAndTarget);

  const voteHistory = bounded(actor.voteHistory, MAX.votes, "projection_vote_limit").map((vote) => ({
    day: checkedSafeInteger(vote.day, "voteDay"),
    targetId: checkedParticipantId(vote.targetId, participants, "voteTargetId")
  })).sort(compareDayAndTarget);

  const suspicionScores = Object.entries(actor.suspicionScores ?? {}).sort(([left], [right]) => compareText(left, right)).map(([targetId, score]) => ({
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
    public: {
      day: checkedSafeInteger(snapshot.day, "day"),
      phase: checkedEnum(snapshot.phase, enums.gamePhase, "phase"),
      participants,
      events,
      claims,
      votes,
      executions,
      attackDeaths,
      triggeringInput
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
  exact(value, ["schemaVersion", "projectionType", "public", "actorPrivate", "constraints", "presentation"], "invalid_projection");
  if (value.schemaVersion !== SCHEMA_VERSION || value.projectionType !== "npc_known_information") throw projectionError("invalid_projection");
  exact(value.public, ["day", "phase", "participants", "events", "claims", "votes", "executions", "attackDeaths", "triggeringInput"], "invalid_projection");
  exact(value.actorPrivate, ["actorId", "ownRole", "ownTeam", "investigationResults", "voteHistory", "suspicionScores"], "invalid_projection");
  exact(value.constraints, ["allowedTargetIds", "allowedLivingTargetIds", "allowedResultTargetIds", "allowedCandidateKinds", "allowedClaimRoles", "allowedResultValues", "allowedReferenceIds", "roleDisclosurePolicy"], "invalid_projection");
  exact(value.presentation, ["speechStyleId"], "invalid_projection");

  const triggeringInput = value.public.triggeringInput;
  exact(triggeringInput, ["schemaVersion", "inputRecordId", "requestId", "correlationId", "turnId", "capturedStateVersion", "actorId", "rawText", "locale"], "invalid_projection");
  if (triggeringInput.schemaVersion !== SCHEMA_VERSION) throw projectionError("unsupported_projection_schema");
  for (const key of ["inputRecordId", "requestId", "correlationId", "turnId", "actorId"]) assertId(triggeringInput[key], key);
  checkedSafeInteger(triggeringInput.capturedStateVersion, "capturedStateVersion");
  checkedString(triggeringInput.rawText, 1, 2000, "triggerRawText");
  checkedEnum(triggeringInput.locale, enums.supportedLocale, "triggerLocale");
  checkedSafeInteger(value.public.day, "day");
  checkedEnum(value.public.phase, enums.gamePhase, "phase");

  bounded(value.public.participants, MAX.participants, "projection_participant_limit").forEach((entry) => {
    exact(entry, ["participantId", "displayName", "publicStatus"], "invalid_projection");
    assertId(entry.participantId, "participantId");
    checkedString(entry.displayName, 1, 80, "displayName");
    checkedEnum(entry.publicStatus, ["alive", "dead"], "publicStatus");
  });
  assertUnique(value.public.participants.map((entry) => entry.participantId), "duplicate_participant");
  const participantIds = new Set(value.public.participants.map((entry) => entry.participantId));
  if (!participantIds.has(value.actorPrivate.actorId)) throw projectionError("actor_not_in_public_participants");
  if (!participantIds.has(triggeringInput.actorId) || triggeringInput.actorId !== "player") throw projectionError("invalid_trigger_actor");

  bounded(value.public.events, MAX.events, "projection_event_limit").forEach(validateEventProjection);
  bounded(value.public.claims, MAX.claims, "projection_claim_limit").forEach(validateClaimProjection);
  bounded(value.public.votes, MAX.votes, "projection_public_vote_limit").forEach(validateVoteProjection);
  bounded(value.public.executions, MAX.executions, "projection_execution_limit").forEach(validateExecutionProjection);
  bounded(value.public.attackDeaths, MAX.attackDeaths, "projection_attack_death_limit").forEach(validateAttackDeathProjection);
  assertUnique(value.public.events.map((entry) => entry.eventId), "duplicate_public_event");
  assertUnique(value.public.claims.map((entry) => entry.claimId), "duplicate_public_claim");
  assertUnique(value.public.votes.map((entry) => entry.voteEventId), "duplicate_public_vote");
  assertUnique(value.public.executions.map((entry) => entry.executionEventId), "duplicate_public_execution");
  assertUnique(value.public.attackDeaths.map((entry) => entry.attackEventId), "duplicate_public_attack_death");
  for (const entry of [...value.public.events, ...value.public.claims, ...value.public.votes]) {
    if (!participantIds.has(entry.actorId) || (entry.targetId !== undefined && !participantIds.has(entry.targetId))) throw projectionError("unknown_public_participant");
  }
  for (const entry of value.public.executions) if (!participantIds.has(entry.executedPlayerId)) throw projectionError("unknown_public_participant");
  for (const entry of value.public.attackDeaths) if (!participantIds.has(entry.attackedPlayerId)) throw projectionError("unknown_public_participant");
  const claimsById = new Map(value.public.claims.map((entry) => [entry.claimId, entry]));
  for (const event of value.public.events.filter((entry) => entry.claimId !== undefined)) {
    const claim = claimsById.get(event.claimId);
    const expectedType = event.projectionType === "role_claim_event" ? "role_claim" : "result_claim";
    if (!claim || claim.projectionType !== expectedType || claim.actorId !== event.actorId) throw projectionError("invalid_public_claim_reference");
  }
  const voteEventsById = new Map(value.public.events.filter((entry) => entry.projectionType === "vote_event").map((entry) => [entry.eventId, entry]));
  if (voteEventsById.size !== value.public.votes.length) throw projectionError("invalid_public_vote_reference");
  for (const vote of value.public.votes) {
    const event = voteEventsById.get(vote.voteEventId);
    if (!event || event.actorId !== vote.actorId || event.targetId !== vote.targetId || event.turnId !== vote.turnId || event.occurredPhase !== vote.occurredPhase) throw projectionError("invalid_public_vote_reference");
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
  validateIdList(value.constraints.allowedReferenceIds, MAX.events + MAX.claims + MAX.executions + MAX.attackDeaths + 1, "allowedReferenceIds");
  for (const id of [...value.constraints.allowedTargetIds, ...value.constraints.allowedLivingTargetIds, ...value.constraints.allowedResultTargetIds]) if (!participantIds.has(id)) throw projectionError("unknown_allowed_target");
  for (const id of value.constraints.allowedLivingTargetIds) if (!value.constraints.allowedTargetIds.includes(id)) throw projectionError("invalid_living_target_subset");
  for (const id of value.constraints.allowedResultTargetIds) if (!value.constraints.allowedTargetIds.includes(id)) throw projectionError("invalid_result_target_subset");
  const referenceIds = new Set([
    ...value.public.events.map((entry) => entry.eventId),
    ...value.public.claims.map((entry) => entry.claimId),
    ...value.public.votes.map((entry) => entry.voteEventId),
    ...value.public.executions.map((entry) => entry.executionEventId),
    ...value.public.attackDeaths.map((entry) => entry.attackEventId),
    triggeringInput.inputRecordId
  ]);
  if (value.constraints.allowedReferenceIds.length !== referenceIds.size || value.constraints.allowedReferenceIds.some((id) => !referenceIds.has(id))) throw projectionError("unknown_public_reference");
  validateEnumList(value.constraints.allowedCandidateKinds, CANONICAL_CANDIDATE_KINDS, "allowedCandidateKinds");
  validateEnumList(value.constraints.allowedClaimRoles, enums.claimableRole, "allowedClaimRoles");
  validateEnumList(value.constraints.allowedResultValues, enums.claimResult, "allowedResultValues");
  checkedString(value.constraints.roleDisclosurePolicy, 1, 64, "roleDisclosurePolicy");
  checkedString(value.presentation.speechStyleId, 1, 32, "speechStyleId");
  return value;
}

function validateVoteProjection(vote) {
  exact(vote, ["schemaVersion", "projectionType", "voteEventId", "actorId", "targetId", "turnId", "occurredPhase"], "invalid_projection");
  if (vote.schemaVersion !== SCHEMA_VERSION || vote.projectionType !== "public_vote") throw projectionError("invalid_public_vote_type");
  for (const key of ["voteEventId", "actorId", "targetId", "turnId"]) assertId(vote[key], key);
  checkedEnum(vote.occurredPhase, enums.gamePhase, "votePhase");
}

function validateExecutionProjection(execution) {
  exact(execution, ["schemaVersion", "projectionType", "executionEventId", "executedPlayerId", "turnId", "occurredPhase"], "invalid_projection");
  if (execution.schemaVersion !== SCHEMA_VERSION || execution.projectionType !== "execution") throw projectionError("invalid_public_execution_type");
  for (const key of ["executionEventId", "executedPlayerId", "turnId"]) assertId(execution[key], key);
  checkedEnum(execution.occurredPhase, enums.gamePhase, "executionPhase");
}

function validateAttackDeathProjection(death) {
  exact(death, ["schemaVersion", "projectionType", "attackEventId", "attackedPlayerId", "turnId", "occurredPhase"], "invalid_projection");
  if (death.schemaVersion !== SCHEMA_VERSION || death.projectionType !== "attack_death") throw projectionError("invalid_public_attack_death_type");
  for (const key of ["attackEventId", "attackedPlayerId", "turnId"]) assertId(death[key], key);
  checkedEnum(death.occurredPhase, enums.gamePhase, "attackDeathPhase");
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

function projectVote(event) {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectionType: "public_vote",
    voteEventId: checkedId(event.eventId, "voteEventId"),
    actorId: checkedId(event.actorId, "voteActorId"),
    targetId: checkedId(event.targetId, "voteTargetId"),
    turnId: checkedId(event.turnId, "voteTurnId"),
    occurredPhase: checkedEnum(event.occurredPhase, enums.gamePhase, "votePhase")
  };
}

function compareBy(key) {
  return (left, right) => compareText(left[key], right[key]);
}

function compareOrderedSource(left, right) {
  return left.order - right.order || compareText(left.id, right.id);
}

function compareDayAndTarget(left, right) {
  return left.day - right.day || compareText(left.targetId, right.targetId);
}

function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

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
