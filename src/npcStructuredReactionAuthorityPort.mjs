import { ID_PATTERN, SHA256_PATTERN, enums } from "./conversation/domain.mjs";
import {
  validateCanonicalClaim,
  validateConversationCommitResult,
  validatePlayerInputRecord,
  validatePublicEvent
} from "./conversation/validators.mjs";
import { validateNpcKnownInformationProjection } from "./npcKnownInformationProjection.mjs";

export const NPC_STRUCTURED_REACTION_AUTHORITY_PORT_INVARIANT_CODES = Object.freeze([
  "invalid_npc_structured_authority_input",
  "invalid_npc_structured_authority_state",
  "invalid_npc_structured_trigger_graph",
  "invalid_npc_structured_replay_graph",
  "invalid_npc_structured_authority_snapshot",
  "invalid_npc_structured_commit_input",
  "invalid_npc_structured_commit_projection",
  "invalid_npc_structured_commit_result",
  "invalid_npc_structured_authorized_delta",
  "invalid_npc_structured_working_state",
  "invalid_npc_structured_state_replacement",
  "npc_structured_authority_alias_detected"
]);

const MESSAGE = "Invalid NPC structured reaction authority operation.";
const SNAPSHOT_FIELDS = Object.freeze([
  "schemaVersion", "snapshotType", "gameSessionId", "turnId", "turnOrder",
  "currentPhase", "stateVersion", "triggeringCommitResult", "originatingInputRecord",
  "triggeringEvents", "targetNpcId", "knownInformationProjection", "currentRoster",
  "actorApplicability", "currentAuthorization", "currentTargetIds", "existingClaims",
  "existingEvents", "nextOrderEvidence", "occupiedArtifactIds", "publicParticipantsById",
  "committedReplay"
]);

export class NpcStructuredReactionAuthorityPortInvariantError extends Error {
  constructor(code = "invalid_npc_structured_authority_input") {
    super(MESSAGE);
    Object.defineProperty(this, "name", { value: "NpcStructuredReactionAuthorityPortInvariantError", writable: true });
    Object.defineProperty(this, "code", {
      value: NPC_STRUCTURED_REACTION_AUTHORITY_PORT_INVARIANT_CODES.includes(code)
        ? code
        : "invalid_npc_structured_authority_input"
    });
  }
}

export function validateNpcStructuredReactionAuthoritySnapshot(value) {
  try {
    exact(value, SNAPSHOT_FIELDS);
    if (value.schemaVersion !== 1 || value.snapshotType !== "npc_structured_reaction_authority") fail();
    for (const field of ["gameSessionId", "turnId", "targetNpcId"]) id(value[field]);
    safe(value.turnOrder); safe(value.stateVersion);
    if (!enums.gamePhase.includes(value.currentPhase)) fail();
    validateConversationCommitResult(value.triggeringCommitResult);
    if (value.triggeringCommitResult.commitType !== "player_conversation") fail();
    validatePlayerInputRecord(value.originatingInputRecord);
    dense(value.triggeringEvents, 0, 16).forEach(validatePublicEvent);
    validateNpcKnownInformationProjection(value.knownInformationProjection);
    validateRoster(value.currentRoster);
    validateActorApplicability(value.actorApplicability, value.targetNpcId, value.currentRoster);
    validateAuthorization(value.currentAuthorization, value.targetNpcId, value.actorApplicability);
    ids(value.currentTargetIds, 0, 16);
    dense(value.existingClaims, 0, 64).forEach(validateCanonicalClaim);
    dense(value.existingEvents, 0, 64).forEach(validatePublicEvent);
    exact(value.nextOrderEvidence, ["nextCreatedOrder", "nextPublicationSlotOrder", "nextRecordAppendOrder"]);
    Object.values(value.nextOrderEvidence).forEach(safe);
    ids(value.occupiedArtifactIds, 0, 4096);
    validateParticipants(value.publicParticipantsById);
    validateReplay(value.committedReplay);
    validateSnapshotBindings(value);
    assertPlainAcyclic(value);
    assertNoAliases(value);
  } catch (error) {
    if (error instanceof NpcStructuredReactionAuthorityPortInvariantError) throw error;
    throw new NpcStructuredReactionAuthorityPortInvariantError("invalid_npc_structured_authority_snapshot");
  }
}

function validateSnapshotBindings(value) {
  const result = value.triggeringCommitResult;
  const input = value.originatingInputRecord;
  if (result.requestId !== input.requestId || result.inputRecordId !== input.inputRecordId
    || result.correlationId !== input.correlationId || result.createdEventIds.length !== value.triggeringEvents.length
    || result.createdEventIds.some((idValue, index) => idValue !== value.triggeringEvents[index].eventId)
    || input.actorId !== "player" || value.knownInformationProjection.actorPrivate.actorId !== value.targetNpcId
    || value.knownInformationProjection.public.triggeringInput.inputRecordId !== input.inputRecordId) fail();
}

function validateRoster(value) {
  dense(value, 1, 16);
  const seen = new Set();
  for (const entry of value) {
    exact(entry, ["participantId", "participantClass", "publicStatus"]);
    id(entry.participantId);
    if (!["player", "npc"].includes(entry.participantClass) || !["alive", "dead"].includes(entry.publicStatus)
      || seen.has(entry.participantId)) fail();
    seen.add(entry.participantId);
  }
}

function validateActorApplicability(value, actorId, roster) {
  if (value?.presence === "present") {
    exact(value, ["schemaVersion", "presence", "actorId", "alive", "maySpeak"]);
    if (value.schemaVersion !== 1 || value.actorId !== actorId || typeof value.alive !== "boolean"
      || typeof value.maySpeak !== "boolean"
      || roster.filter((entry) => entry.participantId === actorId && entry.participantClass === "npc").length !== 1) fail();
  } else if (value?.presence === "absent") {
    exact(value, ["schemaVersion", "presence", "actorId", "absenceReason"]);
    if (value.schemaVersion !== 1 || value.actorId !== actorId || value.absenceReason !== "removed_from_roster"
      || roster.some((entry) => entry.participantId === actorId)) fail();
  } else fail();
}

function validateAuthorization(value, actorId, actor) {
  if (value?.availability === "available") {
    exact(value, ["schemaVersion", "availability", "actorId", "roleDisclosurePolicy", "allowedClaimRoles", "authorizedResultFacts"]);
    if (value.schemaVersion !== 1 || value.actorId !== actorId || actor.presence !== "present"
      || !["never_confess_werewolf", "claim_when_directly_asked_after_result", "avoid_unnecessary_claim"].includes(value.roleDisclosurePolicy)) fail();
    const roles = dense(value.allowedClaimRoles, 0, 1); if (roles.some((role) => role !== "seer") || new Set(roles).size !== roles.length) fail();
    const pairs = new Set();
    for (const fact of dense(value.authorizedResultFacts, 0, 16)) {
      exact(fact, ["targetId", "result"]); id(fact.targetId);
      if (!enums.claimResult.includes(fact.result) || pairs.has(`${fact.targetId}\0${fact.result}`)) fail();
      pairs.add(`${fact.targetId}\0${fact.result}`);
    }
  } else {
    exact(value, ["schemaVersion", "availability", "actorId", "reason"]);
    if (value.schemaVersion !== 1 || value.availability !== "unavailable" || value.actorId !== actorId
      || value.reason !== "actor_absent" || actor.presence !== "absent") fail();
  }
}

function validateParticipants(value) {
  if (!plain(value)) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length < 1 || keys.length > 16 || keys.some((key) => typeof key !== "string")) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail();
    exact(descriptor.value, ["participantId", "displayName"]);
    if (descriptor.value.participantId !== key || typeof descriptor.value.displayName !== "string"
      || descriptor.value.displayName.length < 1 || descriptor.value.displayName.length > 80) fail();
    id(key);
  }
}

function validateReplay(value) {
  if (value?.status === "not_found") {
    exact(value, ["schemaVersion", "status"]); if (value.schemaVersion !== 1) fail(); return;
  }
  if (value?.status === "conflict") {
    exact(value, ["schemaVersion", "status", "code"]);
    if (value.schemaVersion !== 1 || !["trigger_identity_conflict", "request_identity_conflict", "reaction_identity_conflict", "committed_graph_conflict"].includes(value.code)) fail();
    return;
  }
  exact(value, ["schemaVersion", "status", "logicalIdentity", "result"]);
  if (value.schemaVersion !== 1 || value.status !== "replayed") fail();
  exact(value.logicalIdentity, ["gameSessionId", "reactionPlanId", "requestId", "requestFingerprint", "originatingInputRecordId", "turnId", "turnOrder", "npcId"]);
  for (const field of ["gameSessionId", "reactionPlanId", "requestId", "originatingInputRecordId", "turnId", "npcId"]) id(value.logicalIdentity[field]);
  fingerprint(value.logicalIdentity.requestFingerprint); safe(value.logicalIdentity.turnOrder);
  validateConversationCommitResult(value.result); if (value.result.commitType !== "npc_reaction") fail();
}

function assertPlainAcyclic(value, active = new Set()) {
  if (!value || typeof value !== "object") return;
  if (active.has(value)) fail();
  active.add(value);
  if (!Array.isArray(value) && !plain(value)) fail();
  const keys = Array.isArray(value) ? Object.keys(value) : Reflect.ownKeys(value);
  if (Array.isArray(value) && (Object.getOwnPropertySymbols(value).length > 0
    || keys.some((key, index) => key !== String(index)))) fail();
  for (const key of keys) {
    if (typeof key !== "string") fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail();
    assertPlainAcyclic(descriptor.value, active);
  }
  active.delete(value);
}

function assertNoAliases(value) {
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) throw new NpcStructuredReactionAuthorityPortInvariantError("npc_structured_authority_alias_detected");
    seen.add(node);
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
}

function exact(value, fields) {
  if (!plain(value)) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) fail();
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail();
  }
}
function dense(value, min, max) { if (!Array.isArray(value) || value.length < min || value.length > max) fail(); for (let i = 0; i < value.length; i += 1) if (!Object.hasOwn(value, i)) fail(); return value; }
function ids(value, min, max) { dense(value, min, max); value.forEach(id); if (new Set(value).size !== value.length) fail(); return value; }
function id(value) { if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(); }
function fingerprint(value) { if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(); }
function safe(value) { if (!Number.isSafeInteger(value) || value < 0) fail(); }
function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function fail() { throw new TypeError("invalid"); }
