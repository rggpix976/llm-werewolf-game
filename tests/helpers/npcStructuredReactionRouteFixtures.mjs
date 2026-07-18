import { createNpcAuthorityPortFixture, readInput } from "./npcStructuredReactionAuthorityPortFixtures.mjs";
import { createNpcStructuredReactionRoute } from "../../src/npcStructuredReactionRoute.mjs";

export function createRouteFixture(options = {}) {
  const authority = createNpcAuthorityPortFixture();
  let id = 0;
  let monotonic = options.monotonic ?? 0;
  const timers = [];
  const observations = [];
  const calls = { read: 0, commit: 0, transport: 0 };
  const authorityPort = {
    readNpcStructuredReactionSnapshot(input) {
      calls.read += 1;
      const result = authority.game.readNpcStructuredReactionSnapshot(input);
      return options.readResult ? options.readResult(result, input, calls) : result;
    },
    commitPreparedNpcReactionAtomically(input) {
      calls.commit += 1;
      calls.lastCommitInput = structuredClone(input);
      if (options.commitOverride) {
        const overridden = options.commitOverride(input, calls);
        if (overridden !== undefined) return overridden;
      }
      const result = authority.game.commitPreparedNpcReactionAtomically(input);
      return options.commitResult ? options.commitResult(result, input) : result;
    }
  };
  const candidateTransport = {
    async generateCandidateTransport(request, { signal } = {}) {
      calls.transport += 1;
      if (options.transport) return options.transport(request, { signal, calls });
      return successTransport(request, options.candidate);
    }
  };
  const route = createNpcStructuredReactionRoute({
    gameSessionId: authority.game.state.gameSessionId,
    createId: options.createId ?? (() => `route-${++id}`),
    nowUtc: options.nowUtc ?? (() => "2026-07-18T00:00:00.000Z"),
    nowMonotonicMs: options.nowMonotonicMs ?? (() => monotonic),
    scheduleTimer(callback, delayMs) {
      if (options.scheduleTimer) return options.scheduleTimer(callback, delayMs, timers);
      const handle = { callback, delayMs, cancelled: false };
      timers.push(handle);
      if (options.synchronousTimer) callback();
      return handle;
    },
    cancelTimer(handle) {
      if (options.cancelTimer) return options.cancelTimer(handle);
      handle.cancelled = true;
    },
    createAbortController: options.createAbortController ?? (() => new AbortController()),
    authorityPort,
    candidateTransport,
    observer: options.observer ?? ((value) => observations.push(value))
  });
  return {
    ...authority,
    route,
    calls,
    timers,
    observations,
    trigger: readInput(authority),
    setMonotonic(value) { monotonic = value; },
    fire(index = 0) { timers[index].callback(); }
  };
}

export function successTransport(request, candidate = {
  schemaVersion: 1,
  proposals: [{ proposalType: "suspicion", targetId: "npc-beni" }]
}) {
  const envelope = {
    schemaVersion: 1,
    operation: request.operation,
    requestId: request.requestId,
    correlationId: request.correlationId,
    serverCorrelationId: "server-correlation-route",
    reactionPlanId: request.reactionPlanId,
    reactionAttemptId: request.reactionAttemptId,
    result: {
      schemaVersion: 1,
      operation: request.operation,
      gameSessionId: request.gameSessionId,
      reactionPlanId: request.reactionPlanId,
      reactionAttemptId: request.reactionAttemptId,
      requestId: request.requestId,
      requestFingerprint: request.requestFingerprint,
      correlationId: request.correlationId,
      causationId: request.causationId,
      originatingInputRecordId: request.originatingInputRecordId,
      turnId: request.turnId,
      turnOrder: request.turnOrder,
      preconditionPhase: request.preconditionPhase,
      preconditionStateVersion: request.preconditionStateVersion,
      npcId: request.npcId,
      candidate,
      diagnostics: { providerName: "fixture", model: "fixture", attemptCount: 1, elapsedMs: 1 }
    }
  };
  return {
    schemaVersion: 1,
    status: "success",
    transportEvidence: {
      schemaVersion: 1,
      evidenceType: "npc_reaction_candidate_http_success",
      httpStatus: 200,
      contentTypeHeader: "application/json; charset=utf-8",
      contentEncodingHeader: null,
      bodyBytes: new TextEncoder().encode(JSON.stringify(envelope))
    }
  };
}
