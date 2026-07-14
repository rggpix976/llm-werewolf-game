import assert from "node:assert/strict";
import test from "node:test";

import { sha256CanonicalJson } from "../src/conversation/ids.mjs";
import {
  NPC_REACTION_CANDIDATE_REJECTION_CODES,
  NPC_REACTION_CANDIDATE_VALIDATION_INVARIANT_CODES,
  NpcReactionCandidateValidationInvariantError,
  validateNpcReactionCandidate
} from "../src/npcReactionCandidateValidation.mjs";
import * as validationApi from "../src/npcReactionCandidateValidation.mjs";

const FINGERPRINT = "a".repeat(64);
const REQUEST_FIELDS = [
  "schemaVersion", "operation", "gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId",
  "requestFingerprint", "correlationId", "causationId", "originatingInputRecordId", "turnId", "turnOrder",
  "preconditionPhase", "preconditionStateVersion", "npcId", "knownInformation", "limits"
];

function projection(overrides = {}) {
  const value = {
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
      events: [{ schemaVersion: 1, projectionType: "public_question_event", eventId: "event-question-1", actorId: "player", turnId: "turn-1", occurredPhase: "day_discussion", targetId: "npc-aoi", topic: "result" }],
      claims: [], votes: [], executions: [], attackDeaths: [],
      triggeringInput: { schemaVersion: 1, inputRecordId: "input-1", requestId: "player-request-1", correlationId: "player-correlation-1", turnId: "turn-1", capturedStateVersion: 1, actorId: "player", rawText: "Aoi, what is your role and result?", locale: "en" }
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
  return merge(value, overrides);
}

function makeRequest(knownInformation = projection()) {
  const request = {
    schemaVersion: 1, operation: "generate_npc_reaction_candidate", gameSessionId: "game-session-1",
    reactionPlanId: "reaction-plan-1", reactionAttemptId: "reaction-attempt-1", requestId: "reaction-request-1",
    requestFingerprint: FINGERPRINT, correlationId: "correlation-1", causationId: "player-request-1",
    originatingInputRecordId: "input-1", turnId: "turn-1", turnOrder: 1, preconditionPhase: "player_question",
    preconditionStateVersion: 2, npcId: "npc-aoi", knownInformation, limits: { maxProposals: 16, maxNestingDepth: 5 }
  };
  request.requestFingerprint = sha256CanonicalJson(Object.fromEntries(REQUEST_FIELDS.filter((field) => !["reactionAttemptId", "requestFingerprint"].includes(field)).map((field) => [field, request[field]])));
  return request;
}

function pending(request, status = "candidate_received") {
  return {
    schemaVersion: 1, pendingType: "npc_reaction", gameSessionId: request.gameSessionId, requestId: request.requestId,
    requestFingerprint: request.requestFingerprint, correlationId: request.correlationId, causationId: request.causationId,
    reactionPlanId: request.reactionPlanId, reactionAttemptId: request.reactionAttemptId,
    originatingInputRecordId: request.originatingInputRecordId, turnId: request.turnId, turnOrder: request.turnOrder,
    preconditionStateVersion: request.preconditionStateVersion, preconditionPhase: request.preconditionPhase,
    targetNpcId: request.npcId, operation: request.operation, status, startedAt: "2026-07-14T00:00:00.000Z"
  };
}

function live(request, { logicalStatus = "active", attemptStatus = "candidate_received", committed = false, winner = true } = {}) {
  return {
    schemaVersion: 1, snapshotStatus: "available", engineLifecycleStatus: "active", gameSessionId: request.gameSessionId,
    turnId: request.turnId, turnOrder: request.turnOrder, phase: committed ? "npc_response" : request.preconditionPhase,
    stateVersion: committed ? request.preconditionStateVersion + 1 : request.preconditionStateVersion,
    reactionPlanId: request.reactionPlanId, logicalReactionStatus: logicalStatus, reactionAttemptId: request.reactionAttemptId,
    reactionAttemptStatus: attemptStatus, requestId: request.requestId, requestFingerprint: request.requestFingerprint,
    correlationId: request.correlationId, causationId: request.causationId, originatingInputRecordId: request.originatingInputRecordId,
    npcId: request.npcId,
    reactionCommit: committed ? {
      commitStatus: "committed", reactionPlanId: request.reactionPlanId, requestId: request.requestId,
      requestFingerprint: request.requestFingerprint, successfulAttemptId: winner ? request.reactionAttemptId : "reaction-attempt-winner",
      turnId: request.turnId, preconditionPhase: request.preconditionPhase, resultingPhase: "npc_response",
      preconditionStateVersion: request.preconditionStateVersion, resultingStateVersion: request.preconditionStateVersion + 1
    } : { commitStatus: "uncommitted" },
    triggeringPlayerCommit: { requestId: request.causationId, requestFingerprint: FINGERPRINT, correlationId: "player-correlation-1", inputRecordId: request.originatingInputRecordId, turnId: request.turnId, resultingStateVersion: request.preconditionStateVersion },
    triggeringInput: { inputRecordId: request.originatingInputRecordId, requestId: request.causationId, correlationId: "player-correlation-1", turnId: request.turnId, capturedStateVersion: request.preconditionStateVersion - 1, actorId: "player" },
    participants: [
      { participantId: "npc-aoi", participantClass: "npc", publicStatus: "alive" },
      { participantId: "npc-beni", participantClass: "npc", publicStatus: "alive" },
      { participantId: "player", participantClass: "player", publicStatus: "alive" }
    ]
  };
}

function response(request, candidate) {
  return {
    schemaVersion: 1, operation: request.operation, requestId: request.requestId, correlationId: request.correlationId,
    serverCorrelationId: "server-correlation-1", reactionPlanId: request.reactionPlanId, reactionAttemptId: request.reactionAttemptId,
    result: {
      schemaVersion: 1, operation: request.operation, gameSessionId: request.gameSessionId, reactionPlanId: request.reactionPlanId,
      reactionAttemptId: request.reactionAttemptId, requestId: request.requestId, requestFingerprint: request.requestFingerprint,
      correlationId: request.correlationId, causationId: request.causationId, originatingInputRecordId: request.originatingInputRecordId,
      turnId: request.turnId, turnOrder: request.turnOrder, preconditionPhase: request.preconditionPhase,
      preconditionStateVersion: request.preconditionStateVersion, npcId: request.npcId, candidate,
      diagnostics: { providerName: "example-provider", model: "example-model", attemptCount: 1, elapsedMs: 10 }
    }
  };
}

function inputFor(candidate = { schemaVersion: 1, proposals: [{ proposalType: "suspicion", targetId: "npc-beni" }] }) {
  const request = makeRequest();
  const httpResponse = response(request, candidate);
  return {
    schemaVersion: 1,
    request,
    pendingAttempt: pending(request),
    transportEvidence: { schemaVersion: 1, evidenceType: "npc_reaction_candidate_http_success", httpStatus: 200, contentTypeHeader: "application/json; charset=utf-8", contentEncodingHeader: null, bodyBytes: new TextEncoder().encode(JSON.stringify(httpResponse)) },
    observedCandidate: { schemaVersion: 1, observationStatus: "none" },
    liveApplicability: live(request)
  };
}

function replaceResponse(input, mutator) {
  const decoded = JSON.parse(new TextDecoder().decode(input.transportEvidence.bodyBytes));
  mutator(decoded);
  input.transportEvidence.bodyBytes = new TextEncoder().encode(JSON.stringify(decoded));
  return input;
}

function merge(value, overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return overrides === undefined ? value : overrides;
  const result = structuredClone(value);
  for (const [key, child] of Object.entries(overrides)) result[key] = child && typeof child === "object" && !Array.isArray(child) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key]) ? merge(result[key], child) : child;
  return result;
}

function assertRejected(result, stage, reasonCode, location) {
  assert.equal(result.status, "rejected");
  assert.deepEqual(Object.keys(result).sort(), ["binding", "rejection", "schemaVersion", "status"]);
  assert.deepEqual(Object.keys(result.rejection).sort(), ["diagnostics", "reasonCode", "retryable", "stage"]);
  assert.deepEqual(result.rejection, { stage, reasonCode, retryable: false, diagnostics: [{ code: reasonCode, location }] });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.rejection.diagnostics));
}

test("single public entrypoint validates all four proposal variants and returns detached recursively frozen output", () => {
  const candidate = { schemaVersion: 1, proposals: [
    { proposalType: "role_claim", claimedRole: "seer" },
    { proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" },
    { proposalType: "vote_declaration", targetId: "npc-beni" },
    { proposalType: "suspicion", targetId: "npc-beni" }
  ] };
  const input = inputFor(candidate);
  const before = structuredClone(input);
  const result = validateNpcReactionCandidate(input);
  assert.equal(result.status, "validated");
  assert.deepEqual(Object.keys(result).sort(), ["schemaVersion", "status", "value"]);
  assert.deepEqual(Object.keys(result.value).sort(), ["binding", "candidate", "candidateFingerprint", "schemaVersion", "validationContext"]);
  assert.deepEqual(Object.keys(result.value.binding).sort(), ["causationId", "correlationId", "gameSessionId", "npcId", "originatingInputRecordId", "preconditionPhase", "preconditionStateVersion", "reactionAttemptId", "reactionPlanId", "requestFingerprint", "requestId", "turnId", "turnOrder"]);
  assert.deepEqual(Object.keys(result.value.validationContext).sort(), ["finalApplicabilityResult", "permissionResult", "projectionFingerprint", "roleDisclosurePolicy"]);
  assert.equal(result.value.candidateFingerprint, sha256CanonicalJson(candidate));
  assert.equal(result.value.validationContext.projectionFingerprint, sha256CanonicalJson(input.request.knownInformation));
  assert.equal(result.value.validationContext.permissionResult, "allowed");
  assert.deepEqual(input, before);
  assert.notEqual(result.value.candidate, candidate);
  assert.ok(Object.isFrozen(result.value));
  assert.ok(Object.isFrozen(result.value.candidate.proposals));
  assert.ok(Object.isFrozen(result.value.validationContext));
});

test("validation-only module exposes only the approved minimum public API", () => {
  assert.deepEqual(Object.keys(validationApi).sort(), [
    "NPC_REACTION_CANDIDATE_REJECTION_CODES",
    "NPC_REACTION_CANDIDATE_VALIDATION_INVARIANT_CODES",
    "NpcReactionCandidateValidationInvariantError",
    "validateNpcReactionCandidate"
  ]);
  assert.equal(validateNpcReactionCandidate.constructor.name, "Function");
});

test("all invariant failures use the exact redacted error contract", () => {
  const cases = [
    ["invalid_validation_input", (input) => { input.extra = true; }],
    ["invalid_expected_request", (input) => { input.request.extra = true; }],
    ["invalid_expected_pending_attempt", (input) => { input.pendingAttempt.startedAt = "not-a-date"; }],
    ["invalid_transport_evidence_shape", (input) => { input.transportEvidence.bodyBytes = []; }],
    ["invalid_observed_candidate", (input) => { input.observedCandidate = { schemaVersion: 1, observationStatus: "observed", reactionAttemptId: "bad id", candidateFingerprint: FINGERPRINT }; }],
    ["invalid_live_applicability_snapshot", (input) => { input.liveApplicability.logicalReactionStatus = "planned"; }],
    ["validation_input_binding_mismatch", (input) => { input.pendingAttempt.requestId = "different-request"; }]
  ];
  assert.deepEqual(NPC_REACTION_CANDIDATE_VALIDATION_INVARIANT_CODES, cases.map(([code]) => code));
  for (const [code, mutate] of cases) {
    const input = inputFor(); mutate(input);
    assert.throws(() => validateNpcReactionCandidate(input), (error) => {
      assert.ok(error instanceof NpcReactionCandidateValidationInvariantError);
      assert.equal(error.name, "NpcReactionCandidateValidationInvariantError");
      assert.equal(error.code, code);
      assert.equal(error.message, "invalid NPC reaction candidate validation input");
      assert.equal(Object.hasOwn(error, "cause"), false);
      assert.equal(Object.hasOwn(error, "path"), false);
      assert.equal(Object.hasOwn(error, "body"), false);
      return true;
    });
  }
});

test("transport evidence enforces media, encoding, byte, UTF-8, and JSON boundaries in order", () => {
  for (const mutate of [
    (e) => { e.contentTypeHeader = null; },
    (e) => { e.contentTypeHeader = "application/json"; },
    (e) => { e.contentTypeHeader = "application/json; charset=\"utf-8\""; },
    (e) => { e.contentTypeHeader = "application/json; charset=utf-8; x=y"; },
    (e) => { e.contentEncodingHeader = "gzip"; },
    (e) => { e.contentTypeHeader = ""; },
    (e) => { e.contentEncodingHeader = ""; }
  ]) {
    const input = inputFor(); mutate(input.transportEvidence);
    assertRejected(validateNpcReactionCandidate(input), "transport", "invalid_envelope", "http_envelope");
  }
  const ows = inputFor(); ows.transportEvidence.contentTypeHeader = " APPLICATION/JSON ; CHARSET = UTF-8 "; ows.transportEvidence.contentEncodingHeader = " Identity ";
  assert.equal(validateNpcReactionCandidate(ows).status, "validated");
  const tooLarge = inputFor(); tooLarge.transportEvidence.bodyBytes = new Uint8Array(65_537);
  assertRejected(validateNpcReactionCandidate(tooLarge), "transport", "body_too_large", "http_envelope");
  const boundary = inputFor(); boundary.transportEvidence.bodyBytes = new Uint8Array(65_536);
  assertRejected(validateNpcReactionCandidate(boundary), "transport", "malformed_json", "http_envelope");
  const utf8 = inputFor(); utf8.transportEvidence.bodyBytes = Uint8Array.of(0xc3, 0x28);
  assertRejected(validateNpcReactionCandidate(utf8), "transport", "malformed_json", "http_envelope");
  const json = inputFor(); json.transportEvidence.bodyBytes = new TextEncoder().encode("{");
  assertRejected(validateNpcReactionCandidate(json), "transport", "malformed_json", "http_envelope");
});

test("envelope, schema, request fingerprint, binding, stale, structure, duplicate, and authorization obey first-failure order", () => {
  const headerFirst = inputFor({ schemaVersion: 1, proposals: [{ proposalType: "unknown" }] }); headerFirst.transportEvidence.contentTypeHeader = "text/plain";
  assertRejected(validateNpcReactionCandidate(headerFirst), "transport", "invalid_envelope", "http_envelope");
  const version = replaceResponse(inputFor(), (body) => { body.schemaVersion = 2; });
  assertRejected(validateNpcReactionCandidate(version), "transport", "unsupported_schema_version", "http_envelope");
  const fingerprint = inputFor({ schemaVersion: 1, proposals: [{ proposalType: "unknown" }] }); fingerprint.request.requestFingerprint = "b".repeat(64); fingerprint.pendingAttempt.requestFingerprint = fingerprint.request.requestFingerprint; fingerprint.liveApplicability.requestFingerprint = fingerprint.request.requestFingerprint;
  replaceResponse(fingerprint, (body) => { body.result.requestFingerprint = fingerprint.request.requestFingerprint; });
  assertRejected(validateNpcReactionCandidate(fingerprint), "fingerprint", "fingerprint_mismatch", "fingerprint");
  const binding = replaceResponse(inputFor(), (body) => { body.result.npcId = "npc-beni"; });
  assertRejected(validateNpcReactionCandidate(binding), "binding", "binding_mismatch", "binding");
  const stale = inputFor({ schemaVersion: 1, proposals: [{ proposalType: "unknown" }] }); stale.liveApplicability.stateVersion += 1;
  assertRejected(validateNpcReactionCandidate(stale), "applicability", "stale_request", "live_state");
  const structureBeforeDuplicate = inputFor({ schemaVersion: 1, proposals: [{ proposalType: "unknown" }] }); structureBeforeDuplicate.observedCandidate = { schemaVersion: 1, observationStatus: "observed", reactionAttemptId: structureBeforeDuplicate.request.reactionAttemptId, candidateFingerprint: FINGERPRINT };
  assertRejected(validateNpcReactionCandidate(structureBeforeDuplicate), "structure", "invalid_candidate_schema", "proposal");
  const duplicateBeforeAuthorization = inputFor({ schemaVersion: 1, proposals: [{ proposalType: "role_claim", claimedRole: "seer" }] }); duplicateBeforeAuthorization.request.knownInformation.constraints.roleDisclosurePolicy = "never_confess_werewolf"; duplicateBeforeAuthorization.request.requestFingerprint = requestFingerprint(duplicateBeforeAuthorization.request); synchronizeFingerprint(duplicateBeforeAuthorization); duplicateBeforeAuthorization.observedCandidate = { schemaVersion: 1, observationStatus: "observed", reactionAttemptId: duplicateBeforeAuthorization.request.reactionAttemptId, candidateFingerprint: sha256CanonicalJson({ schemaVersion: 1, proposals: [{ proposalType: "role_claim", claimedRole: "seer" }] }) };
  assertRejected(validateNpcReactionCandidate(duplicateBeforeAuthorization), "duplicate", "duplicate_response", "provider_result");
  const terminalBeforeAuthorization = withStatuses("exhausted", "timed_out"); terminalBeforeAuthorization.request.knownInformation.constraints.roleDisclosurePolicy = "never_confess_werewolf"; refingerprint(terminalBeforeAuthorization); replaceResponse(terminalBeforeAuthorization, (body) => { body.result.candidate = { schemaVersion: 1, proposals: [{ proposalType: "role_claim", claimedRole: "seer" }] }; });
  assertRejected(validateNpcReactionCandidate(terminalBeforeAuthorization), "duplicate", "duplicate_response", "provider_result");
  const terminalStructure = withStatuses("exhausted", "timed_out"); replaceResponse(terminalStructure, (body) => { body.result.candidate = { schemaVersion: 1, proposals: [{ proposalType: "unknown" }] }; });
  assertRejected(validateNpcReactionCandidate(terminalStructure), "structure", "invalid_candidate_schema", "proposal");
});

test("strict candidate union rejects missing, null, extra, unsupported, bounds, and nesting", () => {
  const invalid = [
    null,
    { schemaVersion: 1, proposals: [] },
    { schemaVersion: 1, proposals: Array.from({ length: 17 }, () => ({ proposalType: "suspicion", targetId: "npc-beni" })) },
    { schemaVersion: 1, proposals: [{ proposalType: "role_claim" }] },
    { schemaVersion: 1, proposals: [{ proposalType: "result_claim", targetId: "npc-beni", result: null }] },
    { schemaVersion: 1, proposals: [{ proposalType: "suspicion", targetId: "npc-beni", message: "secret" }] },
    { schemaVersion: 1, proposals: [{ proposalType: "unknown" }] }
  ];
  for (const candidate of invalid) assertRejected(validateNpcReactionCandidate(inputFor(candidate)), "structure", "invalid_candidate_schema", candidate === null || candidate?.proposals?.length !== 1 ? "candidate" : "proposal");
  for (const proposalType of ["commentary", "answer", "acknowledgement", "decline", "clarification"]) {
    assertRejected(validateNpcReactionCandidate(inputFor({ schemaVersion: 1, proposals: [{ proposalType }] })), "structure", "unsupported_in_phase6", "proposal");
  }
});

test("strict HTTP and provider envelopes reject missing, null, extra fields and numeric bounds", () => {
  const cases = [
    [(body) => { body.extra = true; }, "http_envelope"],
    [(body) => { delete body.serverCorrelationId; }, "http_envelope"],
    [(body) => { body.serverCorrelationId = null; }, "http_envelope"],
    [(body) => { body.result.extra = true; }, "provider_result"],
    [(body) => { delete body.result.diagnostics; }, "provider_result"],
    [(body) => { body.result.diagnostics.extra = true; }, "provider_result"],
    [(body) => { body.result.turnOrder = Number.MAX_SAFE_INTEGER + 1; }, "provider_result"],
    [(body) => { body.result.diagnostics.elapsedMs = -1; }, "provider_result"]
  ];
  for (const [mutate, location] of cases) {
    assertRejected(validateNpcReactionCandidate(replaceResponse(inputFor(), mutate)), "transport", "invalid_envelope", location);
  }
  const invalidRequestInteger = inputFor(); invalidRequestInteger.request.turnOrder = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => validateNpcReactionCandidate(invalidRequestInteger), (error) => error.code === "invalid_expected_request");
  const invalidPendingInteger = inputFor(); invalidPendingInteger.pendingAttempt.turnOrder = -1;
  assert.throws(() => validateNpcReactionCandidate(invalidPendingInteger), (error) => error.code === "invalid_expected_pending_attempt");
  const invalidPendingDate = inputFor(); invalidPendingDate.pendingAttempt.startedAt = "2026-02-30T00:00:00Z";
  assert.throws(() => validateNpcReactionCandidate(invalidPendingDate), (error) => error.code === "invalid_expected_pending_attempt");
  const invalidLiveArray = inputFor(); invalidLiveArray.liveApplicability.participants = Array.from({ length: 17 }, (_, index) => ({ participantId: `npc-${index}`, participantClass: "npc", publicStatus: "alive" }));
  assert.throws(() => validateNpcReactionCandidate(invalidLiveArray), (error) => error.code === "invalid_live_applicability_snapshot");
  const sparseProjection = inputFor(); sparseProjection.request.knownInformation.public.claims = Array(1);
  assert.throws(() => validateNpcReactionCandidate(sparseProjection), (error) => error.code === "invalid_expected_request");
  const symbolProjection = inputFor(); symbolProjection.request.knownInformation[Symbol("private")] = true;
  assert.throws(() => validateNpcReactionCandidate(symbolProjection), (error) => error.code === "invalid_expected_request");
});

test("binding echoes are compared across every immutable dimension", () => {
  const fields = ["gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId", "requestFingerprint", "correlationId", "causationId", "originatingInputRecordId", "turnId", "turnOrder", "preconditionPhase", "preconditionStateVersion", "npcId"];
  for (const field of fields) {
    const input = replaceResponse(inputFor(), (body) => { body.result[field] = typeof body.result[field] === "number" ? body.result[field] + 1 : field === "requestFingerprint" ? "b".repeat(64) : field === "preconditionPhase" ? "day_discussion" : `different-${field}`; });
    if (["requestId", "correlationId", "reactionPlanId", "reactionAttemptId"].includes(field)) replaceResponse(input, (body) => { body[field] = body.result[field]; });
    assertRejected(validateNpcReactionCandidate(input), "binding", "binding_mismatch", "binding");
  }
});

test("authorization enforces policy, actor-owned result facts, and target eligibility", () => {
  const denied = inputFor({ schemaVersion: 1, proposals: [{ proposalType: "role_claim", claimedRole: "seer" }] }); denied.request.knownInformation.constraints.roleDisclosurePolicy = "avoid_unnecessary_claim"; refingerprint(denied);
  assertRejected(validateNpcReactionCandidate(denied), "authorization", "permission_denied", "policy");
  const unknownPolicy = inputFor(); unknownPolicy.request.knownInformation.constraints.roleDisclosurePolicy = "future_policy"; refingerprint(unknownPolicy);
  assertRejected(validateNpcReactionCandidate(unknownPolicy), "authorization", "role_disclosure_policy_unknown", "policy");
  const mismatch = inputFor({ schemaVersion: 1, proposals: [{ proposalType: "result_claim", targetId: "npc-beni", result: "not_werewolf" }] });
  mismatch.request.knownInformation.public.participants.splice(2, 0, { participantId: "npc-chika", displayName: "Chika", publicStatus: "alive" });
  mismatch.request.knownInformation.actorPrivate.investigationResults.push({ day: 1, targetId: "npc-chika", result: "not_werewolf", disclosurePolicy: "engine_policy_required" });
  mismatch.request.knownInformation.constraints.allowedTargetIds.push("npc-chika");
  mismatch.request.knownInformation.constraints.allowedLivingTargetIds.push("npc-chika");
  mismatch.request.knownInformation.constraints.allowedResultTargetIds.push("npc-chika");
  mismatch.request.knownInformation.constraints.allowedResultValues.push("not_werewolf");
  mismatch.liveApplicability.participants.splice(2, 0, { participantId: "npc-chika", participantClass: "npc", publicStatus: "alive" });
  refingerprint(mismatch);
  assertRejected(validateNpcReactionCandidate(mismatch), "authorization", "result_fact_mismatch", "known_information");
  const dead = inputFor({ schemaVersion: 1, proposals: [{ proposalType: "vote_declaration", targetId: "npc-beni" }] }); dead.liveApplicability.participants[1].publicStatus = "dead";
  assertRejected(validateNpcReactionCandidate(dead), "applicability", "stale_request", "live_state");
});

test("whole-candidate duplicates and contradictions fail atomically", () => {
  const duplicate = { schemaVersion: 1, proposals: [{ proposalType: "suspicion", targetId: "npc-beni" }, { proposalType: "suspicion", targetId: "npc-beni" }] };
  assertRejected(validateNpcReactionCandidate(inputFor(duplicate)), "authorization", "duplicate_proposal", "proposal");
  const contradictory = inputFor({ schemaVersion: 1, proposals: [{ proposalType: "vote_declaration", targetId: "npc-beni" }, { proposalType: "vote_declaration", targetId: "npc-chika" }] });
  contradictory.request.knownInformation.public.participants.splice(2, 0, { participantId: "npc-chika", displayName: "Chika", publicStatus: "alive" });
  contradictory.request.knownInformation.constraints.allowedTargetIds.push("npc-chika");
  contradictory.request.knownInformation.constraints.allowedLivingTargetIds.push("npc-chika");
  contradictory.liveApplicability.participants.splice(2, 0, { participantId: "npc-chika", participantClass: "npc", publicStatus: "alive" });
  refingerprint(contradictory);
  assertRejected(validateNpcReactionCandidate(contradictory), "authorization", "contradictory_proposals", "proposal");
});

test("captured and current reference boundaries reject unknown and ineligible targets", () => {
  const unknown = inputFor({ schemaVersion: 1, proposals: [{ proposalType: "suspicion", targetId: "npc-unknown" }] });
  assertRejected(validateNpcReactionCandidate(unknown), "authorization", "unknown_reference", "reference");
  const disallowed = inputFor({ schemaVersion: 1, proposals: [{ proposalType: "suspicion", targetId: "npc-aoi" }] });
  assertRejected(validateNpcReactionCandidate(disallowed), "authorization", "target_ineligible", "target");
});

test("attempt and logical status routes cover ordinary, stale, terminal duplicate, and conflict", () => {
  const ordinary = inputFor(); assert.equal(validateNpcReactionCandidate(ordinary).status, "validated");
  const attempting = withStatuses("active", "attempting"); assertRejected(validateNpcReactionCandidate(attempting), "applicability", "stale_request", "live_state");
  const validated = withStatuses("active", "validated", { observed: "same" }); assertRejected(validateNpcReactionCandidate(validated), "duplicate", "duplicate_response", "provider_result");
  const accepted = withStatuses("committed", "accepted", { committed: true, observed: "same" }); assertRejected(validateNpcReactionCandidate(accepted), "duplicate", "duplicate_response", "provider_result");
  for (const [logicalStatus, attemptStatus] of [["active", "failed"], ["exhausted", "timed_out"], ["rejected", "rejected"], ["cancelled", "aborted"]]) {
    const value = withStatuses(logicalStatus, attemptStatus);
    assertRejected(validateNpcReactionCandidate(value), "duplicate", "duplicate_response", "provider_result");
  }
  const losing = withStatuses("committed", "failed", { committed: true, winner: false }); assertRejected(validateNpcReactionCandidate(losing), "duplicate", "duplicate_response", "provider_result");
  const conflict = withStatuses("active", "failed", { observed: "different" }); assertRejected(validateNpcReactionCandidate(conflict), "duplicate", "attempt_response_conflict", "provider_result");
  const superseded = withStatuses("superseded", "aborted"); assertRejected(validateNpcReactionCandidate(superseded), "applicability", "stale_request", "live_state");
});

test("validated and accepted attempts require prior engine-owned observation", () => {
  for (const [logicalStatus, attemptStatus, committed] of [["active", "validated", false], ["committed", "accepted", true]]) {
    const input = withStatuses(logicalStatus, attemptStatus, { committed });
    assert.throws(() => validateNpcReactionCandidate(input), (error) => error.code === "invalid_observed_candidate");
  }
});

test("terminal delivery without fingerprint is suppression only and does not mutate or store fingerprint", () => {
  const input = withStatuses("exhausted", "timed_out");
  const before = structuredClone(input);
  const result = validateNpcReactionCandidate(input);
  assertRejected(result, "duplicate", "duplicate_response", "provider_result");
  assert.deepEqual(input, before);
  assert.equal(JSON.stringify(result).includes("candidateFingerprint"), false);
});

test("hard stale dimensions and status races precede duplicate comparison", () => {
  const mutations = [
    (live) => { live.gameSessionId = "game-session-2"; },
    (live) => { live.turnId = "turn-2"; live.triggeringPlayerCommit.turnId = "turn-2"; live.triggeringInput.turnId = "turn-2"; },
    (live) => { live.phase = "day_discussion"; },
    (live) => { live.stateVersion += 1; },
    (live) => { live.npcId = "npc-beni"; },
    (live) => { live.causationId = "player-request-2"; live.triggeringPlayerCommit.requestId = "player-request-2"; live.triggeringInput.requestId = "player-request-2"; },
    (live) => { live.reactionAttemptId = "reaction-attempt-2"; },
    (live) => { live.participants[1].publicStatus = "dead"; }
  ];
  for (const mutate of mutations) {
    const input = inputFor(); input.observedCandidate = { schemaVersion: 1, observationStatus: "observed", reactionAttemptId: input.request.reactionAttemptId, candidateFingerprint: sha256CanonicalJson({ schemaVersion: 1, proposals: [{ proposalType: "suspicion", targetId: "npc-beni" }] }) }; mutate(input.liveApplicability);
    assertRejected(validateNpcReactionCandidate(input), "applicability", "stale_request", "live_state");
  }
  const race = inputFor(); race.liveApplicability.reactionAttemptStatus = "timed_out";
  assertRejected(validateNpcReactionCandidate(race), "applicability", "stale_request", "live_state");
  const committedLater = withStatuses("committed", "accepted", { committed: true, observed: "same" }); committedLater.liveApplicability.stateVersion += 1;
  assertRejected(validateNpcReactionCandidate(committedLater), "applicability", "stale_request", "live_state");
});

test("logical/request aliasing is classified before stale applicability", () => {
  const samePlanDifferentRequest = inputFor(); samePlanDifferentRequest.liveApplicability.requestId = "reaction-request-2";
  assertRejected(validateNpcReactionCandidate(samePlanDifferentRequest), "duplicate", "idempotency_conflict", "binding");
  const differentPlanSameRequest = inputFor(); differentPlanSameRequest.liveApplicability.reactionPlanId = "reaction-plan-2";
  assertRejected(validateNpcReactionCandidate(differentPlanSameRequest), "duplicate", "idempotency_conflict", "binding");
  const differentPlanSameTrigger = inputFor(); differentPlanSameTrigger.liveApplicability.reactionPlanId = "reaction-plan-2"; differentPlanSameTrigger.liveApplicability.requestId = "reaction-request-2";
  assertRejected(validateNpcReactionCandidate(differentPlanSameTrigger), "duplicate", "idempotency_conflict", "binding");
});

test("rejections remain closed, bounded, redacted, immutable, and non-retryable", () => {
  assert.equal(new Set(NPC_REACTION_CANDIDATE_REJECTION_CODES).size, NPC_REACTION_CANDIDATE_REJECTION_CODES.length);
  const input = replaceResponse(inputFor(), (body) => { body.result.npcId = "npc-beni"; body.result.candidate.secret = "private investigation"; });
  const result = validateNpcReactionCandidate(input);
  assert.equal(result.rejection.diagnostics.length, 1);
  assert.ok(result.rejection.diagnostics.length <= 8);
  assert.equal(result.rejection.retryable, false);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("private investigation"), false);
  assert.equal(serialized.includes("bodyBytes"), false);
  assert.deepEqual(Object.keys(result.rejection.diagnostics[0]).sort(), ["code", "location"]);
});

function requestFingerprint(request) {
  return sha256CanonicalJson(Object.fromEntries(REQUEST_FIELDS.filter((field) => !["reactionAttemptId", "requestFingerprint"].includes(field)).map((field) => [field, request[field]])));
}

function synchronizeFingerprint(input) {
  input.pendingAttempt.requestFingerprint = input.request.requestFingerprint;
  input.liveApplicability.requestFingerprint = input.request.requestFingerprint;
  replaceResponse(input, (body) => { body.result.requestFingerprint = input.request.requestFingerprint; });
}

function refingerprint(input) {
  input.request.requestFingerprint = requestFingerprint(input.request);
  synchronizeFingerprint(input);
}

function withStatuses(logicalStatus, attemptStatus, { committed = false, winner = true, observed = "none" } = {}) {
  const input = inputFor();
  input.pendingAttempt.status = attemptStatus;
  input.liveApplicability = live(input.request, { logicalStatus, attemptStatus, committed, winner });
  if (observed !== "none") {
    const candidate = { schemaVersion: 1, proposals: [{ proposalType: "suspicion", targetId: "npc-beni" }] };
    input.observedCandidate = { schemaVersion: 1, observationStatus: "observed", reactionAttemptId: input.request.reactionAttemptId, candidateFingerprint: observed === "same" ? sha256CanonicalJson(candidate) : "b".repeat(64) };
  }
  return input;
}
