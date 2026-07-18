import assert from "node:assert/strict";
import test from "node:test";
import {
  NPC_REACTION_COORDINATOR_CAPACITY,
  NPC_REACTION_MAX_ATTEMPTS,
  NpcReactionCoordinatorInvariantError,
  cleanupCommittedNpcReaction,
  createNpcReactionAttempt,
  createNpcReactionCoordinatorRoot,
  createPlannedNpcReaction,
  destroyNpcReactionCoordinator,
  observeNpcReactionCandidate,
  receiveNpcReactionCandidate,
  resetNpcReactionCoordinator,
  terminalizeNpcReaction,
  terminalizeNpcReactionAttempt,
  terminalizeNpcReactionIdentityConflict,
  validateNpcReactionCoordinatorRoot,
  validateReactionTombstone
} from "../src/npcReactionCoordinator.mjs";

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

test("attempt terminalization follows the closed pre/post-validation transition table", () => {
  const failed = terminalizeNpcReactionAttempt(activeRoot("attempting"), {
    gameSessionId: "session-1", reactionPlanId: "plan-1", reactionAttemptId: "attempt-1", terminalStatus: "failed"
  });
  assert.equal(failed.root.reactionAttempts["attempt-1"].status, "failed");
  assert.equal(terminalizeNpcReactionAttempt(failed.root, {
    gameSessionId: "session-1", reactionPlanId: "plan-1", reactionAttemptId: "attempt-1", terminalStatus: "failed"
  }).status, "already_terminal");
  assert.throws(() => terminalizeNpcReactionAttempt(activeRoot("validated"), {
    gameSessionId: "session-1", reactionPlanId: "plan-1", reactionAttemptId: "attempt-1", terminalStatus: "failed"
  }), invariant());
  const rejected = terminalizeNpcReactionAttempt(activeRoot("validated"), {
    gameSessionId: "session-1", reactionPlanId: "plan-1", reactionAttemptId: "attempt-1", terminalStatus: "rejected"
  });
  assert.equal(rejected.root.reactionAttempts["attempt-1"].candidateFingerprint, FP_A);
});

test("control root is exact, strict, frozen, browser-safe, and session owned", async () => {
  const root = createNpcReactionCoordinatorRoot("session-1");
  assert.deepEqual(Object.keys(root), [
    "schemaVersion", "gameSessionId", "nextTerminalOrder", "logicalReactions",
    "reactionAttempts", "terminalSlotReservations", "reactionTombstones"
  ]);
  assert(Object.isFrozen(root));
  assert.doesNotThrow(() => validateNpcReactionCoordinatorRoot(root));
  for (const field of Object.keys(root)) {
    const missing = structuredClone(root);
    delete missing[field];
    assert.throws(() => validateNpcReactionCoordinatorRoot(missing), invariant());
  }
  assert.throws(() => validateNpcReactionCoordinatorRoot({ ...root, eighth: true }), invariant());
  assert.throws(() => validateNpcReactionCoordinatorRoot({ ...root, schemaVersion: 2 }), invariant());
  assert.throws(() => validateNpcReactionCoordinatorRoot({ ...root, nextTerminalOrder: -1 }), invariant());
  const source = await import("../src/npcReactionCoordinator.mjs");
  assert(source);
});

test("planned creation reserves zero-based terminal order atomically and is deterministic", () => {
  const root = createNpcReactionCoordinatorRoot("session-1");
  const logical = logicalFor("plan-1");
  const before = structuredClone(root);
  const first = createPlannedNpcReaction(root, { gameSessionId: "session-1", logicalReaction: logical });
  const repeat = createPlannedNpcReaction(root, { gameSessionId: "session-1", logicalReaction: logical });
  assert.deepEqual(root, before);
  assert.deepEqual(first, repeat);
  assert.equal(first.status, "created");
  assert.equal(first.root.nextTerminalOrder, 1);
  assert.equal(first.root.terminalSlotReservations["plan-1"].terminalOrder, 0);
  assert(Object.isFrozen(first.root.logicalReactions["plan-1"].retryPolicy));
  assert.throws(() => createPlannedNpcReaction(root, { gameSessionId: "old-session", logicalReaction: logical }), code("coordinator_session_mismatch"));
  assert.deepEqual(root, before);
});

test("terminal order exhaustion and all-reservation capacity reject without partial effects", () => {
  const exhausted = { ...createNpcReactionCoordinatorRoot("session-1"), nextTerminalOrder: Number.MAX_SAFE_INTEGER };
  const orderResult = createPlannedNpcReaction(exhausted, { gameSessionId: "session-1", logicalReaction: logicalFor("plan-order") });
  assert.deepEqual(orderResult, { schemaVersion: 1, status: "rejected", reasonCode: "terminal_order_exhausted" });
  const full = structuredClone(createNpcReactionCoordinatorRoot("session-1"));
  for (let index = 0; index < NPC_REACTION_COORDINATOR_CAPACITY; index += 1) {
    const planId = `plan-${index}`;
    const logical = logicalFor(planId, { requestId: `request-${index}` });
    full.logicalReactions[planId] = logical;
    full.terminalSlotReservations[planId] = reservationFor(planId, index);
  }
  full.nextTerminalOrder = NPC_REACTION_COORDINATOR_CAPACITY;
  validateNpcReactionCoordinatorRoot(full);
  const before = structuredClone(full);
  const result = createPlannedNpcReaction(full, { gameSessionId: "session-1", logicalReaction: logicalFor("plan-new", { requestId: "request-new" }) });
  assert.equal(result.reasonCode, "terminal_capacity_exhausted");
  assert.deepEqual(full, before);
});

test("capacity evicts only the unique oldest whole tombstone on successful creation", () => {
  const root = structuredClone(createNpcReactionCoordinatorRoot("session-1"));
  for (let index = 0; index < NPC_REACTION_COORDINATOR_CAPACITY; index += 1) {
    const planId = `old-${index}`;
    root.reactionTombstones[planId] = nonCommitTombstone(planId, index);
  }
  root.nextTerminalOrder = NPC_REACTION_COORDINATOR_CAPACITY;
  validateNpcReactionCoordinatorRoot(root);
  const result = createPlannedNpcReaction(root, {
    gameSessionId: "session-1",
    logicalReaction: logicalFor("new-plan", { requestId: "new-request" })
  });
  assert.equal(result.status, "created");
  assert.equal(result.root.reactionTombstones["old-0"], undefined);
  assert(result.root.reactionTombstones["old-1"]);
  assert(result.root.terminalSlotReservations["new-plan"]);
  assert.equal(Object.keys(result.root.reactionTombstones).length + Object.keys(result.root.terminalSlotReservations).length, 1024);
});

test("attempt creation is caller-owned, bounded, detached, and transitions planned to active", () => {
  let root = createdRoot(logicalFor("plan-1", { maxAttempts: 1 }));
  const attempt = attemptFor("plan-1", "attempt-1");
  const before = structuredClone(root);
  const result = createNpcReactionAttempt(root, { gameSessionId: "session-1", attempt });
  assert.deepEqual(root, before);
  root = result.root;
  assert.equal(root.logicalReactions["plan-1"].status, "active");
  assert.deepEqual(root.logicalReactions["plan-1"].attemptIds, ["attempt-1"]);
  assert.equal(root.reactionAttempts["attempt-1"].candidateFingerprint, null);
  assert.throws(() => createNpcReactionAttempt(root, { gameSessionId: "session-1", attempt: attemptFor("plan-1", "attempt-2") }), invariant());
  assert.throws(() => createNpcReactionAttempt(createdRoot(logicalFor("plan-2")), {
    gameSessionId: "session-1", attempt: { ...attemptFor("plan-2", "attempt-x"), candidateFingerprint: FP_A }
  }), invariant());
});

test("retry policy requires explicit safe integer 1..8 and no default", () => {
  for (const value of [1, 3, 8]) assert.doesNotThrow(() => validateNpcReactionCoordinatorRoot(createdRoot(logicalFor(`plan-${value}`, { maxAttempts: value }))));
  for (const value of [undefined, 0, 9, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const logical = logicalFor("plan-bad");
    logical.retryPolicy.maxAttempts = value;
    assert.throws(() => createPlannedNpcReaction(createNpcReactionCoordinatorRoot("session-1"), {
      gameSessionId: "session-1", logicalReaction: logical
    }), invariant());
  }
  assert.equal(NPC_REACTION_MAX_ATTEMPTS, 8);
});

test("candidate observation is two-step, atomic, immutable, duplicate-aware, and conflict-aware", () => {
  let root = activeRoot("candidate_received");
  const before = structuredClone(root);
  const result = observeNpcReactionCandidate(root, {
    gameSessionId: "session-1", reactionPlanId: "plan-1", reactionAttemptId: "attempt-1", candidateFingerprint: FP_A
  });
  assert.deepEqual(root, before);
  root = result.root;
  assert.equal(root.reactionAttempts["attempt-1"].status, "validated");
  assert.equal(root.reactionAttempts["attempt-1"].candidateFingerprint, FP_A);
  assert.deepEqual(observeNpcReactionCandidate(root, {
    gameSessionId: "session-1", reactionPlanId: "plan-1", reactionAttemptId: "attempt-1", candidateFingerprint: FP_A
  }), { schemaVersion: 1, status: "duplicate_response" });
  assert.deepEqual(observeNpcReactionCandidate(root, {
    gameSessionId: "session-1", reactionPlanId: "plan-1", reactionAttemptId: "attempt-1", candidateFingerprint: FP_B
  }), { schemaVersion: 1, status: "attempt_response_conflict" });
  assert.equal(root.reactionAttempts["attempt-1"].candidateFingerprint, FP_A);
  assert.throws(() => observeNpcReactionCandidate(activeRoot("candidate_received"), {
    gameSessionId: "session-1", reactionPlanId: "plan-1", reactionAttemptId: "attempt-1", candidateFingerprint: "A".repeat(64)
  }), invariant());
});

test("candidate fingerprint rejects every malformed representation", () => {
  for (const candidateFingerprint of [undefined, "", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), 1, {}, []]) {
    assert.throws(() => observeNpcReactionCandidate(activeRoot("candidate_received"), {
      gameSessionId: "session-1", reactionPlanId: "plan-1", reactionAttemptId: "attempt-1", candidateFingerprint
    }), invariant());
  }
  const missing = attemptFor("plan-1", "attempt-missing");
  delete missing.candidateFingerprint;
  assert.throws(() => createNpcReactionAttempt(createdRoot(logicalFor("plan-1")), {
    gameSessionId: "session-1", attempt: missing
  }), invariant());
});

test("attempting transitions to candidate_received without assigning fingerprint", () => {
  const root = activeRoot("attempting");
  const result = receiveNpcReactionCandidate(root, {
    gameSessionId: "session-1", reactionPlanId: "plan-1", reactionAttemptId: "attempt-1"
  });
  assert.equal(result.root.reactionAttempts["attempt-1"].status, "candidate_received");
  assert.equal(result.root.reactionAttempts["attempt-1"].candidateFingerprint, null);
  assert.equal(root.reactionAttempts["attempt-1"].status, "attempting");
});

test("all eight attempt statuses enforce the fingerprint presence matrix", () => {
  for (const status of ["attempting", "candidate_received", "failed", "timed_out"]) {
    assert.doesNotThrow(() => validateNpcReactionCoordinatorRoot(activeRoot(status, null)));
    assert.throws(() => validateNpcReactionCoordinatorRoot(activeRoot(status, FP_A)), invariant());
  }
  for (const status of ["validated"]) {
    assert.doesNotThrow(() => validateNpcReactionCoordinatorRoot(activeRoot(status, FP_A)));
    assert.throws(() => validateNpcReactionCoordinatorRoot(activeRoot(status, null)), invariant());
  }
  for (const status of ["rejected", "aborted"]) {
    assert.doesNotThrow(() => validateNpcReactionCoordinatorRoot(activeRoot(status, null)));
    assert.doesNotThrow(() => validateNpcReactionCoordinatorRoot(activeRoot(status, FP_A)));
  }
  assert.throws(() => validateNpcReactionCoordinatorRoot(activeRoot("accepted", FP_A)), invariant());
});

test("identity conflict maps pre-validation to aborted and validated to rejected", () => {
  for (const [source, fingerprint, expected] of [
    ["attempting", null, "aborted"],
    ["candidate_received", null, "aborted"],
    ["validated", FP_A, "rejected"]
  ]) {
    const root = activeRoot(source, fingerprint);
    const result = terminalizeNpcReactionIdentityConflict(root, { gameSessionId: "session-1", reactionPlanId: "plan-1" });
    assert.equal(result.result.status, "cleaned");
    const summary = result.root.reactionTombstones["plan-1"].attempts[0];
    assert.equal(summary.status, expected);
    assert.equal(summary.observation, fingerprint ? "fingerprinted" : "none");
    if (fingerprint) assert.equal(summary.candidateFingerprint, fingerprint);
    assert.equal(result.root.logicalReactions["plan-1"], undefined);
    assert.equal(result.root.reactionAttempts["attempt-1"], undefined);
  }
});

test("identity conflict preserves terminal attempts and rejects active plus accepted", () => {
  for (const [status, fingerprint] of [
    ["failed", null], ["timed_out", null], ["rejected", null], ["rejected", FP_A], ["aborted", null], ["aborted", FP_A]
  ]) {
    const result = terminalizeNpcReactionIdentityConflict(activeRoot(status, fingerprint), {
      gameSessionId: "session-1", reactionPlanId: "plan-1"
    });
    const summary = result.root.reactionTombstones["plan-1"].attempts[0];
    assert.equal(summary.status, status);
    assert.equal(summary.observation, fingerprint ? "fingerprinted" : "none");
  }
  assert.throws(() => terminalizeNpcReactionIdentityConflict(activeRootUnchecked("accepted", FP_A), {
    gameSessionId: "session-1", reactionPlanId: "plan-1"
  }), invariant());
});

test("committed cleanup transfers maxAttempts and every fingerprint exactly, then is idempotent", () => {
  let root = activeRoot("validated", FP_A, { maxAttempts: 3 });
  const second = attemptFor("plan-1", "attempt-2", { status: "rejected", candidateFingerprint: FP_B });
  root = structuredClone(root);
  root.logicalReactions["plan-1"].attemptIds.push("attempt-2");
  root.reactionAttempts["attempt-2"] = second;
  validateNpcReactionCoordinatorRoot(root);
  const before = structuredClone(root);
  const result = cleanupCommittedNpcReaction(root, {
    gameSessionId: "session-1", reactionPlanId: "plan-1", successfulAttemptId: "attempt-1",
    preparationFingerprint: FP_B, npcPublicationId: "publication-1", commitResultRequestId: "request-1"
  });
  assert.deepEqual(root, before);
  const tombstone = result.root.reactionTombstones["plan-1"];
  assert.equal(tombstone.maxAttempts, 3);
  assert.deepEqual(tombstone.attempts.map(({ reactionAttemptId, status, candidateFingerprint }) => ({
    reactionAttemptId, status, candidateFingerprint
  })), [
    { reactionAttemptId: "attempt-1", status: "accepted", candidateFingerprint: FP_A },
    { reactionAttemptId: "attempt-2", status: "rejected", candidateFingerprint: FP_B }
  ]);
  const repeat = cleanupCommittedNpcReaction(result.root, {
    gameSessionId: "session-1", reactionPlanId: "plan-1", successfulAttemptId: "attempt-1",
    preparationFingerprint: FP_B, npcPublicationId: "publication-1", commitResultRequestId: "request-1"
  });
  assert.deepEqual(repeat.result, { schemaVersion: 1, status: "already_cleaned", reactionPlanId: "plan-1", terminalOrder: 0 });
  assert.equal(repeat.root, result.root);
  for (const conflicting of [
    { successfulAttemptId: "attempt-other" },
    { preparationFingerprint: FP_A },
    { npcPublicationId: "publication-other" },
    { commitResultRequestId: "request-other" }
  ]) {
    assert.throws(() => cleanupCommittedNpcReaction(result.root, {
      gameSessionId: "session-1", reactionPlanId: "plan-1", successfulAttemptId: "attempt-1",
      preparationFingerprint: FP_B, npcPublicationId: "publication-1", commitResultRequestId: "request-1",
      ...conflicting
    }), invariant());
  }
  assert.deepEqual(result.root.reactionTombstones["plan-1"], tombstone);
});

test("non-commit cleanup supports exact retry and rejects conflicting terminal evidence", () => {
  const result = terminalizeNpcReaction(activeRoot("failed"), {
    gameSessionId: "session-1", reactionPlanId: "plan-1", terminalStatus: "exhausted", reason: "retry_exhausted"
  });
  const tombstone = result.root.reactionTombstones["plan-1"];
  assert.doesNotThrow(() => validateReactionTombstone(tombstone));
  assert.equal(tombstone.maxAttempts, 3);
  assert.equal(tombstone.attempts[0].observation, "none");
  const corrupt = structuredClone(tombstone);
  corrupt.maxAttempts = 0;
  assert.throws(() => validateReactionTombstone(corrupt), invariant());
  const repeat = terminalizeNpcReaction(result.root, {
    gameSessionId: "session-1", reactionPlanId: "plan-1", terminalStatus: "exhausted", reason: "retry_exhausted"
  });
  assert.deepEqual(repeat.result, {
    schemaVersion: 1, status: "already_cleaned", reactionPlanId: "plan-1", terminalOrder: 0
  });
  assert.equal(repeat.root, result.root);
  assert.throws(() => terminalizeNpcReaction(result.root, {
    gameSessionId: "session-1", reactionPlanId: "plan-1", terminalStatus: "cancelled", reason: "cancelled"
  }), invariant());
  assert.throws(() => terminalizeNpcReactionIdentityConflict(result.root, {
    gameSessionId: "session-1", reactionPlanId: "plan-1"
  }), invariant());
  assert.deepEqual(result.root.reactionTombstones["plan-1"], tombstone);
});

test("identity-conflict cleanup supports exact retry and rejects other non-commit evidence", () => {
  const result = terminalizeNpcReactionIdentityConflict(activeRoot("validated", FP_A), {
    gameSessionId: "session-1", reactionPlanId: "plan-1"
  });
  const tombstone = structuredClone(result.root.reactionTombstones["plan-1"]);
  const repeat = terminalizeNpcReactionIdentityConflict(result.root, {
    gameSessionId: "session-1", reactionPlanId: "plan-1"
  });
  assert.deepEqual(repeat.result, {
    schemaVersion: 1, status: "already_cleaned", reactionPlanId: "plan-1", terminalOrder: 0
  });
  assert.equal(repeat.root, result.root);
  assert.throws(() => terminalizeNpcReaction(result.root, {
    gameSessionId: "session-1", reactionPlanId: "plan-1", terminalStatus: "rejected", reason: "authorization_failure"
  }), invariant());
  assert.throws(() => cleanupCommittedNpcReaction(result.root, {
    gameSessionId: "session-1", reactionPlanId: "plan-1", successfulAttemptId: "attempt-1",
    preparationFingerprint: FP_B, npcPublicationId: "publication-1", commitResultRequestId: "request-1"
  }), invariant());
  assert.deepEqual(result.root.reactionTombstones["plan-1"], tombstone);
});

test("tombstone schemas reject missing maxAttempts, fake fingerprints, duplicates, and excess attempts", () => {
  const base = nonCommitTombstone("plan-1", 0);
  const missing = structuredClone(base);
  delete missing.maxAttempts;
  assert.throws(() => validateReactionTombstone(missing), invariant());
  const fake = structuredClone(base);
  fake.attempts = [{ schemaVersion: 1, reactionAttemptId: "attempt-1", status: "failed", observation: "fingerprinted", candidateFingerprint: FP_A }];
  assert.throws(() => validateReactionTombstone(fake), invariant());
  const duplicate = structuredClone(base);
  duplicate.maxAttempts = 2;
  duplicate.attempts = [
    { schemaVersion: 1, reactionAttemptId: "attempt-1", status: "failed", observation: "none" },
    { schemaVersion: 1, reactionAttemptId: "attempt-1", status: "failed", observation: "none" }
  ];
  assert.throws(() => validateReactionTombstone(duplicate), invariant());
  const excess = structuredClone(base);
  excess.attempts.push({ schemaVersion: 1, reactionAttemptId: "attempt-2", status: "failed", observation: "none" });
  assert.throws(() => validateReactionTombstone(excess), invariant());
});

test("reset returns a detached empty new-session root and old-session operations are stale", () => {
  const root = activeRoot("validated", FP_A);
  const result = resetNpcReactionCoordinator(root, { gameSessionId: "session-1", newGameSessionId: "session-2" });
  assert.equal(result.root.gameSessionId, "session-2");
  assert.equal(result.root.nextTerminalOrder, 0);
  for (const field of ["logicalReactions", "reactionAttempts", "terminalSlotReservations", "reactionTombstones"]) {
    assert.deepEqual(result.root[field], {});
  }
  assert.throws(() => createNpcReactionAttempt(result.root, {
    gameSessionId: "session-1", attempt: attemptFor("plan-1", "attempt-old", { gameSessionId: "session-1" })
  }), code("coordinator_session_mismatch"));
  assert.deepEqual(destroyNpcReactionCoordinator(result.root, { gameSessionId: "session-2" }), { schemaVersion: 1, status: "destroyed" });
});

test("module has no Node-only imports, random, clock, timers, or global mutable singleton", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/npcReactionCoordinator.mjs", import.meta.url), "utf8"));
  for (const forbidden of ["node:", "Date.now", "Math.random", "randomUUID", "setTimeout", "process.", "Buffer", "globalThis"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

function createdRoot(logical) {
  return createPlannedNpcReaction(createNpcReactionCoordinatorRoot("session-1"), {
    gameSessionId: "session-1", logicalReaction: logical
  }).root;
}

function activeRoot(status, candidateFingerprint = status === "validated" ? FP_A : null, { maxAttempts = 3 } = {}) {
  const root = createdRoot(logicalFor("plan-1", { maxAttempts }));
  const withAttempt = createNpcReactionAttempt(root, {
    gameSessionId: "session-1",
    attempt: attemptFor("plan-1", "attempt-1")
  }).root;
  const changed = structuredClone(withAttempt);
  changed.reactionAttempts["attempt-1"].status = status;
  changed.reactionAttempts["attempt-1"].candidateFingerprint = candidateFingerprint;
  validateNpcReactionCoordinatorRoot(changed);
  return changed;
}

function activeRootUnchecked(status, candidateFingerprint) {
  const root = createdRoot(logicalFor("plan-1"));
  const withAttempt = createNpcReactionAttempt(root, {
    gameSessionId: "session-1", attempt: attemptFor("plan-1", "attempt-1")
  }).root;
  const changed = structuredClone(withAttempt);
  changed.reactionAttempts["attempt-1"].status = status;
  changed.reactionAttempts["attempt-1"].candidateFingerprint = candidateFingerprint;
  return changed;
}

function logicalFor(reactionPlanId, { requestId = `request-${reactionPlanId}`, maxAttempts = 3 } = {}) {
  return {
    schemaVersion: 1,
    gameSessionId: "session-1",
    reactionPlanId,
    requestId,
    requestFingerprint: FP_A,
    correlationId: `correlation-${reactionPlanId}`,
    causationId: `cause-${reactionPlanId}`,
    originatingInputRecordId: `input-${reactionPlanId}`,
    turnId: "turn-1",
    turnOrder: 1,
    preconditionPhase: "player_question",
    preconditionStateVersion: 2,
    npcId: "npc1",
    routeSnapshot: { schemaVersion: 1, route: "structured" },
    projectionFingerprint: FP_B,
    status: "planned",
    attemptIds: [],
    createdAt: "2026-07-16T00:00:00Z",
    retryPolicy: { schemaVersion: 1, maxAttempts, backoffDelaysMs: maxAttempts > 1 ? [1000] : [], logicalDeadlineMs: 15000 }
  };
}

function attemptFor(reactionPlanId, reactionAttemptId, {
  gameSessionId = "session-1", status = "attempting", candidateFingerprint = null
} = {}) {
  return {
    schemaVersion: 1,
    pendingType: "npc_reaction",
    gameSessionId,
    requestId: `request-${reactionPlanId}`,
    requestFingerprint: FP_A,
    correlationId: `correlation-${reactionPlanId}`,
    causationId: `cause-${reactionPlanId}`,
    reactionPlanId,
    reactionAttemptId,
    originatingInputRecordId: `input-${reactionPlanId}`,
    turnId: "turn-1",
    turnOrder: 1,
    preconditionStateVersion: 2,
    preconditionPhase: "player_question",
    targetNpcId: "npc1",
    operation: "generate_npc_reaction_candidate",
    status,
    candidateFingerprint,
    startedAt: "2026-07-16T00:00:01Z"
  };
}

function reservationFor(reactionPlanId, terminalOrder) {
  return {
    schemaVersion: 1,
    reservationType: "reaction_terminal_slot",
    gameSessionId: "session-1",
    reactionPlanId,
    terminalOrder,
    status: "reserved"
  };
}

function nonCommitTombstone(reactionPlanId, terminalOrder) {
  return {
    schemaVersion: 1,
    tombstoneType: "non_commit",
    gameSessionId: "session-1",
    reactionPlanId,
    requestId: `request-${reactionPlanId}`,
    requestFingerprint: FP_A,
    correlationId: `correlation-${reactionPlanId}`,
    causationId: `cause-${reactionPlanId}`,
    originatingInputRecordId: `input-${reactionPlanId}`,
    npcId: "npc1",
    preconditionStateVersion: 2,
    terminalStatus: "exhausted",
    terminalOrder,
    maxAttempts: 1,
    attempts: [{ schemaVersion: 1, reactionAttemptId: `attempt-${reactionPlanId}`, status: "failed", observation: "none" }],
    reason: "retry_exhausted"
  };
}

function invariant() {
  return (error) => error instanceof NpcReactionCoordinatorInvariantError;
}

function code(expected) {
  return (error) => error instanceof NpcReactionCoordinatorInvariantError && error.code === expected;
}
