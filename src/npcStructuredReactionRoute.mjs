import { ID_PATTERN } from "./conversation/domain.mjs";
import {
  createLogicalReactionFoundation,
  createReactionAttemptFoundation
} from "./npcReactionFoundation.mjs";
import {
  NPC_REACTION_MAX_ATTEMPTS,
  cleanupCommittedNpcReaction,
  createNpcReactionAttempt,
  createNpcReactionCoordinatorRoot,
  createPlannedNpcReaction,
  destroyNpcReactionCoordinator,
  observeNpcReactionCandidate,
  receiveNpcReactionCandidate,
  terminalizeNpcReaction,
  terminalizeNpcReactionAttempt,
  validateNpcReactionCoordinatorRoot
} from "./npcReactionCoordinator.mjs";
import {
  NPC_REACTION_CANDIDATE_PROVIDER_ERROR_CODES,
  NpcReactionCandidateProviderError
} from "./npcReactionCandidateProvider.mjs";
import { validateNpcReactionCandidate } from "./npcReactionCandidateValidation.mjs";
import { prepareNpcReaction } from "./npcReactionPreparation.mjs";
import { validateNpcStructuredReactionAuthoritySnapshot } from "./npcStructuredReactionAuthorityPort.mjs";
import {
  buildNpcStructuredLiveApplicability,
  buildNpcStructuredLogicalReaction,
  buildNpcStructuredPendingAttempt,
  buildNpcStructuredPreCommitReferenceContext,
  buildNpcStructuredPreparationInput,
  buildNpcStructuredProviderRequest,
  buildNpcStructuredValidationPending,
  createNpcStructuredRoutePolicy,
  sameNpcStructuredSnapshotBinding
} from "./npcStructuredReactionRouteBuilders.mjs";

export const NPC_STRUCTURED_REACTION_ROUTE_ERROR_CODES = Object.freeze([
  "invalid_npc_structured_route_configuration",
  "invalid_npc_structured_route_trigger",
  "stale_npc_structured_route_session",
  "npc_structured_route_reset",
  "npc_structured_reaction_not_active",
  "npc_structured_cleanup_not_pending",
  "npc_structured_route_operation_in_progress"
]);

export const NPC_STRUCTURED_REACTION_ROUTE_INVARIANT_CODES = Object.freeze([
  "invalid_npc_structured_route_state",
  "invalid_npc_structured_authority_read_result",
  "invalid_npc_structured_authority_snapshot",
  "invalid_npc_structured_authority_commit_result",
  "invalid_npc_structured_route_clock",
  "invalid_npc_structured_route_timer",
  "invalid_npc_structured_route_builder",
  "invalid_npc_structured_candidate_transport",
  "npc_structured_route_identity_collision",
  "npc_structured_route_order_exhausted",
  "invalid_npc_structured_cross_root_graph"
]);

const ROUTE_MESSAGE = "NPC structured reaction route failed.";
const INVARIANT_MESSAGE = "NPC structured reaction route invariant failed.";
const TRIGGER_FIELDS = Object.freeze([
  "schemaVersion", "gameSessionId", "triggerRequestId", "originatingInputRecordId"
]);
const CLEANUP_FIELDS = Object.freeze(["schemaVersion", "gameSessionId", "reactionPlanId"]);
const FACTORY_FIELDS = Object.freeze([
  "gameSessionId", "createId", "nowUtc", "nowMonotonicMs", "scheduleTimer", "cancelTimer",
  "createAbortController", "authorityPort", "candidateTransport", "observer"
]);
const AUTHORITY_FIELDS = Object.freeze([
  "readNpcStructuredReactionSnapshot", "commitPreparedNpcReactionAtomically"
]);
const TRANSPORT_FIELDS = Object.freeze(["generateCandidateTransport"]);
const RETRYABLE_PROVIDER_CODES = new Set(["timeout", "network_failure", "provider_unavailable"]);

export class NpcStructuredReactionRouteError extends Error {
  constructor(code = "invalid_npc_structured_route_configuration") {
    super(ROUTE_MESSAGE);
    Object.defineProperty(this, "name", { value: "NpcStructuredReactionRouteError", writable: true });
    Object.defineProperty(this, "code", { value: NPC_STRUCTURED_REACTION_ROUTE_ERROR_CODES.includes(code)
      ? code : "invalid_npc_structured_route_configuration" });
  }
}

export class NpcStructuredReactionRouteInvariantError extends Error {
  constructor(code = "invalid_npc_structured_route_state") {
    super(INVARIANT_MESSAGE);
    Object.defineProperty(this, "name", { value: "NpcStructuredReactionRouteInvariantError", writable: true });
    Object.defineProperty(this, "code", { value: NPC_STRUCTURED_REACTION_ROUTE_INVARIANT_CODES.includes(code)
      ? code : "invalid_npc_structured_route_state" });
  }
}

export function createNpcStructuredReactionRoute(configuration = {}) {
  const dependencies = reconstructConfiguration(configuration);
  const {
    gameSessionId, createId, nowUtc, nowMonotonicMs, scheduleTimer, cancelTimer,
    createAbortController, authorityPort, candidateTransport, observer
  } = dependencies;
  let coordinatorRoot = createNpcReactionCoordinatorRoot(gameSessionId);
  let active = null;
  let generation = 0;
  let reset = false;
  let nextObservationRuntimeOrder = 0;
  let observerExhausted = false;
  const pendingCleanup = new Map();
  const completedCleanup = new Map();
  const terminalResults = new Map();

  async function executeStructuredReaction(input) {
    assertLive();
    const trigger = reconstructTrigger(input);
    assertSession(trigger.gameSessionId);
    if (active) return inProgress(trigger, active);
    const firstRead = readAuthority(trigger);
    if (firstRead.status === "replayed") return replayResult(trigger, firstRead);
    if (firstRead.status === "conflict") return conflictResult(trigger, firstRead);
    const snapshot = validateSnapshot(firstRead);

    let operation;
    try {
      const policy = createNpcStructuredRoutePolicy();
      const foundation = createLogicalReactionFoundation({
        gameSessionId,
        triggerRequestId: trigger.triggerRequestId,
        inputRecordId: trigger.originatingInputRecordId,
        turnId: snapshot.turnId,
        turnOrder: snapshot.turnOrder,
        phase: snapshot.currentPhase,
        actorId: snapshot.targetNpcId,
        baseStateVersion: snapshot.stateVersion,
        createId
      });
      if (snapshot.occupiedArtifactIds.includes(foundation.reactionPlanId)
        || snapshot.occupiedArtifactIds.includes(foundation.requestId)
        || foundation.reactionPlanId === foundation.requestId) {
        throw invariant("npc_structured_route_identity_collision");
      }
      const logical = buildNpcStructuredLogicalReaction({
        foundation: { ...foundation, correlationId: snapshot.originatingInputRecord.correlationId },
        snapshot, createdAt: checkedNowUtc(nowUtc), policy
      });
      const planned = createPlannedNpcReaction(coordinatorRoot, { gameSessionId, logicalReaction: logical });
      if (planned.status === "rejected") {
        return routeResult(trigger, "rejected", { stage: "planning", reason: "ordering_failure" });
      }
      coordinatorRoot = planned.root;
      operation = {
        generation: ++generation,
        trigger,
        snapshot,
        logical,
        policy,
        attemptCount: 0,
        currentAttemptId: null,
        abortController: null,
        deadlineTimer: null,
        backoffTimer: null,
        deadlineAt: checkedDeadline(nowMonotonicMs, policy.retryPolicy.logicalDeadlineMs),
        winner: null,
        result: null
      };
      active = operation;
      operation.deadlineTimer = armTimer(operation, "deadline", policy.retryPolicy.logicalDeadlineMs, () => winDeadline(operation));
      observe(operation, "planning", "created", "planned", null);
    } catch (error) {
      if (error instanceof NpcStructuredReactionRouteError || error instanceof NpcStructuredReactionRouteInvariantError) throw error;
      throw invariant(classifyBuilderError(error));
    }
    try {
      const result = await runAttempts(operation);
      rememberTerminal(operation, result);
      return result;
    } finally {
      if (active === operation && operation.winner) active = null;
      clearOperationTimers(operation);
      operation.abortController = null;
      operation.snapshot = null;
    }
  }

  function cancelStructuredReaction(input) {
    assertLive();
    const trigger = reconstructTrigger(input);
    assertSession(trigger.gameSessionId);
    if (!active || !sameTrigger(active.trigger, trigger)) {
      const cached = terminalResults.get(triggerKey(trigger));
      if (cached?.status === "cancelled") return cached;
      throw routeError("npc_structured_reaction_not_active");
    }
    return cancelOperation(active, "cancelled", "cancellation", "cancelled");
  }

  function retryPendingCoordinatorCleanup(input) {
    assertLive();
    const request = reconstructExact(input, CLEANUP_FIELDS, "invalid_npc_structured_route_trigger");
    if (request.schemaVersion !== 1 || !isId(request.gameSessionId) || !isId(request.reactionPlanId)) {
      throw routeError("invalid_npc_structured_route_trigger");
    }
    assertSession(request.gameSessionId);
    const pending = pendingCleanup.get(request.reactionPlanId);
    if (!pending) {
      const completed = completedCleanup.get(request.reactionPlanId);
      if (!completed) throw routeError("npc_structured_cleanup_not_pending");
      const replay = readAuthority(completed.trigger);
      if (replay.status !== "replayed" || replay.logicalIdentity.reactionPlanId !== request.reactionPlanId) {
        throw invariant("invalid_npc_structured_cross_root_graph");
      }
      let cleaned;
      try { cleaned = cleanupCommittedNpcReaction(coordinatorRoot, completed.handoff); }
      catch { throw invariant("invalid_npc_structured_cross_root_graph"); }
      if (cleaned.result.status !== "already_cleaned") {
        throw invariant("invalid_npc_structured_cross_root_graph");
      }
      coordinatorRoot = cleaned.root;
      return freeze({ schemaVersion: 1, status: "already_cleaned", reactionPlanId: request.reactionPlanId });
    }
    const replay = readAuthority(pending.trigger);
    if (replay.status !== "replayed" || replay.logicalIdentity.reactionPlanId !== request.reactionPlanId) {
      throw invariant("invalid_npc_structured_cross_root_graph");
    }
    let cleaned;
    try { cleaned = cleanupCommittedNpcReaction(coordinatorRoot, pending.handoff); }
    catch { throw invariant("invalid_npc_structured_cross_root_graph"); }
    coordinatorRoot = cleaned.root;
    pendingCleanup.delete(request.reactionPlanId);
    completedCleanup.set(request.reactionPlanId, pending);
    observe(pending.observationIdentity, "cleanup", cleaned.result.status, "cleanup_retry", null);
    return freeze({ schemaVersion: 1, status: cleaned.result.status, reactionPlanId: request.reactionPlanId });
  }

  function resetRoute() {
    if (reset) return undefined;
    reset = true;
    generation += 1;
    const operation = active;
    if (operation && !operation.winner) cancelOperation(operation, "cancelled", "reset", "cancelled");
    try { destroyNpcReactionCoordinator(coordinatorRoot, { gameSessionId }); } catch {}
    active = null;
    pendingCleanup.clear();
    completedCleanup.clear();
    terminalResults.clear();
    observerExhausted = true;
    return undefined;
  }

  async function runAttempts(operation) {
    while (!operation.winner && operation.attemptCount < operation.policy.retryPolicy.maxAttempts
      && operation.attemptCount < NPC_REACTION_MAX_ATTEMPTS) {
      if (!hasAttemptBudget(operation, operation.attemptCount === 0 ? 0
        : operation.policy.retryPolicy.backoffDelaysMs[operation.attemptCount - 1])) {
        return exhaust(operation, "deadline", "retry_exhausted");
      }
      if (operation.attemptCount > 0) {
        const delay = operation.policy.retryPolicy.backoffDelaysMs[operation.attemptCount - 1];
        const continued = await waitBackoff(operation, delay);
        if (!continued || operation.winner) return operation.result;
      }
      const outcome = await runOneAttempt(operation);
      if (operation.winner) return operation.result;
      if (outcome.retry !== true) return outcome.result;
    }
    return exhaust(operation, "provider", "retry_exhausted");
  }

  async function runOneAttempt(operation) {
    operation.attemptCount += 1;
    let attemptFoundation;
    let attempt;
    let request;
    try {
      attemptFoundation = createReactionAttemptFoundation({
        schemaVersion: 1,
        reactionPlanId: operation.logical.reactionPlanId,
        requestId: operation.logical.requestId,
        correlationId: operation.logical.correlationId,
        gameSessionId: operation.logical.gameSessionId,
        causationId: operation.logical.causationId,
        originatingInputRecordId: operation.logical.originatingInputRecordId,
        turnId: operation.logical.turnId,
        turnOrder: operation.logical.turnOrder,
        preconditionPhase: operation.logical.preconditionPhase,
        preconditionStateVersion: operation.logical.preconditionStateVersion,
        npcId: operation.logical.npcId,
        status: "active"
      }, createId);
      attempt = buildNpcStructuredPendingAttempt(operation.logical, attemptFoundation, checkedNowUtc(nowUtc));
      if (operation.snapshot.occupiedArtifactIds.includes(attempt.reactionAttemptId)
        || [operation.logical.reactionPlanId, operation.logical.requestId, operation.logical.correlationId]
          .includes(attempt.reactionAttemptId)) {
        throw invariant("npc_structured_route_identity_collision");
      }
      const created = createNpcReactionAttempt(coordinatorRoot, { gameSessionId, attempt });
      coordinatorRoot = created.root;
      operation.currentAttemptId = attempt.reactionAttemptId;
      operation.abortController = createCheckedAbortController(createAbortController);
      request = buildNpcStructuredProviderRequest(operation.logical, attempt.reactionAttemptId, operation.snapshot.knownInformationProjection);
    } catch (error) {
      if (error instanceof NpcStructuredReactionRouteInvariantError) throw error;
      return terminalFailure(operation, "rejected", "internal_failure", "planning", "invalid_builder");
    }
    observe(operation, "provider", "started", "attempt_started", attempt.reactionAttemptId);
    let transport;
    try {
      transport = await candidateTransport.generateCandidateTransport(request, { signal: operation.abortController.signal });
    } catch (error) {
      if (operation.winner || !isCurrent(operation)) return { retry: false, result: operation.result };
      const normalized = normalizeProviderFailure(error);
      coordinatorRoot = terminalizeNpcReactionAttempt(coordinatorRoot, {
        gameSessionId, reactionPlanId: operation.logical.reactionPlanId,
        reactionAttemptId: attempt.reactionAttemptId,
        terminalStatus: normalized.code === "timeout" ? "timed_out" : normalized.code === "aborted" ? "aborted" : "failed"
      }).root;
      observe(operation, "provider", "failed", normalized.code, attempt.reactionAttemptId);
      if (normalized.retryable && mayRetry(operation)) return { retry: true };
      return terminalFailure(operation, "exhausted", "retry_exhausted", "provider", normalized.code);
    }
    if (operation.winner || !isCurrent(operation)) return { retry: false, result: operation.result };
    let evidence;
    try { evidence = validateTransportResult(transport); }
    catch {
      return terminalFailure(operation, "rejected", "internal_failure", "provider", "invalid_transport", "failed");
    }
    coordinatorRoot = receiveNpcReactionCandidate(coordinatorRoot, {
      gameSessionId, reactionPlanId: operation.logical.reactionPlanId, reactionAttemptId: attempt.reactionAttemptId
    }).root;

    const fresh = readAuthority(operation.trigger);
    if (fresh.status === "replayed") return convergeReplay(operation, fresh, attempt.reactionAttemptId);
    if (fresh.snapshotType !== "npc_structured_reaction_authority" || !sameNpcStructuredSnapshotBinding(operation.snapshot, fresh)) {
      return terminalFailure(operation, "superseded", "stale_applicability", "candidate_validation", "stale_request", "aborted");
    }
    let validation;
    try {
      validation = validateNpcReactionCandidate({
        schemaVersion: 1,
        request,
        pendingAttempt: buildNpcStructuredValidationPending(attempt),
        transportEvidence: evidence.transportEvidence,
        observedCandidate: { schemaVersion: 1, observationStatus: "none" },
        liveApplicability: buildNpcStructuredLiveApplicability({
          snapshot: fresh, logical: operation.logical, attempt, attemptStatus: "candidate_received"
        })
      });
    } catch {
      return terminalFailure(operation, "rejected", "internal_failure", "candidate_validation", "validation_invariant", "rejected");
    }
    if (validation.status !== "validated") {
      return terminalFailure(operation, "rejected", validationReason(validation), "candidate_validation", validation.rejection.reasonCode, "rejected");
    }
    coordinatorRoot = observeNpcReactionCandidate(coordinatorRoot, {
      gameSessionId, reactionPlanId: operation.logical.reactionPlanId,
      reactionAttemptId: attempt.reactionAttemptId,
      candidateFingerprint: validation.value.candidateFingerprint
    }).root;
    observe(operation, "candidate_validation", "validated", "validated", attempt.reactionAttemptId);

    const preparationRead = readAuthority(operation.trigger);
    if (preparationRead.status === "replayed") return convergeReplay(operation, preparationRead, attempt.reactionAttemptId);
    if (preparationRead.snapshotType !== "npc_structured_reaction_authority" || !sameNpcStructuredSnapshotBinding(operation.snapshot, preparationRead)) {
      return terminalFailure(operation, "superseded", "stale_applicability", "preparation", "stale_request", "aborted");
    }
    let prepared;
    try {
      const preparationInput = buildNpcStructuredPreparationInput({
        validatedCandidate: validation.value,
        snapshot: preparationRead,
        logical: operation.logical,
        attempt,
        createId
      });
      prepared = prepareNpcReaction(preparationInput);
    } catch (error) {
      return terminalFailure(operation, "rejected", preparationInvariantReason(error), "preparation", "internal_failure", "rejected");
    }
    if (prepared.status !== "prepared") {
      return terminalFailure(operation, preparationStatus(prepared), preparationReason(prepared), "preparation", prepared.rejection.reasonCode, "rejected");
    }
    observe(operation, "preparation", "prepared", "prepared", attempt.reactionAttemptId);
    const preCommitReferenceContext = buildNpcStructuredPreCommitReferenceContext(prepared.value, validation.value);
    let committed;
    try {
      committed = authorityPort.commitPreparedNpcReactionAtomically({
        schemaVersion: 1,
        gameSessionId,
        expectedStateVersion: preparationRead.stateVersion,
        preparedReaction: prepared.value,
        coordinatorRoot,
        preCommitReferenceContext
      });
    } catch {
      return terminalFailure(operation, "rejected", "internal_failure", "commit", "commit_invariant", "rejected");
    }
    return handleCommitResult(operation, committed, attempt.reactionAttemptId);
  }

  function handleCommitResult(operation, value, attemptId) {
    if (!isPlain(value) || value.schemaVersion !== 1 || typeof value.status !== "string") {
      throw invariant("invalid_npc_structured_authority_commit_result");
    }
    if (value.status === "conflict") {
      return terminalFailure(operation, "superseded", "stale_applicability", "commit", "state_conflict", "aborted");
    }
    if (value.status === "replayed") {
      return convergeReplay(operation, {
        schemaVersion: 1,
        status: "replayed",
        gameSessionId,
        triggerRequestId: operation.trigger.triggerRequestId,
        originatingInputRecordId: operation.trigger.originatingInputRecordId,
        logicalIdentity: {
          gameSessionId,
          reactionPlanId: operation.logical.reactionPlanId,
          requestId: operation.logical.requestId,
          requestFingerprint: operation.logical.requestFingerprint,
          originatingInputRecordId: operation.logical.originatingInputRecordId,
          turnId: operation.logical.turnId,
          turnOrder: operation.logical.turnOrder,
          npcId: operation.logical.npcId
        },
        result: value.result
      }, attemptId);
    }
    if (value.status === "rejected") {
      const reason = commitReason(value.rejection?.reasonCode);
      const status = reason === "stale_applicability" ? "superseded" : "rejected";
      return terminalFailure(operation, status, reason, "commit", value.rejection?.reasonCode ?? "internal_failure", status === "superseded" ? "aborted" : "rejected");
    }
    if (value.status !== "committed" || !isPlain(value.result) || !isPlain(value.coordinatorCleanupHandoff)) {
      throw invariant("invalid_npc_structured_authority_commit_result");
    }
    operation.winner = "committed";
    operation.abortController = null;
    let cleanup;
    try {
      cleanup = cleanupCommittedNpcReaction(coordinatorRoot, value.coordinatorCleanupHandoff);
      coordinatorRoot = cleanup.root;
      completedCleanup.set(operation.logical.reactionPlanId, freeze({
        trigger: clone(operation.trigger),
        handoff: clone(value.coordinatorCleanupHandoff),
        observationIdentity: {
          trigger: clone(operation.trigger),
          logical: { reactionPlanId: operation.logical.reactionPlanId }
        }
      }));
    } catch {
      pendingCleanup.set(operation.logical.reactionPlanId, freeze({
        trigger: clone(operation.trigger),
        handoff: clone(value.coordinatorCleanupHandoff),
        observationIdentity: {
          trigger: clone(operation.trigger),
          logical: { reactionPlanId: operation.logical.reactionPlanId }
        }
      }));
      operation.result = routeResult(operation.trigger, "committed_cleanup_pending", {
        reactionPlanId: operation.logical.reactionPlanId,
        requestId: operation.logical.requestId,
        attemptCount: operation.attemptCount,
        commitResult: clone(value.result),
        cleanupStatus: "pending"
      });
      observe(operation, "cleanup", "pending", "cleanup_failed", attemptId);
      return { retry: false, result: operation.result };
    }
    operation.result = routeResult(operation.trigger, "committed", {
      reactionPlanId: operation.logical.reactionPlanId,
      requestId: operation.logical.requestId,
      attemptCount: operation.attemptCount,
      commitResult: clone(value.result)
    });
    observe(operation, "cleanup", cleanup.result.status, "committed", attemptId);
    return { retry: false, result: operation.result };
  }

  function convergeReplay(operation, read, attemptId) {
    if (operation.winner) return { retry: false, result: operation.result };
    operation.winner = "replayed";
    operation.abortController?.abort();
    operation.result = replayResult(operation.trigger, read);
    observe(operation, "commit", "replayed", "authoritative_replay", attemptId);
    return { retry: false, result: operation.result };
  }

  function terminalFailure(operation, status, reason, stage, code, attemptTerminalStatus = null) {
    if (operation.winner) return { retry: false, result: operation.result };
    try {
      if (attemptTerminalStatus && operation.currentAttemptId) {
        coordinatorRoot = terminalizeNpcReactionAttempt(coordinatorRoot, {
          gameSessionId, reactionPlanId: operation.logical.reactionPlanId,
          reactionAttemptId: operation.currentAttemptId, terminalStatus: attemptTerminalStatus
        }).root;
      }
      coordinatorRoot = terminalizeNpcReaction(coordinatorRoot, {
        gameSessionId,
        reactionPlanId: operation.logical.reactionPlanId,
        terminalStatus: status,
        reason
      }).root;
    } catch { throw invariant("invalid_npc_structured_cross_root_graph"); }
    operation.winner = status;
    operation.abortController?.abort();
    operation.result = routeResult(operation.trigger, status, {
      reactionPlanId: operation.logical.reactionPlanId,
      requestId: operation.logical.requestId,
      attemptCount: operation.attemptCount,
      stage,
      reason
    });
    observe(operation, stage, status, code, operation.currentAttemptId);
    return { retry: false, result: operation.result };
  }

  function exhaust(operation, stage, reason) {
    return terminalFailure(operation, "exhausted", reason, stage, reason,
      operation.currentAttemptId && coordinatorRoot.reactionAttempts[operation.currentAttemptId]
        && !["failed", "timed_out", "rejected", "aborted"].includes(coordinatorRoot.reactionAttempts[operation.currentAttemptId].status)
        ? "timed_out" : null).result;
  }

  function winDeadline(operation) {
    if (!isCurrent(operation) || operation.winner) return;
    const now = checkedMonotonic(nowMonotonicMs);
    if (now < operation.deadlineAt) {
      operation.deadlineTimer = armTimer(operation, "deadline", operation.deadlineAt - now, () => winDeadline(operation));
      return;
    }
    terminalFailure(operation, "exhausted", "retry_exhausted", "deadline", "logical_deadline",
      operation.currentAttemptId && coordinatorRoot.reactionAttempts[operation.currentAttemptId]
        && ["attempting"].includes(coordinatorRoot.reactionAttempts[operation.currentAttemptId].status) ? "timed_out"
        : operation.currentAttemptId && coordinatorRoot.reactionAttempts[operation.currentAttemptId]
          && ["candidate_received", "validated"].includes(coordinatorRoot.reactionAttempts[operation.currentAttemptId].status) ? "aborted" : null);
  }

  function cancelOperation(operation, status, stage, reason) {
    if (operation.winner) throw routeError("npc_structured_reaction_not_active");
    generation += 1;
    const attempt = operation.currentAttemptId ? coordinatorRoot.reactionAttempts[operation.currentAttemptId] : null;
    const terminal = attempt && !["failed", "timed_out", "rejected", "aborted"].includes(attempt.status) ? "aborted" : null;
    const result = terminalFailure(operation, status, reason, stage, reason, terminal).result;
    clearOperationTimers(operation);
    operation.abortController?.abort();
    active = null;
    rememberTerminal(operation, result);
    return result;
  }

  function waitBackoff(operation, delay) {
    return new Promise((resolve) => {
      if (!isCurrent(operation) || operation.winner) return resolve(false);
      operation.backoffTimer = armTimer(operation, "backoff", delay, () => {
        operation.backoffTimer = null;
        resolve(isCurrent(operation) && !operation.winner);
      });
    });
  }

  function armTimer(operation, kind, delay, callback) {
    if (!Number.isFinite(delay) || delay < 0) throw invariant("invalid_npc_structured_route_timer");
    let published = false;
    let invalidated = false;
    let pending = false;
    let handle;
    const expectedGeneration = operation.generation;
    const wrapped = () => {
      if (invalidated || operation.generation !== expectedGeneration || operation.winner || !isCurrent(operation)) return;
      if (!published) { pending = true; return; }
      callback();
    };
    try { handle = scheduleTimer(wrapped, delay); }
    catch { invalidated = true; throw invariant("invalid_npc_structured_route_timer"); }
    if (handle === undefined || handle === null) { invalidated = true; throw invariant("invalid_npc_structured_route_timer"); }
    const gate = { kind, handle, invalidate() { invalidated = true; } };
    published = true;
    if (pending) queueMicrotask(wrapped);
    return gate;
  }

  function clearOperationTimers(operation) {
    for (const field of ["deadlineTimer", "backoffTimer"]) {
      const gate = operation?.[field];
      if (!gate) continue;
      gate.invalidate();
      try { cancelTimer(gate.handle); } catch {}
      operation[field] = null;
    }
  }

  function readAuthority(trigger) {
    let result;
    try { result = authorityPort.readNpcStructuredReactionSnapshot(clone(trigger)); }
    catch (error) {
      if (error?.name === "NpcStructuredReactionAuthorityPortInvariantError") throw error;
      throw invariant("invalid_npc_structured_authority_read_result");
    }
    return validateReadResult(result, trigger);
  }

  function validateReadResult(value, trigger) {
    if (!isPlain(value) || value.schemaVersion !== 1) throw invariant("invalid_npc_structured_authority_read_result");
    if (value.status === undefined) {
      validateSnapshot(value);
      return value;
    }
    if (value.status === "replayed") {
      exact(value, ["schemaVersion", "status", "gameSessionId", "triggerRequestId", "originatingInputRecordId", "logicalIdentity", "result"]);
      if (value.gameSessionId !== gameSessionId || value.triggerRequestId !== trigger.triggerRequestId
        || value.originatingInputRecordId !== trigger.originatingInputRecordId || !isPlain(value.logicalIdentity)
        || !isPlain(value.result)) throw invariant("invalid_npc_structured_authority_read_result");
      return value;
    }
    if (value.status === "conflict") {
      exact(value, ["schemaVersion", "status", "gameSessionId", "triggerRequestId", "originatingInputRecordId", "code"]);
      if (!["trigger_identity_conflict", "request_identity_conflict", "reaction_identity_conflict", "committed_graph_conflict", "stale_trigger"].includes(value.code)) {
        throw invariant("invalid_npc_structured_authority_read_result");
      }
      return value;
    }
    throw invariant("invalid_npc_structured_authority_read_result");
  }

  function validateSnapshot(value) {
    try { validateNpcStructuredReactionAuthoritySnapshot(value); }
    catch { throw invariant("invalid_npc_structured_authority_snapshot"); }
    return value;
  }

  function validateTransportResult(value) {
    try {
      exact(value, ["schemaVersion", "status", "transportEvidence"]);
      if (value.schemaVersion !== 1 || value.status !== "success") throw new TypeError();
      const evidence = value.transportEvidence;
      exact(evidence, ["schemaVersion", "evidenceType", "httpStatus", "contentTypeHeader", "contentEncodingHeader", "bodyBytes"]);
      if (evidence.schemaVersion !== 1 || evidence.evidenceType !== "npc_reaction_candidate_http_success"
        || evidence.httpStatus !== 200 || !(evidence.bodyBytes instanceof Uint8Array)) throw new TypeError();
      return { transportEvidence: {
        ...clone(evidence), bodyBytes: new Uint8Array(evidence.bodyBytes)
      } };
    } catch { throw invariant("invalid_npc_structured_candidate_transport"); }
  }

  function hasAttemptBudget(operation, backoff) {
    const remaining = operation.deadlineAt - checkedMonotonic(nowMonotonicMs);
    return remaining >= backoff + 1000 + 500;
  }

  function mayRetry(operation) {
    return operation.attemptCount < operation.policy.retryPolicy.maxAttempts
      && operation.attemptCount < NPC_REACTION_MAX_ATTEMPTS
      && hasAttemptBudget(operation, operation.policy.retryPolicy.backoffDelaysMs[operation.attemptCount - 1] ?? 0);
  }

  function normalizeProviderFailure(error) {
    if (error instanceof NpcReactionCandidateProviderError
      && NPC_REACTION_CANDIDATE_PROVIDER_ERROR_CODES.includes(error.code)) {
      return { code: error.code, retryable: error.retryable === true && RETRYABLE_PROVIDER_CODES.has(error.code) };
    }
    if (isPlain(error) && NPC_REACTION_CANDIDATE_PROVIDER_ERROR_CODES.includes(error.code)) {
      return { code: error.code, retryable: error.retryable === true && RETRYABLE_PROVIDER_CODES.has(error.code) };
    }
    return { code: "provider_unavailable", retryable: false };
  }

  function observe(operation, stage, outcome, code, attemptId) {
    if (observerExhausted || typeof observer !== "function") return;
    const runtimeOrder = nextObservationRuntimeOrder;
    if (runtimeOrder === Number.MAX_SAFE_INTEGER) observerExhausted = true;
    else nextObservationRuntimeOrder += 1;
    const observation = freeze({
      schemaVersion: 1,
      observationType: "npc_structured_reaction_route",
      gameSessionId,
      triggerRequestId: operation?.trigger?.triggerRequestId ?? "unavailable",
      originatingInputRecordId: operation?.trigger?.originatingInputRecordId ?? "unavailable",
      reactionPlanId: operation?.logical?.reactionPlanId ?? null,
      reactionAttemptId: attemptId ?? null,
      stage,
      outcome,
      code,
      runtimeOrder
    });
    try { observer(observation); } catch {}
  }

  function rememberTerminal(operation, result) {
    if (!result) return;
    terminalResults.set(triggerKey(operation.trigger), result);
    while (terminalResults.size > 100) terminalResults.delete(terminalResults.keys().next().value);
  }

  function replayResult(trigger, read) {
    return routeResult(trigger, "replayed", {
      reactionPlanId: read.logicalIdentity.reactionPlanId,
      requestId: read.logicalIdentity.requestId,
      commitResult: clone(read.result)
    });
  }

  function conflictResult(trigger, read) {
    if (read.code === "committed_graph_conflict") throw invariant("invalid_npc_structured_cross_root_graph");
    return routeResult(trigger, read.code === "stale_trigger" ? "superseded" : "rejected", {
      stage: "preflight",
      reason: read.code === "stale_trigger" ? "stale_applicability" : "identity_conflict"
    });
  }

  function inProgress(trigger, operation) {
    return routeResult(trigger, "in_progress", {
      activeReactionPlanId: operation.logical.reactionPlanId,
      activeRequestId: operation.logical.requestId
    });
  }

  function routeResult(trigger, status, fields) {
    return freeze({
      schemaVersion: 1,
      resultType: "npc_structured_reaction_route",
      gameSessionId,
      triggerRequestId: trigger.triggerRequestId,
      originatingInputRecordId: trigger.originatingInputRecordId,
      status,
      ...clone(fields)
    });
  }

  function assertLive() { if (reset) throw routeError("npc_structured_route_reset"); }
  function assertSession(value) { if (value !== gameSessionId) throw routeError("stale_npc_structured_route_session"); }
  function isCurrent(operation) { return active === operation && operation.generation === generation && !reset; }
  function sameTrigger(a, b) { return a.triggerRequestId === b.triggerRequestId && a.originatingInputRecordId === b.originatingInputRecordId; }
  function triggerKey(value) { return `${value.triggerRequestId}\0${value.originatingInputRecordId}`; }

  return freeze({
    executeStructuredReaction,
    cancelStructuredReaction,
    retryPendingCoordinatorCleanup,
    reset: resetRoute
  });
}

function reconstructConfiguration(value) {
  try {
    const result = reconstructExact(value, FACTORY_FIELDS);
    if (!isId(result.gameSessionId)) throw new TypeError();
    for (const field of ["createId", "nowUtc", "nowMonotonicMs", "scheduleTimer", "cancelTimer", "createAbortController"]) {
      if (typeof result[field] !== "function") throw new TypeError();
    }
    reconstructFunctionSurface(result.authorityPort, AUTHORITY_FIELDS);
    reconstructFunctionSurface(result.candidateTransport, TRANSPORT_FIELDS);
    if (result.observer !== null && typeof result.observer !== "function") throw new TypeError();
    return result;
  } catch { throw routeError("invalid_npc_structured_route_configuration"); }
}

function reconstructFunctionSurface(value, fields) {
  const result = reconstructExact(value, fields);
  if (fields.some((field) => typeof result[field] !== "function")) throw new TypeError();
  return result;
}

function reconstructTrigger(value) {
  try {
    const result = reconstructExact(value, TRIGGER_FIELDS);
    if (result.schemaVersion !== 1 || !isId(result.gameSessionId)
      || !isId(result.triggerRequestId) || !isId(result.originatingInputRecordId)) throw new TypeError();
    return freeze(result);
  } catch { throw routeError("invalid_npc_structured_route_trigger"); }
}

function reconstructExact(value, fields, code) {
  if (!isPlain(value)) throw code ? routeError(code) : new TypeError();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    throw code ? routeError(code) : new TypeError();
  }
  const result = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw code ? routeError(code) : new TypeError();
    result[field] = descriptor.value;
  }
  return result;
}

function exact(value, fields) {
  reconstructExact(value, fields);
}

function checkedNowUtc(nowUtc) {
  const value = nowUtc();
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw invariant("invalid_npc_structured_route_clock");
  }
  return value;
}

function checkedMonotonic(nowMonotonicMs) {
  const value = nowMonotonicMs();
  if (!Number.isSafeInteger(value) || value < 0) throw invariant("invalid_npc_structured_route_clock");
  return value;
}

function checkedDeadline(nowMonotonicMs, duration) {
  const result = checkedMonotonic(nowMonotonicMs) + duration;
  if (!Number.isSafeInteger(result)) throw invariant("invalid_npc_structured_route_clock");
  return result;
}

function createCheckedAbortController(factory) {
  const controller = factory();
  if (!controller || typeof controller.abort !== "function" || !controller.signal
    || typeof controller.signal.aborted !== "boolean") throw invariant("invalid_npc_structured_route_builder");
  return controller;
}

function validationReason(value) {
  return ["stale_request"].includes(value.rejection.reasonCode) ? "stale_applicability"
    : ["unknown_reference", "target_ineligible", "permission_denied", "result_fact_mismatch"].includes(value.rejection.reasonCode)
      ? "authorization_failure" : ["idempotency_conflict", "attempt_response_conflict"].includes(value.rejection.reasonCode)
        ? "identity_conflict" : "internal_failure";
}

function preparationStatus(value) {
  return ["stale_session", "stale_turn", "stale_phase", "stale_state_version", "stale_validated_binding"].includes(value.rejection.reasonCode)
    ? "superseded" : "rejected";
}

function preparationReason(value) {
  const code = value.rejection.reasonCode;
  if (preparationStatus(value) === "superseded") return "stale_applicability";
  if (["actor_ineligible", "target_ineligible", "invalid_reference", "permission_denied", "result_fact_mismatch"].includes(code)) return "authorization_failure";
  if (code === "artifact_id_collision") return "allocation_failure";
  if (["state_version_exhausted", "order_exhausted"].includes(code)) return "ordering_failure";
  return "internal_failure";
}

function preparationInvariantReason(error) {
  return error?.code === "duplicate_engine_id" || error?.code === "invalid_artifact_allocation"
    ? "allocation_failure" : error?.code === "invalid_order_reservation" ? "ordering_failure" : "internal_failure";
}

function commitReason(code) {
  if (["stale_session", "stale_turn", "stale_phase", "stale_state_version", "logical_reaction_mismatch", "attempt_mismatch"].includes(code)) return "stale_applicability";
  if (["actor_ineligible", "target_ineligible", "invalid_reference", "permission_denied", "result_fact_mismatch"].includes(code)) return "authorization_failure";
  if (code === "artifact_id_collision") return "allocation_failure";
  if (["order_mismatch", "state_version_exhausted"].includes(code)) return "ordering_failure";
  if (["idempotency_conflict", "identity_conflict"].includes(code)) return "identity_conflict";
  return "internal_failure";
}

function classifyBuilderError(error) {
  return error?.message === "order exhausted" ? "npc_structured_route_order_exhausted"
    : "invalid_npc_structured_route_builder";
}

function isPlain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function isId(value) { return typeof value === "string" && ID_PATTERN.test(value); }
function clone(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}
function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  return value;
}
function routeError(code) { return new NpcStructuredReactionRouteError(code); }
function invariant(code) { return new NpcStructuredReactionRouteInvariantError(code); }
