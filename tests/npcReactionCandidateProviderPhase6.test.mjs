import assert from "node:assert/strict";
import test from "node:test";

import { sha256CanonicalJson } from "../src/conversation/ids.mjs";
import { validateNpcReactionCandidate } from "../src/npcReactionCandidateValidation.mjs";
import {
  NPC_REACTION_CANDIDATE_PROVIDER_ERROR_CODES,
  NpcReactionCandidateProviderError,
  createNpcReactionCandidateHttpHandler,
  createNpcReactionCandidateProvider
} from "../src/npcReactionCandidateProvider.mjs";

const REQUEST_FIELDS = [
  "schemaVersion", "operation", "gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId",
  "requestFingerprint", "correlationId", "causationId", "originatingInputRecordId", "turnId", "turnOrder",
  "preconditionPhase", "preconditionStateVersion", "npcId", "knownInformation", "limits"
];
const BINDING_FIELDS = REQUEST_FIELDS.filter(
  (field) => !["schemaVersion", "operation", "knownInformation", "limits"].includes(field)
);

function projection() {
  return {
    schemaVersion: 1,
    projectionType: "npc_known_information",
    public: {
      day: 1,
      phase: "player_question",
      participants: [
        { participantId: "npc-aoi", displayName: "Aoi", publicStatus: "alive" },
        { participantId: "npc-beni", displayName: "Beni", publicStatus: "alive" },
        { participantId: "player", displayName: "Player", publicStatus: "alive" }
      ],
      events: [{
        schemaVersion: 1, projectionType: "public_question_event", eventId: "event-question-1",
        actorId: "player", turnId: "turn-1", occurredPhase: "day_discussion", targetId: "npc-aoi", topic: "result"
      }],
      claims: [], votes: [], executions: [], attackDeaths: [],
      triggeringInput: {
        schemaVersion: 1, inputRecordId: "input-1", requestId: "player-request-1",
        correlationId: "player-correlation-1", turnId: "turn-1", capturedStateVersion: 1,
        actorId: "player", rawText: "Aoi, what is your result?", locale: "en"
      }
    },
    actorPrivate: {
      actorId: "npc-aoi", ownRole: "seer", ownTeam: "village",
      investigationResults: [{ day: 1, targetId: "npc-beni", result: "werewolf", disclosurePolicy: "engine_policy_required" }],
      voteHistory: [], suspicionScores: [{ targetId: "npc-beni", score: 2 }]
    },
    constraints: {
      allowedTargetIds: ["npc-beni"], allowedLivingTargetIds: ["npc-beni"], allowedResultTargetIds: ["npc-beni"],
      allowedCandidateKinds: ["role_claim", "result_claim", "vote_declaration", "suspicion"],
      allowedClaimRoles: ["seer"], allowedResultValues: ["werewolf"],
      allowedReferenceIds: ["event-question-1", "input-1"], roleDisclosurePolicy: "claim_when_directly_asked_after_result"
    },
    presentation: { speechStyleId: "brief" }
  };
}

function requestFixture() {
  const request = {
    schemaVersion: 1, operation: "generate_npc_reaction_candidate", gameSessionId: "game-session-1",
    reactionPlanId: "reaction-plan-1", reactionAttemptId: "reaction-attempt-1", requestId: "reaction-request-1",
    requestFingerprint: "0".repeat(64), correlationId: "correlation-1", causationId: "player-request-1",
    originatingInputRecordId: "input-1", turnId: "turn-1", turnOrder: 1, preconditionPhase: "player_question",
    preconditionStateVersion: 2, npcId: "npc-aoi", knownInformation: projection(),
    limits: { maxProposals: 16, maxNestingDepth: 5 }
  };
  request.requestFingerprint = sha256CanonicalJson(Object.fromEntries(REQUEST_FIELDS
    .filter((field) => !["reactionAttemptId", "requestFingerprint"].includes(field))
    .map((field) => [field, request[field]])));
  return request;
}

function candidateFixture() {
  return {
    schemaVersion: 1,
    proposals: [
      { proposalType: "role_claim", claimedRole: "seer" },
      { proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" },
      { proposalType: "vote_declaration", targetId: "npc-beni" },
      { proposalType: "suspicion", targetId: "npc-beni" }
    ]
  };
}

function resultFixture(request = requestFixture(), overrides = {}) {
  return {
    schemaVersion: 1, operation: request.operation, gameSessionId: request.gameSessionId,
    reactionPlanId: request.reactionPlanId, reactionAttemptId: request.reactionAttemptId,
    requestId: request.requestId, requestFingerprint: request.requestFingerprint,
    correlationId: request.correlationId, causationId: request.causationId,
    originatingInputRecordId: request.originatingInputRecordId, turnId: request.turnId,
    turnOrder: request.turnOrder, preconditionPhase: request.preconditionPhase,
    preconditionStateVersion: request.preconditionStateVersion, npcId: request.npcId,
    candidate: candidateFixture(),
    diagnostics: { providerName: "test-provider", model: "test-model", attemptCount: 1, elapsedMs: 4 },
    ...overrides
  };
}

function validationContext(request) {
  return {
    pendingAttempt: {
      schemaVersion: 1, pendingType: "npc_reaction", gameSessionId: request.gameSessionId,
      requestId: request.requestId, requestFingerprint: request.requestFingerprint, correlationId: request.correlationId,
      causationId: request.causationId, reactionPlanId: request.reactionPlanId, reactionAttemptId: request.reactionAttemptId,
      originatingInputRecordId: request.originatingInputRecordId, turnId: request.turnId, turnOrder: request.turnOrder,
      preconditionStateVersion: request.preconditionStateVersion, preconditionPhase: request.preconditionPhase,
      targetNpcId: request.npcId, operation: request.operation, status: "candidate_received",
      startedAt: "2026-07-17T00:00:00.000Z"
    },
    observedCandidate: { schemaVersion: 1, observationStatus: "none" },
    liveApplicability: {
      schemaVersion: 1, snapshotStatus: "available", engineLifecycleStatus: "active",
      gameSessionId: request.gameSessionId, turnId: request.turnId, turnOrder: request.turnOrder,
      phase: request.preconditionPhase, stateVersion: request.preconditionStateVersion,
      reactionPlanId: request.reactionPlanId, logicalReactionStatus: "active",
      reactionAttemptId: request.reactionAttemptId, reactionAttemptStatus: "candidate_received",
      requestId: request.requestId, requestFingerprint: request.requestFingerprint,
      correlationId: request.correlationId, causationId: request.causationId,
      originatingInputRecordId: request.originatingInputRecordId, npcId: request.npcId,
      reactionCommit: { commitStatus: "uncommitted" },
      triggeringPlayerCommit: {
        requestId: request.causationId, requestFingerprint: "a".repeat(64), correlationId: "player-correlation-1",
        inputRecordId: request.originatingInputRecordId, turnId: request.turnId,
        resultingStateVersion: request.preconditionStateVersion
      },
      triggeringInput: {
        inputRecordId: request.originatingInputRecordId, requestId: request.causationId,
        correlationId: "player-correlation-1", turnId: request.turnId,
        capturedStateVersion: request.preconditionStateVersion - 1, actorId: "player"
      },
      participants: [
        { participantId: "npc-aoi", participantClass: "npc", publicStatus: "alive" },
        { participantId: "npc-beni", participantClass: "npc", publicStatus: "alive" },
        { participantId: "player", participantClass: "player", publicStatus: "alive" }
      ]
    }
  };
}

function providerFor(invokeProvider, options = {}) {
  return createNpcReactionCandidateProvider({ invokeProvider, now: () => 100, ...options });
}

function expectedError(code, retryable) {
  return (error) => error instanceof NpcReactionCandidateProviderError
    && error.name === "NpcReactionCandidateProviderError"
    && error.message === "NPC reaction candidate provider failed."
    && error.code === code
    && error.retryable === retryable
    && !Object.hasOwn(error, "cause");
}

test("provider validates dependencies and the exact request before invocation", async () => {
  assert.throws(() => createNpcReactionCandidateProvider(), TypeError);
  assert.throws(() => createNpcReactionCandidateProvider({ invokeProvider: async () => ({}), timeoutMs: 5001 }), TypeError);
  const invalidRequests = [
    (request) => { delete request.npcId; },
    (request) => { request.extra = true; },
    (request) => { request.npcId = null; },
    (request) => { request.operation = "other"; },
    (request) => { request.schemaVersion = 2; },
    (request) => { request.requestId = "bad id"; },
    (request) => { request.requestFingerprint = "f"; },
    (request) => { request.turnOrder = Number.MAX_SAFE_INTEGER + 1; },
    (request) => { request.knownInformation.presentation.speechStyleId = { nested: { too: { deeply: true } } }; }
  ];
  for (const change of invalidRequests) {
    let calls = 0;
    const request = requestFixture();
    change(request);
    const before = structuredClone(request);
    await assert.rejects(
      providerFor(async () => { calls += 1; return resultFixture(request); }).generateCandidate(request),
      expectedError("schema_mismatch", false)
    );
    assert.equal(calls, 0);
    assert.deepEqual(request, before);
  }
});

test("provider invokes exactly once and returns a detached deeply frozen result", async () => {
  const request = requestFixture();
  const originalRequest = structuredClone(request);
  const raw = resultFixture(request);
  let calls = 0;
  let received;
  const result = await providerFor(async (value, { signal }) => {
    calls += 1;
    received = value;
    assert.equal(signal.aborted, false);
    return raw;
  }).generateCandidate(request);
  assert.equal(calls, 1);
  assert.deepEqual(request, originalRequest);
  assert.notEqual(received, request);
  assert.ok(Object.isFrozen(received));
  assert.notEqual(result, raw);
  assert.notEqual(result.candidate, raw.candidate);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.candidate.proposals[0]));
  raw.candidate.proposals[0].claimedRole = "citizen";
  assert.equal(result.candidate.proposals[0].claimedRole, "seer");
});

test("every immutable provider binding echo is compared independently", async () => {
  for (const field of BINDING_FIELDS) {
    const request = requestFixture();
    const changed = field === "turnOrder" || field === "preconditionStateVersion"
      ? request[field] + 1
      : field === "requestFingerprint" ? "f".repeat(64)
        : field === "preconditionPhase" ? "day_discussion" : `${request[field]}-other`;
    let calls = 0;
    await assert.rejects(providerFor(async () => {
      calls += 1;
      return resultFixture(request, { [field]: changed });
    }).generateCandidate(request), expectedError("schema_mismatch", false), field);
    assert.equal(calls, 1, field);
  }
});

test("provider result candidate and diagnostics use strict closed shapes", async () => {
  const request = requestFixture();
  const malformed = [
    null,
    { ...resultFixture(request), extra: true },
    resultFixture(request, { candidate: { schemaVersion: 1, proposals: [] } }),
    resultFixture(request, { candidate: { schemaVersion: 1, proposals: [{ proposalType: "unknown" }] } }),
    resultFixture(request, { candidate: { schemaVersion: 1, proposals: [{ proposalType: "commentary", extra: true }] } }),
    resultFixture(request, { diagnostics: { providerName: "test", model: "model", attemptCount: 0, elapsedMs: 1 } }),
    resultFixture(request, { diagnostics: { providerName: "test", model: "model", attemptCount: 2, elapsedMs: 1 } }),
    resultFixture(request, { diagnostics: { providerName: "test", model: "model", attemptCount: 1, elapsedMs: 1, extra: true } })
  ];
  for (const output of malformed) {
    let calls = 0;
    await assert.rejects(providerFor(async () => { calls += 1; return output; }).generateCandidate(request), (error) => {
      assert.ok(["malformed_provider_output", "schema_mismatch"].includes(error.code));
      return true;
    });
    assert.equal(calls, 1);
  }
  const candidateFingerprint = sha256CanonicalJson(candidateFixture());
  const changedDiagnostics = resultFixture(request, { diagnostics: { providerName: "other", model: "other", attemptCount: 1, elapsedMs: 999 } });
  const accepted = await providerFor(async () => changedDiagnostics).generateCandidate(request);
  assert.equal(sha256CanonicalJson(accepted.candidate), candidateFingerprint);
});

test("reserved candidate kinds remain candidate-validation ownership without authoritative mutation", async () => {
  const state = { stateVersion: 7, publicationCount: 2, deliveryCount: 1 };
  for (const proposalType of ["commentary", "answer", "acknowledgement", "decline", "clarification"]) {
    const request = requestFixture();
    const before = structuredClone(state);
    const provider = providerFor(async () => resultFixture(request, {
      candidate: { schemaVersion: 1, proposals: [{ proposalType }] }
    }));
    const handler = createNpcReactionCandidateHttpHandler({
      provider,
      createServerCorrelationId: () => `server-${proposalType}`
    });
    const response = await handler.handle({
      method: "POST", path: "/api/generate-npc-reaction-candidate",
      contentTypeHeader: "application/json; charset=utf-8", contentEncodingHeader: null,
      bodyBytes: new TextEncoder().encode(JSON.stringify(request))
    });
    assert.equal(response.status, 200);
    const context = validationContext(request);
    const validation = validateNpcReactionCandidate({
      schemaVersion: 1,
      request,
      ...context,
      transportEvidence: {
        schemaVersion: 1, evidenceType: "npc_reaction_candidate_http_success", httpStatus: 200,
        contentTypeHeader: response.headers["content-type"], contentEncodingHeader: response.headers["content-encoding"],
        bodyBytes: new TextEncoder().encode(JSON.stringify(response.body))
      }
    });
    assert.equal(validation.status, "rejected");
    assert.equal(validation.rejection.reasonCode, "unsupported_in_phase6");
    assert.equal(validation.rejection.stage, "structure");
    assert.deepEqual(state, before);
  }
});

test("provider performs no hidden retry or fallback and requires explicit retryability evidence", async () => {
  const vectors = [
    [Object.assign(new Error("private network detail"), { code: "network_failure" }), "network_failure", false],
    [Object.assign(new Error("private transient network detail"), { code: "network_failure", retryable: true }), "network_failure", true],
    [Object.assign(new Error("private unavailable detail"), { code: "provider_unavailable" }), "provider_unavailable", false],
    [Object.assign(new Error("private transient unavailable detail"), { code: "provider_unavailable", retryable: true }), "provider_unavailable", true],
    [Object.assign(new Error("private rate detail"), { status: 429 }), "rate_limited", false],
    [Object.assign(new Error("private rate detail"), { status: 429, retryAfterMs: 1000 }), "rate_limited", true],
    [Object.assign(new Error("private invalid rate detail"), { status: 429, retryAfterMs: 2500 }), "rate_limited", false],
    [new NpcReactionCandidateProviderError("rate_limited", true), "rate_limited", false],
    [Object.assign(new Error("private auth detail"), { status: 401 }), "authentication_failure", false],
    [Object.assign(new Error("private body detail"), { code: "invalid_provider_response" }), "malformed_provider_output", false],
    [Object.assign(new Error("private schema detail"), { code: "invalid_schema" }), "schema_mismatch", false],
    [Object.assign(new Error("private transport detail"), { code: "invalid_transport_response" }), "invalid_transport_response", false],
    [Object.assign(new Error("private server detail"), { status: 503 }), "provider_unavailable", false],
    [Object.assign(new Error("private transient server detail"), { status: 503, retryable: true }), "provider_unavailable", true]
  ];
  for (const [failure, code, retryable] of vectors) {
    let calls = 0;
    await assert.rejects(providerFor(async () => { calls += 1; throw failure; }).generateCandidate(requestFixture()), (error) => {
      assert.ok(expectedError(code, retryable)(error));
      assert.equal(JSON.stringify(error).includes("private"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
  let clockRead = 0;
  const insufficientDeadline = providerFor(async () => {
    throw Object.assign(new Error("private rate detail"), { status: 429, retryAfterMs: 1_000 });
  }, { now: () => [0, 4_000][Math.min(clockRead++, 1)] });
  await assert.rejects(
    insufficientDeadline.generateCandidate(requestFixture()),
    expectedError("rate_limited", false)
  );
});

test("pre-abort invokes zero times and in-flight abort invokes once with cleanup", async () => {
  const pre = new AbortController();
  pre.abort(new Error("private abort reason"));
  let preCalls = 0;
  await assert.rejects(providerFor(async () => { preCalls += 1; }).generateCandidate(requestFixture(), { signal: pre.signal }), expectedError("aborted", false));
  assert.equal(preCalls, 0);

  const active = new AbortController();
  let calls = 0;
  let providerSignal;
  const pending = providerFor(async (_request, { signal }) => {
    calls += 1;
    providerSignal = signal;
    return new Promise(() => {});
  }).generateCandidate(requestFixture(), { signal: active.signal });
  await Promise.resolve();
  active.abort(new Error("private abort reason"));
  await assert.rejects(pending, expectedError("aborted", false));
  assert.equal(calls, 1);
  assert.equal(providerSignal.aborted, true);
});

test("attempt timeout aborts one invocation, remains client-nonretryable without budget evidence, and clears its timer", async () => {
  let timerCallback;
  let clearCount = 0;
  let calls = 0;
  let providerSignal;
  const provider = providerFor(async (_request, { signal }) => {
    calls += 1;
    providerSignal = signal;
    return new Promise(() => {});
  }, {
    timeoutMs: 5,
    setTimeout: (callback) => { timerCallback = callback; return 7; },
    clearTimeout: (timer) => { assert.equal(timer, 7); clearCount += 1; }
  });
  const pending = provider.generateCandidate(requestFixture());
  await Promise.resolve();
  timerCallback();
  await assert.rejects(pending, expectedError("timeout", false));
  assert.equal(calls, 1);
  assert.equal(providerSignal.aborted, true);
  assert.equal(clearCount, 1);
});

test("non-routing HTTP handler enforces exact byte, media, and envelope boundaries", async () => {
  const request = requestFixture();
  let calls = 0;
  const provider = providerFor(async () => { calls += 1; return resultFixture(request); });
  let correlation = 0;
  const handler = createNpcReactionCandidateHttpHandler({ provider, createServerCorrelationId: () => `server-${++correlation}` });
  const encoded = new TextEncoder().encode(JSON.stringify(request));
  const base = { method: "POST", path: "/api/generate-npc-reaction-candidate", contentTypeHeader: "application/json; charset=utf-8", contentEncodingHeader: null };
  const exact = new Uint8Array(65_536);
  exact.fill(0x20);
  exact.set(encoded);
  const accepted = await handler.handle({ ...base, bodyBytes: exact });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.result.requestId, request.requestId);
  assert.equal(calls, 1);

  const tooLarge = await handler.handle({ ...base, bodyBytes: new Uint8Array(65_537) });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.error.code, "body_too_large");
  assert.equal(calls, 1);
  const wrongMedia = await handler.handle({ ...base, contentTypeHeader: "text/plain", bodyBytes: encoded });
  assert.equal(wrongMedia.status, 415);
  assert.equal(wrongMedia.body.error.code, "unsupported_media_type");
  const encodedIdentity = await handler.handle({ ...base, contentEncodingHeader: "identity", bodyBytes: encoded });
  assert.equal(encodedIdentity.status, 415);
  assert.equal(encodedIdentity.body.error.code, "unsupported_media_type");
  const malformed = await handler.handle({ ...base, bodyBytes: new Uint8Array([0xff]) });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "malformed_json");
  const missingVersion = structuredClone(request);
  delete missingVersion.schemaVersion;
  const invalidSchema = await handler.handle({ ...base, bodyBytes: new TextEncoder().encode(JSON.stringify(missingVersion)) });
  assert.equal(invalidSchema.status, 400);
  assert.equal(invalidSchema.body.error.code, "invalid_schema");
  const changedVersion = { ...request, schemaVersion: 2 };
  const unsupported = await handler.handle({ ...base, bodyBytes: new TextEncoder().encode(JSON.stringify(changedVersion)) });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error.code, "unsupported_schema_version");
  assert.equal(calls, 1);
});

test("HTTP handler wraps success and failures without state, secrets, or stack traces", async () => {
  const request = requestFixture();
  const state = Object.freeze({ stateVersion: 7, publicationCount: 2, deliveryCount: 1, playerCount: 5, counter: 9 });
  const before = JSON.stringify(state);
  const successProvider = providerFor(async () => resultFixture(request));
  const successHandler = createNpcReactionCandidateHttpHandler({ provider: successProvider, createServerCorrelationId: () => "server-success" });
  const transport = { method: "POST", path: "/api/generate-npc-reaction-candidate", contentTypeHeader: "application/json; charset=utf-8", contentEncodingHeader: null, bodyBytes: new TextEncoder().encode(JSON.stringify(request)) };
  const success = await successHandler.handle(transport);
  assert.equal(success.status, 200);
  assert.equal(success.body.serverCorrelationId, "server-success");
  assert.equal(success.body.result.diagnostics.attemptCount, 1);

  const failedProvider = providerFor(async () => { throw Object.assign(new Error("SECRET raw provider body stack"), { status: 401 }); });
  const failedHandler = createNpcReactionCandidateHttpHandler({ provider: failedProvider, createServerCorrelationId: () => "server-failure" });
  const failure = await failedHandler.handle(transport);
  assert.equal(failure.status, 502);
  assert.deepEqual(failure.body.error, { code: "provider_auth_failure", retryable: false });
  assert.equal(JSON.stringify(failure).includes("SECRET"), false);
  assert.equal(JSON.stringify(failure).includes("stack"), false);
  assert.equal(JSON.stringify(state), before);
});

test("HTTP handler trusts only its request AbortSignal and redacts provider-originated abort claims", async () => {
  const request = requestFixture();
  const transport = {
    method: "POST", path: "/api/generate-npc-reaction-candidate",
    contentTypeHeader: "application/json; charset=utf-8", contentEncodingHeader: null,
    bodyBytes: new TextEncoder().encode(JSON.stringify(request))
  };

  const requestAbort = new AbortController();
  let inFlightCalls = 0;
  let providerSignal;
  const inFlightProvider = providerFor(async (_value, { signal }) => {
    inFlightCalls += 1;
    providerSignal = signal;
    return new Promise(() => {});
  });
  const inFlightHandler = createNpcReactionCandidateHttpHandler({
    provider: inFlightProvider,
    createServerCorrelationId: () => "server-request-abort"
  });
  const pending = inFlightHandler.handle(transport, { signal: requestAbort.signal });
  await Promise.resolve();
  requestAbort.abort(new Error("private client disconnect reason"));
  await assert.rejects(pending, expectedError("aborted", false));
  assert.equal(inFlightCalls, 1);
  assert.equal(providerSignal.aborted, true);

  const forgedErrors = [
    new NpcReactionCandidateProviderError("aborted"),
    Object.assign(new Error("private AbortError message"), {
      name: "AbortError", cause: new Error("private nested cause")
    }),
    { code: "aborted", message: "private arbitrary abort claim", stack: "private stack" }
  ];
  for (const forgedError of forgedErrors) {
    let calls = 0;
    const handler = createNpcReactionCandidateHttpHandler({
      provider: { generateCandidate: async () => { calls += 1; throw forgedError; } },
      createServerCorrelationId: () => "server-forged-abort"
    });
    const response = await handler.handle(transport, { signal: new AbortController().signal });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body.error, { code: "provider_unavailable", retryable: false });
    const serialized = JSON.stringify(response);
    for (const secret of ["private", "AbortError", "stack", "cause"]) assert.equal(serialized.includes(secret), false);
    assert.equal(calls, 1);
  }
});

test("HTTP handler suppresses a valid result when the request aborts at provider completion", async () => {
  const request = requestFixture();
  const state = { stateVersion: 7, publicationCount: 2, deliveryCount: 1 };
  const before = structuredClone(state);
  const requestAbort = new AbortController();
  let calls = 0;
  const handler = createNpcReactionCandidateHttpHandler({
    provider: {
      generateCandidate: async (_value, { signal }) => {
        calls += 1;
        assert.equal(signal, requestAbort.signal);
        requestAbort.abort(new Error("private completion-race reason"));
        return resultFixture(request);
      }
    },
    createServerCorrelationId: () => "server-completion-race"
  });
  await assert.rejects(handler.handle({
    method: "POST", path: "/api/generate-npc-reaction-candidate",
    contentTypeHeader: "application/json; charset=utf-8", contentEncodingHeader: null,
    bodyBytes: new TextEncoder().encode(JSON.stringify(request))
  }, { signal: requestAbort.signal }), (error) => {
    assert.ok(expectedError("aborted", false)(error));
    assert.equal(error.message.includes("private"), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(state, before);
});

test("HTTP retryability requires explicit transient evidence and never relabels upstream 429 as server rate limiting", async () => {
  const request = requestFixture();
  const transport = {
    method: "POST", path: "/api/generate-npc-reaction-candidate",
    contentTypeHeader: "application/json; charset=utf-8", contentEncodingHeader: null,
    bodyBytes: new TextEncoder().encode(JSON.stringify(request))
  };
  const vectors = [
    [{ status: 429 }, false],
    [{ status: 429, retryAfterMs: 1_000 }, true],
    [{ status: 429, retryAfterMs: 2_001 }, false],
    [{ status: 503 }, false],
    [{ status: 503, retryable: true }, true]
  ];
  for (const [evidence, retryable] of vectors) {
    let calls = 0;
    const provider = providerFor(async () => {
      calls += 1;
      throw Object.assign(new Error("private upstream detail"), evidence);
    });
    const handler = createNpcReactionCandidateHttpHandler({
      provider,
      createServerCorrelationId: () => "server-retryability"
    });
    const response = await handler.handle(transport);
    assert.equal(response.status, 503);
    assert.deepEqual(response.body.error, { code: "provider_unavailable", retryable });
    assert.equal(response.body.error.code === "server_rate_limited", false);
    assert.equal(calls, 1);
  }
});

test("HTTP handler revalidates injected provider results before returning 200", async () => {
  const request = requestFixture();
  const baseResult = resultFixture(request);
  const makeHandler = (result) => createNpcReactionCandidateHttpHandler({
    provider: { generateCandidate: async () => result },
    createServerCorrelationId: () => "server-response-size"
  });
  const transport = {
    method: "POST", path: "/api/generate-npc-reaction-candidate",
    contentTypeHeader: "application/json; charset=utf-8", contentEncodingHeader: null,
    bodyBytes: new TextEncoder().encode(JSON.stringify(request))
  };
  const invalidResults = [
    { ...baseResult, padding: "x" },
    { ...baseResult, padding: "x".repeat(64_000) },
    { ...baseResult, reactionAttemptId: "reaction-attempt-foreign" }
  ];
  for (const invalidResult of invalidResults) {
    const rejected = await makeHandler(invalidResult).handle(transport);
    assert.equal(rejected.status, 502);
    assert.deepEqual(rejected.body.error, { code: "invalid_provider_response", retryable: false });
  }
});

test("HTTP handler returns the largest strict result fixture while retaining the complete-envelope size guard", async () => {
  const request = requestFixture();
  const maximumId = `n${"x".repeat(63)}`;
  const maximumResult = resultFixture(request, {
    candidate: {
      schemaVersion: 1,
      proposals: Array.from({ length: 16 }, () => ({ proposalType: "suspicion", targetId: maximumId }))
    },
    diagnostics: {
      providerName: "p".repeat(64), model: "m".repeat(128), attemptCount: 1,
      elapsedMs: Number.MAX_SAFE_INTEGER
    }
  });
  const provider = providerFor(async () => maximumResult);
  const handler = createNpcReactionCandidateHttpHandler({
    provider,
    createServerCorrelationId: () => "server-maximum-valid-result"
  });
  const response = await handler.handle({
    method: "POST", path: "/api/generate-npc-reaction-candidate",
    contentTypeHeader: "application/json; charset=utf-8", contentEncodingHeader: null,
    bodyBytes: new TextEncoder().encode(JSON.stringify(request))
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.result.candidate.proposals.length, 16);
  assert.ok(utf8Length(JSON.stringify(response.body)) < 65_536);
});

test("non-routing HTTP success is accepted by the existing pure candidate validator", async () => {
  const request = requestFixture();
  const provider = providerFor(async () => resultFixture(request));
  const handler = createNpcReactionCandidateHttpHandler({ provider, createServerCorrelationId: () => "server-validation" });
  const response = await handler.handle({
    method: "POST", path: "/api/generate-npc-reaction-candidate",
    contentTypeHeader: "application/json; charset=utf-8", contentEncodingHeader: null,
    bodyBytes: new TextEncoder().encode(JSON.stringify(request))
  });
  const context = validationContext(request);
  const validation = validateNpcReactionCandidate({
    schemaVersion: 1,
    request,
    ...context,
    transportEvidence: {
      schemaVersion: 1, evidenceType: "npc_reaction_candidate_http_success", httpStatus: 200,
      contentTypeHeader: response.headers["content-type"], contentEncodingHeader: response.headers["content-encoding"],
      bodyBytes: new TextEncoder().encode(JSON.stringify(response.body))
    }
  });
  assert.equal(validation.status, "validated");
  assert.deepEqual(validation.value.candidate, candidateFixture());
});

test("provider module remains browser-safe, isolated, and exposes only closed errors", async () => {
  assert.deepEqual(NPC_REACTION_CANDIDATE_PROVIDER_ERROR_CODES, [
    "aborted", "timeout", "network_failure", "provider_unavailable", "rate_limited",
    "authentication_failure", "malformed_provider_output", "schema_mismatch", "invalid_transport_response"
  ]);
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/npcReactionCandidateProvider.mjs", import.meta.url), "utf8"));
  assert.equal(/from\s+["']node:|import\s*\(["']node:/.test(source), false);
  for (const forbidden of ["gameEngine", "npcReactionCoordinator", "npcReactionPreparation", "npcReactionAuthoritativeCommit", "playerPublicationDelivery", "responseGenerator", "openaiProvider", "webServer"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(source.includes("process.env"), false);
  assert.equal(source.includes("fallback"), false);
  assert.equal(source.includes("runProviderWithRetry"), false);
});

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}
