import { ID_PATTERN, SCHEMA_VERSION, SHA256_PATTERN, enums } from "./conversation/domain.mjs";
import {
  LOGICAL_REACTION_STATUSES,
  REACTION_ATTEMPT_STATUSES
} from "./npcReactionFoundation.mjs";

export const NPC_REACTION_COORDINATOR_CAPACITY = 1024;
export const NPC_REACTION_MAX_ATTEMPTS = 8;

const ROOT_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "nextTerminalOrder", "logicalReactions",
  "reactionAttempts", "terminalSlotReservations", "reactionTombstones"
]);
const LOGICAL_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "reactionPlanId", "requestId", "requestFingerprint",
  "correlationId", "causationId", "originatingInputRecordId", "turnId", "turnOrder",
  "preconditionPhase", "preconditionStateVersion", "npcId", "routeSnapshot",
  "projectionFingerprint", "status", "attemptIds", "createdAt", "retryPolicy"
]);
const ATTEMPT_FIELDS = Object.freeze([
  "schemaVersion", "pendingType", "gameSessionId", "requestId", "requestFingerprint",
  "correlationId", "causationId", "reactionPlanId", "reactionAttemptId",
  "originatingInputRecordId", "turnId", "turnOrder", "preconditionStateVersion",
  "preconditionPhase", "targetNpcId", "operation", "status", "candidateFingerprint", "startedAt"
]);
const RESERVATION_FIELDS = Object.freeze([
  "schemaVersion", "reservationType", "gameSessionId", "reactionPlanId", "terminalOrder", "status"
]);
const SUMMARY_COMMON_FIELDS = Object.freeze(["schemaVersion", "reactionAttemptId", "status", "observation"]);
const TOMBSTONE_COMMON_FIELDS = Object.freeze([
  "schemaVersion", "tombstoneType", "gameSessionId", "reactionPlanId", "requestId",
  "requestFingerprint", "correlationId", "causationId", "originatingInputRecordId",
  "npcId", "preconditionStateVersion", "terminalStatus", "terminalOrder", "maxAttempts", "attempts"
]);
const COMMITTED_ONLY_FIELDS = Object.freeze([
  "successfulAttemptId", "preparationFingerprint", "npcPublicationId", "commitResultRequestId"
]);
const NON_COMMIT_ONLY_FIELDS = Object.freeze(["reason"]);
const TERMINAL_ATTEMPT_STATUSES = new Set(["accepted", "failed", "timed_out", "rejected", "aborted"]);
const NON_COMMIT_STATUSES = new Set(["rejected", "superseded", "cancelled", "exhausted"]);
const NON_COMMIT_REASONS = new Set([
  "identity_conflict", "stale_applicability", "authorization_failure", "allocation_failure",
  "ordering_failure", "retry_exhausted", "cancelled", "internal_failure"
]);

export class NpcReactionCoordinatorInvariantError extends Error {
  constructor(code) {
    super("Invalid NPC reaction coordinator state.");
    this.name = "NpcReactionCoordinatorInvariantError";
    this.code = code;
  }
}

export function createNpcReactionCoordinatorRoot(gameSessionId) {
  assertId(gameSessionId);
  return freeze({
    schemaVersion: SCHEMA_VERSION,
    gameSessionId,
    nextTerminalOrder: 0,
    logicalReactions: {},
    reactionAttempts: {},
    terminalSlotReservations: {},
    reactionTombstones: {}
  });
}

export function validateNpcReactionCoordinatorRoot(root) {
  exact(root, ROOT_FIELDS);
  if (root.schemaVersion !== SCHEMA_VERSION) fail("invalid_coordinator_state");
  assertId(root.gameSessionId);
  assertSafeNonnegative(root.nextTerminalOrder);
  for (const name of ["logicalReactions", "reactionAttempts", "terminalSlotReservations", "reactionTombstones"]) {
    assertIndex(root[name]);
  }

  const terminalOrders = new Set();
  const requestIds = new Set();
  for (const [key, logical] of Object.entries(root.logicalReactions)) {
    validateLogical(logical);
    if (key !== logical.reactionPlanId || logical.gameSessionId !== root.gameSessionId) fail("invalid_coordinator_state");
    if (requestIds.has(logical.requestId)) fail("invalid_coordinator_state");
    requestIds.add(logical.requestId);
    const reservation = root.terminalSlotReservations[key];
    if (!reservation || !["planned", "active"].includes(logical.status)) fail("invalid_terminal_registry");
    const owned = Object.values(root.reactionAttempts).filter((attempt) => attempt.reactionPlanId === key);
    if (!sameArray(logical.attemptIds, owned.map((attempt) => attempt.reactionAttemptId))) fail("invalid_coordinator_state");
    if (logical.attemptIds.length > logical.retryPolicy.maxAttempts) fail("invalid_coordinator_state");
    validateLogicalAttemptCombination(logical, owned);
  }
  for (const [key, attempt] of Object.entries(root.reactionAttempts)) {
    validateAttempt(attempt);
    if (key !== attempt.reactionAttemptId || attempt.gameSessionId !== root.gameSessionId) fail("invalid_coordinator_state");
    const logical = root.logicalReactions[attempt.reactionPlanId];
    if (!logical || !logical.attemptIds.includes(key)) fail("invalid_coordinator_state");
    compareAttemptBinding(logical, attempt);
  }
  for (const [key, reservation] of Object.entries(root.terminalSlotReservations)) {
    validateReservation(reservation);
    if (key !== reservation.reactionPlanId || reservation.gameSessionId !== root.gameSessionId) fail("invalid_terminal_registry");
    if (!root.logicalReactions[key] || root.reactionTombstones[key]) fail("invalid_terminal_registry");
    if (terminalOrders.has(reservation.terminalOrder)) fail("invalid_terminal_registry");
    terminalOrders.add(reservation.terminalOrder);
  }
  for (const [key, tombstone] of Object.entries(root.reactionTombstones)) {
    validateReactionTombstone(tombstone);
    if (key !== tombstone.reactionPlanId || tombstone.gameSessionId !== root.gameSessionId) fail("invalid_coordinator_state");
    if (root.logicalReactions[key] || root.terminalSlotReservations[key]) fail("invalid_terminal_registry");
    if (Object.values(root.reactionAttempts).some((attempt) => attempt.reactionPlanId === key)) fail("invalid_terminal_registry");
    if (terminalOrders.has(tombstone.terminalOrder)) fail("invalid_terminal_registry");
    terminalOrders.add(tombstone.terminalOrder);
  }
  if (Object.keys(root.terminalSlotReservations).length + Object.keys(root.reactionTombstones).length > NPC_REACTION_COORDINATOR_CAPACITY) {
    fail("invalid_terminal_registry");
  }
  return root;
}

export function createPlannedNpcReaction(root, { gameSessionId, logicalReaction }) {
  validateNpcReactionCoordinatorRoot(root);
  assertSession(root, gameSessionId);
  validateLogical(logicalReaction);
  if (logicalReaction.gameSessionId !== gameSessionId || logicalReaction.status !== "planned" || logicalReaction.attemptIds.length !== 0) {
    fail("invalid_coordinator_state");
  }
  if (root.logicalReactions[logicalReaction.reactionPlanId] || root.terminalSlotReservations[logicalReaction.reactionPlanId] ||
      root.reactionTombstones[logicalReaction.reactionPlanId] ||
      Object.values(root.logicalReactions).some((entry) => entry.requestId === logicalReaction.requestId)) {
    fail("terminal_identity_collision");
  }
  if (root.nextTerminalOrder === Number.MAX_SAFE_INTEGER) {
    return freeze({ schemaVersion: SCHEMA_VERSION, status: "rejected", reasonCode: "terminal_order_exhausted" });
  }
  const copy = clone(root);
  const occupied = Object.keys(copy.terminalSlotReservations).length + Object.keys(copy.reactionTombstones).length;
  if (occupied >= NPC_REACTION_COORDINATOR_CAPACITY) {
    const oldest = oldestTombstone(copy.reactionTombstones);
    if (!oldest) return freeze({ schemaVersion: SCHEMA_VERSION, status: "rejected", reasonCode: "terminal_capacity_exhausted" });
    delete copy.reactionTombstones[oldest.reactionPlanId];
  }
  copy.logicalReactions[logicalReaction.reactionPlanId] = clone(logicalReaction);
  copy.terminalSlotReservations[logicalReaction.reactionPlanId] = {
    schemaVersion: SCHEMA_VERSION,
    reservationType: "reaction_terminal_slot",
    gameSessionId,
    reactionPlanId: logicalReaction.reactionPlanId,
    terminalOrder: copy.nextTerminalOrder,
    status: "reserved"
  };
  copy.nextTerminalOrder += 1;
  validateNpcReactionCoordinatorRoot(copy);
  return freeze({ schemaVersion: SCHEMA_VERSION, status: "created", root: copy });
}

export function createNpcReactionAttempt(root, { gameSessionId, attempt }) {
  validateNpcReactionCoordinatorRoot(root);
  assertSession(root, gameSessionId);
  validateAttempt(attempt);
  if (attempt.gameSessionId !== gameSessionId || attempt.status !== "attempting" || attempt.candidateFingerprint !== null) {
    fail("invalid_coordinator_state");
  }
  const logical = root.logicalReactions[attempt.reactionPlanId];
  if (!logical || !["planned", "active"].includes(logical.status)) fail("invalid_coordinator_state");
  if (!root.terminalSlotReservations[logical.reactionPlanId]) fail("invalid_terminal_registry");
  if (root.reactionAttempts[attempt.reactionAttemptId]) fail("terminal_identity_collision");
  compareAttemptBinding(logical, attempt);
  if (logical.attemptIds.length >= logical.retryPolicy.maxAttempts) fail("invalid_coordinator_state");
  const copy = clone(root);
  copy.reactionAttempts[attempt.reactionAttemptId] = clone(attempt);
  copy.logicalReactions[logical.reactionPlanId].attemptIds.push(attempt.reactionAttemptId);
  copy.logicalReactions[logical.reactionPlanId].status = "active";
  validateNpcReactionCoordinatorRoot(copy);
  return freeze({ schemaVersion: SCHEMA_VERSION, status: "created", root: copy });
}

export function receiveNpcReactionCandidate(root, { gameSessionId, reactionPlanId, reactionAttemptId }) {
  validateNpcReactionCoordinatorRoot(root);
  assertSession(root, gameSessionId);
  const attempt = ownedAttempt(root, reactionPlanId, reactionAttemptId);
  if (attempt.status !== "attempting" || attempt.candidateFingerprint !== null) fail("invalid_coordinator_state");
  const copy = clone(root);
  copy.reactionAttempts[reactionAttemptId].status = "candidate_received";
  validateNpcReactionCoordinatorRoot(copy);
  return freeze({ schemaVersion: SCHEMA_VERSION, status: "candidate_received", root: copy });
}

export function observeNpcReactionCandidate(root, { gameSessionId, reactionPlanId, reactionAttemptId, candidateFingerprint }) {
  validateNpcReactionCoordinatorRoot(root);
  assertSession(root, gameSessionId);
  assertFingerprint(candidateFingerprint);
  const attempt = ownedAttempt(root, reactionPlanId, reactionAttemptId);
  if (attempt.candidateFingerprint !== null) {
    return freeze({
      schemaVersion: SCHEMA_VERSION,
      status: attempt.candidateFingerprint === candidateFingerprint ? "duplicate_response" : "attempt_response_conflict"
    });
  }
  if (attempt.status !== "candidate_received") fail("invalid_coordinator_state");
  const copy = clone(root);
  copy.reactionAttempts[reactionAttemptId].candidateFingerprint = candidateFingerprint;
  copy.reactionAttempts[reactionAttemptId].status = "validated";
  validateNpcReactionCoordinatorRoot(copy);
  return freeze({ schemaVersion: SCHEMA_VERSION, status: "validated", root: copy });
}

export function terminalizeNpcReactionIdentityConflict(root, { gameSessionId, reactionPlanId }) {
  validateNpcReactionCoordinatorRoot(root);
  assertSession(root, gameSessionId);
  const logical = root.logicalReactions[reactionPlanId];
  if (!logical || logical.status !== "active") fail("invalid_coordinator_state");
  const copy = clone(root);
  const attempts = logical.attemptIds.map((id) => copy.reactionAttempts[id]);
  for (const attempt of attempts) {
    if (attempt.status === "accepted") fail("invalid_coordinator_state");
    if (attempt.status === "attempting" || attempt.status === "candidate_received") attempt.status = "aborted";
    else if (attempt.status === "validated") attempt.status = "rejected";
  }
  const tombstone = buildNonCommitTombstone(copy.logicalReactions[reactionPlanId], attempts, copy.terminalSlotReservations[reactionPlanId], "rejected", "identity_conflict");
  return installTombstone(copy, tombstone, "cleaned");
}

export function cleanupCommittedNpcReaction(root, {
  gameSessionId, reactionPlanId, successfulAttemptId, preparationFingerprint, npcPublicationId, commitResultRequestId
}) {
  validateNpcReactionCoordinatorRoot(root);
  assertSession(root, gameSessionId);
  const existing = root.reactionTombstones[reactionPlanId];
  if (existing) {
    if (existing.tombstoneType !== "committed") fail("invalid_coordinator_state");
    validateReactionTombstone(existing);
    return freeze({
      root,
      result: { schemaVersion: SCHEMA_VERSION, status: "already_cleaned", reactionPlanId, terminalOrder: existing.terminalOrder }
    });
  }
  const logical = root.logicalReactions[reactionPlanId];
  if (!logical || logical.status !== "active") fail("invalid_coordinator_state");
  const copy = clone(root);
  const attempts = logical.attemptIds.map((id) => copy.reactionAttempts[id]);
  const winner = attempts.find((attempt) => attempt.reactionAttemptId === successfulAttemptId);
  if (!winner || winner.status !== "validated" || !winner.candidateFingerprint) fail("invalid_coordinator_state");
  for (const attempt of attempts) {
    if (attempt === winner) attempt.status = "accepted";
    else if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) attempt.status = "aborted";
  }
  const reservation = copy.terminalSlotReservations[reactionPlanId];
  const tombstone = {
    ...tombstoneCommon(copy.logicalReactions[reactionPlanId], attempts, reservation, "committed"),
    tombstoneType: "committed",
    terminalStatus: "committed",
    successfulAttemptId,
    preparationFingerprint,
    npcPublicationId,
    commitResultRequestId
  };
  validateReactionTombstone(tombstone);
  return installTombstone(copy, tombstone, "cleaned");
}

export function terminalizeNpcReaction(root, { gameSessionId, reactionPlanId, terminalStatus, reason }) {
  validateNpcReactionCoordinatorRoot(root);
  assertSession(root, gameSessionId);
  if (!NON_COMMIT_STATUSES.has(terminalStatus) || !NON_COMMIT_REASONS.has(reason)) fail("invalid_coordinator_state");
  const logical = root.logicalReactions[reactionPlanId];
  if (!logical || !["planned", "active"].includes(logical.status)) fail("invalid_coordinator_state");
  const copy = clone(root);
  const attempts = logical.attemptIds.map((id) => copy.reactionAttempts[id]);
  for (const attempt of attempts) {
    if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) attempt.status = "aborted";
  }
  const tombstone = buildNonCommitTombstone(copy.logicalReactions[reactionPlanId], attempts, copy.terminalSlotReservations[reactionPlanId], terminalStatus, reason);
  return installTombstone(copy, tombstone, "cleaned");
}

export function validateReactionTombstone(value) {
  const committed = value?.tombstoneType === "committed";
  exact(value, [...TOMBSTONE_COMMON_FIELDS, ...(committed ? COMMITTED_ONLY_FIELDS : NON_COMMIT_ONLY_FIELDS)]);
  if (value.schemaVersion !== SCHEMA_VERSION) fail("invalid_coordinator_state");
  for (const field of ["gameSessionId", "reactionPlanId", "requestId", "correlationId", "causationId", "originatingInputRecordId", "npcId"]) assertId(value[field]);
  assertFingerprint(value.requestFingerprint);
  assertSafeNonnegative(value.preconditionStateVersion);
  assertSafeNonnegative(value.terminalOrder);
  assertMaxAttempts(value.maxAttempts);
  if (!Array.isArray(value.attempts) || value.attempts.length > value.maxAttempts) fail("invalid_coordinator_state");
  const ids = new Set();
  for (const summary of value.attempts) {
    validateSummary(summary);
    if (ids.has(summary.reactionAttemptId)) fail("invalid_coordinator_state");
    ids.add(summary.reactionAttemptId);
  }
  if (committed) {
    if (value.terminalStatus !== "committed") fail("invalid_coordinator_state");
    for (const field of COMMITTED_ONLY_FIELDS) {
      if (field.endsWith("Fingerprint")) assertFingerprint(value[field]); else assertId(value[field]);
    }
    const accepted = value.attempts.filter((summary) => summary.status === "accepted");
    if (accepted.length !== 1 || accepted[0].reactionAttemptId !== value.successfulAttemptId || accepted[0].observation !== "fingerprinted") {
      fail("invalid_coordinator_state");
    }
  } else {
    if (value.tombstoneType !== "non_commit" || !NON_COMMIT_STATUSES.has(value.terminalStatus) || !NON_COMMIT_REASONS.has(value.reason)) {
      fail("invalid_coordinator_state");
    }
    if (value.attempts.some((summary) => summary.status === "accepted")) fail("invalid_coordinator_state");
  }
  return value;
}

export function resetNpcReactionCoordinator(root, { gameSessionId, newGameSessionId }) {
  validateNpcReactionCoordinatorRoot(root);
  assertSession(root, gameSessionId);
  return freeze({ schemaVersion: SCHEMA_VERSION, status: "reset", root: createNpcReactionCoordinatorRoot(newGameSessionId) });
}

export function destroyNpcReactionCoordinator(root, { gameSessionId }) {
  validateNpcReactionCoordinatorRoot(root);
  assertSession(root, gameSessionId);
  return freeze({ schemaVersion: SCHEMA_VERSION, status: "destroyed" });
}

function installTombstone(copy, tombstone, status) {
  validateReactionTombstone(tombstone);
  const reactionPlanId = tombstone.reactionPlanId;
  copy.reactionTombstones[reactionPlanId] = tombstone;
  delete copy.terminalSlotReservations[reactionPlanId];
  delete copy.logicalReactions[reactionPlanId];
  for (const [id, attempt] of Object.entries(copy.reactionAttempts)) {
    if (attempt.reactionPlanId === reactionPlanId) delete copy.reactionAttempts[id];
  }
  validateNpcReactionCoordinatorRoot(copy);
  return freeze({
    root: copy,
    result: { schemaVersion: SCHEMA_VERSION, status, reactionPlanId, terminalOrder: tombstone.terminalOrder }
  });
}

function buildNonCommitTombstone(logical, attempts, reservation, terminalStatus, reason) {
  const tombstone = {
    ...tombstoneCommon(logical, attempts, reservation, terminalStatus),
    tombstoneType: "non_commit",
    terminalStatus,
    reason
  };
  validateReactionTombstone(tombstone);
  return tombstone;
}

function tombstoneCommon(logical, attempts, reservation, terminalStatus) {
  if (!reservation) fail("invalid_terminal_registry");
  return {
    schemaVersion: SCHEMA_VERSION,
    gameSessionId: logical.gameSessionId,
    reactionPlanId: logical.reactionPlanId,
    requestId: logical.requestId,
    requestFingerprint: logical.requestFingerprint,
    correlationId: logical.correlationId,
    causationId: logical.causationId,
    originatingInputRecordId: logical.originatingInputRecordId,
    npcId: logical.npcId,
    preconditionStateVersion: logical.preconditionStateVersion,
    terminalStatus,
    terminalOrder: reservation.terminalOrder,
    maxAttempts: logical.retryPolicy.maxAttempts,
    attempts: attempts.map(toSummary)
  };
}

function toSummary(attempt) {
  if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) fail("invalid_coordinator_state");
  return attempt.candidateFingerprint === null
    ? { schemaVersion: SCHEMA_VERSION, reactionAttemptId: attempt.reactionAttemptId, status: attempt.status, observation: "none" }
    : { schemaVersion: SCHEMA_VERSION, reactionAttemptId: attempt.reactionAttemptId, status: attempt.status, observation: "fingerprinted", candidateFingerprint: attempt.candidateFingerprint };
}

function validateSummary(summary) {
  const fingerprinted = summary?.observation === "fingerprinted";
  exact(summary, fingerprinted ? [...SUMMARY_COMMON_FIELDS, "candidateFingerprint"] : SUMMARY_COMMON_FIELDS);
  if (summary.schemaVersion !== SCHEMA_VERSION || !TERMINAL_ATTEMPT_STATUSES.has(summary.status)) fail("invalid_coordinator_state");
  assertId(summary.reactionAttemptId);
  if (fingerprinted) assertFingerprint(summary.candidateFingerprint);
  else if (summary.observation !== "none") fail("invalid_coordinator_state");
  if (["accepted"].includes(summary.status) && !fingerprinted) fail("invalid_coordinator_state");
  if (["failed", "timed_out"].includes(summary.status) && fingerprinted) fail("invalid_coordinator_state");
}

function validateLogical(logical) {
  exact(logical, LOGICAL_FIELDS);
  if (logical.schemaVersion !== SCHEMA_VERSION || !LOGICAL_REACTION_STATUSES.includes(logical.status)) fail("invalid_coordinator_state");
  for (const field of ["gameSessionId", "reactionPlanId", "requestId", "correlationId", "causationId", "originatingInputRecordId", "turnId", "npcId"]) assertId(logical[field]);
  assertFingerprint(logical.requestFingerprint);
  assertFingerprint(logical.projectionFingerprint);
  assertSafeNonnegative(logical.turnOrder);
  assertSafeNonnegative(logical.preconditionStateVersion);
  if (!enums.gamePhase.includes(logical.preconditionPhase)) fail("invalid_coordinator_state");
  exact(logical.routeSnapshot, ["schemaVersion", "route"]);
  if (logical.routeSnapshot.schemaVersion !== SCHEMA_VERSION || !["structured", "legacy"].includes(logical.routeSnapshot.route)) fail("invalid_coordinator_state");
  validateRetryPolicy(logical.retryPolicy);
  if (!Array.isArray(logical.attemptIds) || logical.attemptIds.length > logical.retryPolicy.maxAttempts || new Set(logical.attemptIds).size !== logical.attemptIds.length) fail("invalid_coordinator_state");
  logical.attemptIds.forEach(assertId);
  assertRfc3339(logical.createdAt);
}

function validateRetryPolicy(policy) {
  exact(policy, ["schemaVersion", "maxAttempts", "backoffDelaysMs", "logicalDeadlineMs"]);
  if (policy.schemaVersion !== SCHEMA_VERSION) fail("invalid_coordinator_state");
  assertMaxAttempts(policy.maxAttempts);
  if (!Array.isArray(policy.backoffDelaysMs) || policy.backoffDelaysMs.length > policy.maxAttempts - 1) fail("invalid_coordinator_state");
  policy.backoffDelaysMs.forEach(assertSafeNonnegative);
  if (!Number.isSafeInteger(policy.logicalDeadlineMs) || policy.logicalDeadlineMs < 1) fail("invalid_coordinator_state");
}

function validateAttempt(attempt) {
  exact(attempt, ATTEMPT_FIELDS);
  if (attempt.schemaVersion !== SCHEMA_VERSION || attempt.pendingType !== "npc_reaction" ||
      attempt.operation !== "generate_npc_reaction_candidate" || !REACTION_ATTEMPT_STATUSES.includes(attempt.status)) {
    fail("invalid_coordinator_state");
  }
  for (const field of ["gameSessionId", "requestId", "correlationId", "causationId", "reactionPlanId", "reactionAttemptId", "originatingInputRecordId", "turnId", "targetNpcId"]) assertId(attempt[field]);
  assertFingerprint(attempt.requestFingerprint);
  assertSafeNonnegative(attempt.turnOrder);
  assertSafeNonnegative(attempt.preconditionStateVersion);
  if (!enums.gamePhase.includes(attempt.preconditionPhase)) fail("invalid_coordinator_state");
  assertRfc3339(attempt.startedAt);
  if (attempt.candidateFingerprint !== null) assertFingerprint(attempt.candidateFingerprint);
  if (["attempting", "candidate_received", "failed", "timed_out"].includes(attempt.status) && attempt.candidateFingerprint !== null) fail("invalid_coordinator_state");
  if (["validated", "accepted"].includes(attempt.status) && attempt.candidateFingerprint === null) fail("invalid_coordinator_state");
}

function validateReservation(value) {
  exact(value, RESERVATION_FIELDS);
  if (value.schemaVersion !== SCHEMA_VERSION || value.reservationType !== "reaction_terminal_slot" || value.status !== "reserved") fail("invalid_terminal_registry");
  assertId(value.gameSessionId);
  assertId(value.reactionPlanId);
  assertSafeNonnegative(value.terminalOrder);
}

function validateLogicalAttemptCombination(logical, attempts) {
  if (logical.status === "planned" && attempts.length !== 0) fail("invalid_coordinator_state");
  if (logical.status === "active" && attempts.length === 0) fail("invalid_coordinator_state");
  if (!["planned", "active"].includes(logical.status)) fail("invalid_coordinator_state");
  if (attempts.some((attempt) => attempt.status === "accepted")) fail("invalid_coordinator_state");
}

function compareAttemptBinding(logical, attempt) {
  const pairs = [
    ["gameSessionId", "gameSessionId"], ["reactionPlanId", "reactionPlanId"], ["requestId", "requestId"],
    ["requestFingerprint", "requestFingerprint"], ["correlationId", "correlationId"], ["causationId", "causationId"],
    ["originatingInputRecordId", "originatingInputRecordId"], ["turnId", "turnId"], ["turnOrder", "turnOrder"],
    ["preconditionStateVersion", "preconditionStateVersion"], ["preconditionPhase", "preconditionPhase"], ["npcId", "targetNpcId"]
  ];
  if (pairs.some(([left, right]) => logical[left] !== attempt[right])) fail("invalid_coordinator_state");
}

function ownedAttempt(root, reactionPlanId, reactionAttemptId) {
  const attempt = root.reactionAttempts[reactionAttemptId];
  if (!attempt || attempt.reactionPlanId !== reactionPlanId || !root.logicalReactions[reactionPlanId]) fail("invalid_coordinator_state");
  return attempt;
}

function oldestTombstone(index) {
  return Object.values(index).sort((a, b) => a.terminalOrder - b.terminalOrder || a.reactionPlanId.localeCompare(b.reactionPlanId))[0] ?? null;
}

function assertSession(root, gameSessionId) {
  assertId(gameSessionId);
  if (root.gameSessionId !== gameSessionId) fail("coordinator_session_mismatch");
}

function assertIndex(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("invalid_coordinator_state");
}

function exact(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_coordinator_state");
  const keys = Object.keys(value);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(value, field)) || keys.some((key) => !fields.includes(key))) fail("invalid_coordinator_state");
}

function assertId(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail("invalid_coordinator_state");
}

function assertFingerprint(value) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail("invalid_coordinator_state");
}

function assertSafeNonnegative(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_coordinator_state");
}

function assertMaxAttempts(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > NPC_REACTION_MAX_ATTEMPTS) fail("invalid_coordinator_state");
}

function assertRfc3339(value) {
  if (typeof value !== "string" || value.length < 20 || value.length > 35 || !value.endsWith("Z") || Number.isNaN(Date.parse(value))) fail("invalid_coordinator_state");
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function clone(value) {
  return structuredClone(value);
}

function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  return value;
}

function fail(code) {
  throw new NpcReactionCoordinatorInvariantError(code);
}
