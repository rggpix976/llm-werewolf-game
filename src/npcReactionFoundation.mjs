import { createId } from "./conversation/ids.mjs";
import { ID_PATTERN, SCHEMA_VERSION } from "./conversation/domain.mjs";

export const LOGICAL_REACTION_STATUSES = Object.freeze([
  "planned",
  "active",
  "committed",
  "rejected",
  "superseded",
  "cancelled",
  "exhausted"
]);

export const REACTION_ATTEMPT_STATUSES = Object.freeze([
  "attempting",
  "candidate_received",
  "validated",
  "accepted",
  "failed",
  "timed_out",
  "rejected",
  "aborted"
]);

const LOGICAL_TERMINAL_STATUSES = new Set(["committed", "rejected", "superseded", "cancelled", "exhausted"]);
const ATTEMPT_TERMINAL_STATUSES = new Set(["accepted", "failed", "timed_out", "rejected", "aborted"]);

export function resolveNpcStructuredReactionPolicy({ npcStructuredReactionMode = false, playerConversationCommitMode = false } = {}) {
  if (npcStructuredReactionMode !== true) return Object.freeze({ enabled: false });
  if (playerConversationCommitMode !== true) throw foundationError("npc_structured_reaction_requires_player_commit");
  return Object.freeze({ enabled: true });
}

export function createLogicalReactionFoundation({
  gameSessionId,
  triggerRequestId,
  inputRecordId,
  turnId,
  turnOrder,
  phase,
  actorId,
  baseStateVersion,
  createId: createEngineId
}) {
  for (const [name, value] of Object.entries({ gameSessionId, triggerRequestId, inputRecordId, turnId, actorId })) assertId(value, name);
  assertSafeInteger(turnOrder, "turnOrder");
  assertSafeInteger(baseStateVersion, "baseStateVersion");
  if (typeof phase !== "string" || phase.length === 0) throw foundationError("invalid_reaction_phase");
  if (typeof createEngineId !== "function") throw foundationError("invalid_id_generator");

  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    reactionPlanId: createId("reaction-plan", createEngineId),
    requestId: createId("reaction-request", createEngineId),
    correlationId: createId("reaction-correlation", createEngineId),
    gameSessionId,
    causationId: triggerRequestId,
    originatingInputRecordId: inputRecordId,
    turnId,
    turnOrder,
    preconditionPhase: phase,
    preconditionStateVersion: baseStateVersion,
    npcId: actorId,
    status: "planned"
  });
}

export function createReactionAttemptFoundation(logicalReaction, createEngineId) {
  validateLogicalReactionFoundation(logicalReaction);
  if (isLogicalReactionTerminal(logicalReaction.status)) throw foundationError("logical_reaction_terminal");
  if (typeof createEngineId !== "function") throw foundationError("invalid_id_generator");
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    reactionPlanId: logicalReaction.reactionPlanId,
    reactionAttemptId: createId("reaction-attempt", createEngineId),
    status: "attempting"
  });
}

export function validateLogicalReactionFoundation(value) {
  exactKeys(value, [
    "schemaVersion", "reactionPlanId", "requestId", "correlationId", "gameSessionId", "causationId",
    "originatingInputRecordId", "turnId", "turnOrder", "preconditionPhase", "preconditionStateVersion", "npcId", "status"
  ], "invalid_logical_reaction");
  if (value.schemaVersion !== SCHEMA_VERSION) throw foundationError("unsupported_reaction_schema");
  for (const name of ["reactionPlanId", "requestId", "correlationId", "gameSessionId", "causationId", "originatingInputRecordId", "turnId", "npcId"]) assertId(value[name], name);
  assertSafeInteger(value.turnOrder, "turnOrder");
  assertSafeInteger(value.preconditionStateVersion, "preconditionStateVersion");
  assertLogicalReactionStatus(value.status);
  if (typeof value.preconditionPhase !== "string" || value.preconditionPhase.length === 0) throw foundationError("invalid_reaction_phase");
  return value;
}

export function validateReactionAttemptFoundation(value) {
  exactKeys(value, ["schemaVersion", "reactionPlanId", "reactionAttemptId", "status"], "invalid_reaction_attempt");
  if (value.schemaVersion !== SCHEMA_VERSION) throw foundationError("unsupported_reaction_schema");
  assertId(value.reactionPlanId, "reactionPlanId");
  assertId(value.reactionAttemptId, "reactionAttemptId");
  assertReactionAttemptStatus(value.status);
  return value;
}

export function assertLogicalReactionStatus(status) {
  if (!LOGICAL_REACTION_STATUSES.includes(status)) throw foundationError("invalid_logical_reaction_status");
  return status;
}

export function assertReactionAttemptStatus(status) {
  if (!REACTION_ATTEMPT_STATUSES.includes(status)) throw foundationError("invalid_reaction_attempt_status");
  return status;
}

export function isLogicalReactionTerminal(status) {
  assertLogicalReactionStatus(status);
  return LOGICAL_TERMINAL_STATUSES.has(status);
}

export function isReactionAttemptTerminal(status) {
  assertReactionAttemptStatus(status);
  return ATTEMPT_TERMINAL_STATUSES.has(status);
}

function exactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw foundationError(code);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) || actual.some((key) => !keys.includes(key))) throw foundationError(code);
}

function assertId(value, name) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw foundationError(`invalid_${name}`);
}

function assertSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw foundationError(`invalid_${name}`);
}

function foundationError(code) {
  const error = new Error(code);
  error.name = "NpcReactionFoundationError";
  error.code = code;
  return error;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  return value;
}
