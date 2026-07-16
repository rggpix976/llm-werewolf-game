import { ID_PATTERN, SCHEMA_VERSION, SHA256_PATTERN, enums } from "./conversation/domain.mjs";
import { sha256CanonicalJson } from "./conversation/ids.mjs";
import { validateNpcKnownInformationProjection } from "./npcKnownInformationProjection.mjs";

export const NPC_REACTION_CANDIDATE_PROVIDER_ERROR_CODES = Object.freeze([
  "aborted",
  "timeout",
  "network_failure",
  "provider_unavailable",
  "rate_limited",
  "authentication_failure",
  "malformed_provider_output",
  "schema_mismatch",
  "invalid_transport_response"
]);

const REQUEST_FIELDS = Object.freeze([
  "schemaVersion", "operation", "gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId",
  "requestFingerprint", "correlationId", "causationId", "originatingInputRecordId", "turnId", "turnOrder",
  "preconditionPhase", "preconditionStateVersion", "npcId", "knownInformation", "limits"
]);
const BINDING_FIELDS = Object.freeze(REQUEST_FIELDS.filter(
  (field) => !["schemaVersion", "operation", "knownInformation", "limits"].includes(field)
));
const RESULT_FIELDS = Object.freeze([
  "schemaVersion", "operation", "gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId",
  "requestFingerprint", "correlationId", "causationId", "originatingInputRecordId", "turnId", "turnOrder",
  "preconditionPhase", "preconditionStateVersion", "npcId", "candidate", "diagnostics"
]);
const HTTP_REQUEST_FIELDS = Object.freeze([
  "method", "path", "contentTypeHeader", "contentEncodingHeader", "bodyBytes"
]);
const CANDIDATE_KINDS = Object.freeze(["role_claim", "result_claim", "vote_declaration", "suspicion"]);
const RESERVED_CANDIDATE_KINDS = Object.freeze([
  "commentary", "answer", "acknowledgement", "decline", "clarification"
]);
const PROVIDER_MESSAGE = "NPC reaction candidate provider failed.";
const REQUEST_LIMIT = 65_536;
const ATTEMPT_TIMEOUT_MS = 5_000;
const MAXIMUM_RETRY_AFTER_MS = 2_000;
const MINIMUM_ATTEMPT_BUDGET_MS = 1_000;
const RESPONSE_VALIDATION_BUDGET_MS = 500;
const INTERNAL_PROVIDER_ERRORS = new WeakSet();

export class NpcReactionCandidateProviderError extends Error {
  constructor(code, retryable = false) {
    if (!NPC_REACTION_CANDIDATE_PROVIDER_ERROR_CODES.includes(code)) code = "provider_unavailable";
    super(PROVIDER_MESSAGE);
    this.name = "NpcReactionCandidateProviderError";
    this.code = code;
    this.retryable = retryable === true;
  }
}

export function createNpcReactionCandidateProvider({
  invokeProvider,
  now = Date.now,
  timeoutMs = ATTEMPT_TIMEOUT_MS,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout
} = {}) {
  if (typeof invokeProvider !== "function" || typeof now !== "function"
    || typeof setTimer !== "function" || typeof clearTimer !== "function"
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ATTEMPT_TIMEOUT_MS) {
    throw new TypeError("Invalid NPC reaction candidate provider dependency.");
  }

  return Object.freeze({
    async generateCandidate(request, { signal } = {}) {
      const validatedRequest = validateRequest(request);
      if (signal !== undefined && !isAbortSignal(signal)) {
        throw new TypeError("Invalid NPC reaction candidate abort signal.");
      }
      if (signal?.aborted) throw providerError("aborted");

      const startedAt = now();
      const controller = new AbortController();
      const timeoutReason = Object.freeze({ timeout: true });
      const forwardAbort = () => controller.abort(signal.reason);
      if (signal) signal.addEventListener("abort", forwardAbort, { once: true });
      let rejectAbort;
      const aborted = new Promise((_, reject) => { rejectAbort = reject; });
      const rejectOnAbort = () => rejectAbort(providerError(
        controller.signal.reason === timeoutReason ? "timeout" : "aborted"
      ));
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      let timer;

      try {
        timer = setTimer(() => controller.abort(timeoutReason), timeoutMs);
        const invocation = Promise.resolve().then(() => invokeProvider(validatedRequest, { signal: controller.signal }));
        const rawResult = await Promise.race([invocation, aborted]);
        const result = validateProviderResult(rawResult, validatedRequest);
        // Time is dependency-injected for deterministic ownership/cleanup tests;
        // diagnostics remain untrusted provider observations and are not rewritten.
        if (!Number.isFinite(now() - startedAt)) throw providerError("invalid_transport_response");
        return result;
      } catch (error) {
        if (error instanceof NpcReactionCandidateProviderError && INTERNAL_PROVIDER_ERRORS.has(error)) throw error;
        if (controller.signal.aborted) {
          throw providerError(controller.signal.reason === timeoutReason ? "timeout" : "aborted");
        }
        const remainingDeadlineMs = Math.max(0, timeoutMs - Math.max(0, now() - startedAt));
        throw normalizeProviderError(error, remainingDeadlineMs);
      } finally {
        if (timer !== undefined) clearTimer(timer);
        controller.signal.removeEventListener("abort", rejectOnAbort);
        signal?.removeEventListener("abort", forwardAbort);
      }
    }
  });
}

export function createNpcReactionCandidateHttpHandler({ provider, createServerCorrelationId } = {}) {
  if (!provider || typeof provider.generateCandidate !== "function" || typeof createServerCorrelationId !== "function") {
    throw new TypeError("Invalid NPC reaction candidate HTTP handler dependency.");
  }
  return Object.freeze({
    async handle(request, { signal } = {}) {
      const serverCorrelationId = createServerCorrelationId();
      assertId(serverCorrelationId);
      if (!isExactObject(request, HTTP_REQUEST_FIELDS) || request.method !== "POST"
        || request.path !== "/api/generate-npc-reaction-candidate"
        || !(request.bodyBytes instanceof Uint8Array)) {
        return errorResponse(400, null, serverCorrelationId, "invalid_schema", false);
      }
      if (signal !== undefined && !isAbortSignal(signal)) throw new TypeError("Invalid NPC reaction candidate HTTP abort signal.");
      if (signal?.aborted) throw providerError("aborted");
      if (!validContentType(request.contentTypeHeader) || request.contentEncodingHeader !== null) {
        return errorResponse(415, null, serverCorrelationId, "unsupported_media_type", false);
      }
      if (request.bodyBytes.byteLength > REQUEST_LIMIT) {
        return errorResponse(413, null, serverCorrelationId, "body_too_large", false);
      }
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(request.bodyBytes);
      } catch {
        return errorResponse(400, null, serverCorrelationId, "malformed_json", false);
      }
      let decoded;
      try {
        decoded = JSON.parse(text);
      } catch {
        return errorResponse(400, null, serverCorrelationId, "malformed_json", false);
      }
      const requestId = isPlainObject(decoded) && ID_PATTERN.test(decoded.requestId ?? "") ? decoded.requestId : null;
      if (isPlainObject(decoded) && Object.hasOwn(decoded, "schemaVersion")
        && decoded.schemaVersion !== SCHEMA_VERSION) {
        return errorResponse(400, requestId, serverCorrelationId, "unsupported_schema_version", false);
      }
      let validatedRequest;
      try {
        validatedRequest = validateRequest(decoded);
      } catch {
        return errorResponse(400, requestId, serverCorrelationId, "invalid_schema", false);
      }
      try {
        const generatedResult = await provider.generateCandidate(validatedRequest, { signal });
        const result = validateProviderResult(generatedResult, validatedRequest);
        return successResponse(serverCorrelationId, validatedRequest, result);
      } catch (error) {
        if (signal?.aborted) throw providerError("aborted");
        return providerFailureResponse(error, requestId, serverCorrelationId);
      }
    }
  });
}

function validateRequest(value) {
  try {
    if (!isExactObject(value, REQUEST_FIELDS) || value.schemaVersion !== SCHEMA_VERSION
      || value.operation !== "generate_npc_reaction_candidate") fail();
    for (const field of ["gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId", "correlationId", "causationId", "originatingInputRecordId", "turnId", "npcId"]) assertId(value[field]);
    if (!SHA256_PATTERN.test(value.requestFingerprint) || !isSafeInteger(value.turnOrder)
      || !isSafeInteger(value.preconditionStateVersion) || value.preconditionPhase !== "player_question") fail();
    if (!isExactObject(value.limits, ["maxProposals", "maxNestingDepth"])
      || value.limits.maxProposals !== 16 || value.limits.maxNestingDepth !== 5) fail();
    if (measureNesting(value, 8) > 8) fail();
    assertStrictDataTree(value.knownInformation);
    validateNpcKnownInformationProjection(value.knownInformation);
    validateProjectionRelations(value);
    const detached = clonePlain(value);
    if (utf8Length(JSON.stringify(detached)) > REQUEST_LIMIT) fail();
    if (sha256CanonicalJson(requestFingerprintInput(detached)) !== detached.requestFingerprint) fail();
    return deepFreeze(detached);
  } catch {
    throw providerError("schema_mismatch");
  }
}

function validateProjectionRelations(request) {
  const projection = request.knownInformation;
  if (projection.public.phase !== request.preconditionPhase || projection.actorPrivate.actorId !== request.npcId) fail();
  const input = projection.public.triggeringInput;
  if (input.requestId !== request.causationId || input.inputRecordId !== request.originatingInputRecordId
    || input.turnId !== request.turnId || input.capturedStateVersion + 1 !== request.preconditionStateVersion) fail();
  const actor = projection.public.participants.filter((entry) => entry.participantId === request.npcId);
  const player = projection.public.participants.filter((entry) => entry.participantId === "player");
  if (actor.length !== 1 || actor[0].publicStatus !== "alive" || player.length !== 1) fail();
}

function validateProviderResult(value, request) {
  if (!isPlainObject(value)) throw providerError("malformed_provider_output");
  try {
    if (!isExactObject(value, RESULT_FIELDS) || value.schemaVersion !== SCHEMA_VERSION
      || value.operation !== "generate_npc_reaction_candidate") fail();
    for (const field of ["gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId", "correlationId", "causationId", "originatingInputRecordId", "turnId", "npcId"]) assertId(value[field]);
    if (!SHA256_PATTERN.test(value.requestFingerprint) || !isSafeInteger(value.turnOrder)
      || !isSafeInteger(value.preconditionStateVersion) || value.preconditionPhase !== "player_question") fail();
    for (const field of BINDING_FIELDS) if (value[field] !== request[field]) fail();
    const candidate = validateCandidate(value.candidate);
    const diagnostics = validateDiagnostics(value.diagnostics);
    const detached = { ...clonePlain(value), candidate, diagnostics };
    if (utf8Length(JSON.stringify(detached)) > REQUEST_LIMIT) fail();
    return deepFreeze(detached);
  } catch (error) {
    if (error instanceof NpcReactionCandidateProviderError) throw error;
    throw providerError("schema_mismatch");
  }
}

function validateCandidate(value) {
  if (!isExactObject(value, ["schemaVersion", "proposals"]) || value.schemaVersion !== SCHEMA_VERSION
    || !isDenseArray(value.proposals) || value.proposals.length < 1 || value.proposals.length > 16
    || measureNesting(value, 5) > 5) fail();
  let claimCount = 0;
  const proposals = value.proposals.map((proposal) => {
    if (RESERVED_CANDIDATE_KINDS.includes(proposal?.proposalType)) {
      if (!isExactObject(proposal, ["proposalType"])) fail();
      return { proposalType: proposal.proposalType };
    }
    const fields = {
      role_claim: ["proposalType", "claimedRole"],
      result_claim: ["proposalType", "targetId", "result"],
      vote_declaration: ["proposalType", "targetId"],
      suspicion: ["proposalType", "targetId"]
    }[proposal?.proposalType];
    if (!fields || !isExactObject(proposal, fields) || !CANDIDATE_KINDS.includes(proposal.proposalType)) fail();
    if (["role_claim", "result_claim"].includes(proposal.proposalType) && ++claimCount > 4) fail();
    if (Object.hasOwn(proposal, "targetId")) assertId(proposal.targetId);
    if (proposal.proposalType === "role_claim" && !enums.claimableRole.includes(proposal.claimedRole)) fail();
    if (proposal.proposalType === "result_claim" && !enums.claimResult.includes(proposal.result)) fail();
    return clonePlain(proposal);
  });
  return deepFreeze({ schemaVersion: SCHEMA_VERSION, proposals });
}

function validateDiagnostics(value) {
  if (!isExactObject(value, ["providerName", "model", "attemptCount", "elapsedMs"])
    || !isBoundedString(value.providerName, 1, 64) || !isBoundedString(value.model, 1, 128)
    || value.attemptCount !== 1 || !isSafeInteger(value.elapsedMs)) fail();
  return deepFreeze(clonePlain(value));
}

function normalizeProviderError(error, remainingDeadlineMs = 0) {
  const status = Number(error?.status ?? error?.upstreamStatus);
  if (status === 401 || status === 403 || ["provider_auth_failure", "authentication_failure"].includes(error?.code)) return providerError("authentication_failure");
  if (status === 429 || ["server_rate_limited", "rate_limited"].includes(error?.code)) {
    return providerError("rate_limited", usableRetryAfter(error?.retryAfterMs, remainingDeadlineMs));
  }
  if (status >= 500 || error?.code === "provider_unavailable") {
    return providerError("provider_unavailable", explicitlyTransient(error, remainingDeadlineMs));
  }
  if (status >= 400 && status < 500) return providerError("invalid_transport_response");
  const mapping = {
    provider_timeout: ["timeout", explicitlyTransient(error, remainingDeadlineMs)],
    timeout: ["timeout", explicitlyTransient(error, remainingDeadlineMs)], aborted: ["aborted", false],
    network_failure: ["network_failure", explicitlyTransient(error, remainingDeadlineMs)], invalid_provider_response: ["malformed_provider_output", false],
    malformed_provider_output: ["malformed_provider_output", false], invalid_schema: ["schema_mismatch", false],
    schema_mismatch: ["schema_mismatch", false], invalid_transport_response: ["invalid_transport_response", false]
  }[error?.code];
  if (mapping) return providerError(mapping[0], mapping[1]);
  if (error?.name === "AbortError") return providerError("aborted");
  if (error instanceof TypeError) return providerError("network_failure", explicitlyTransient(error, remainingDeadlineMs));
  return providerError("provider_unavailable", false);
}

function providerFailureResponse(error, requestId, serverCorrelationId) {
  const normalized = error instanceof NpcReactionCandidateProviderError && INTERNAL_PROVIDER_ERRORS.has(error)
    ? error : normalizeProviderError(error);
  const mapping = {
    timeout: [504, "provider_timeout", normalized.retryable],
    network_failure: [503, "provider_unavailable", normalized.retryable],
    provider_unavailable: [503, "provider_unavailable", normalized.retryable],
    rate_limited: [503, "provider_unavailable", normalized.retryable],
    authentication_failure: [502, "provider_auth_failure", false],
    malformed_provider_output: [502, "invalid_provider_response", false],
    schema_mismatch: [502, "invalid_provider_response", false],
    invalid_transport_response: [502, "invalid_provider_response", false]
  }[normalized.code] ?? [503, "provider_unavailable", false];
  return errorResponse(mapping[0], requestId, serverCorrelationId, mapping[1], mapping[2]);
}

function successResponse(serverCorrelationId, request, result) {
  const response = {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "content-encoding": "identity" },
    body: {
      schemaVersion: SCHEMA_VERSION,
      operation: request.operation,
      requestId: request.requestId,
      correlationId: request.correlationId,
      serverCorrelationId,
      reactionPlanId: request.reactionPlanId,
      reactionAttemptId: request.reactionAttemptId,
      result
    }
  };
  if (utf8Length(JSON.stringify(response.body)) > REQUEST_LIMIT) throw providerError("invalid_transport_response");
  return deepFreeze(response);
}

function errorResponse(status, requestId, correlationId, code, retryable) {
  return deepFreeze({
    status,
    headers: { "content-type": "application/json; charset=utf-8", "content-encoding": "identity" },
    body: { schemaVersion: SCHEMA_VERSION, requestId, correlationId, error: { code, retryable } }
  });
}

function requestFingerprintInput(request) {
  return Object.fromEntries(REQUEST_FIELDS
    .filter((field) => !["reactionAttemptId", "requestFingerprint"].includes(field))
    .map((field) => [field, clonePlain(request[field])]));
}

function validContentType(value) {
  return typeof value === "string" && /^[\t ]*application\/json[\t ]*;[\t ]*charset[\t ]*=[\t ]*utf-8[\t ]*$/i.test(value);
}

function usableRetryAfter(retryAfterMs, remainingDeadlineMs) {
  return Number.isFinite(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= MAXIMUM_RETRY_AFTER_MS
    && retryAfterMs + MINIMUM_ATTEMPT_BUDGET_MS + RESPONSE_VALIDATION_BUDGET_MS <= remainingDeadlineMs;
}

function explicitlyTransient(error, remainingDeadlineMs) {
  return error?.retryable === true
    && remainingDeadlineMs >= MINIMUM_ATTEMPT_BUDGET_MS + RESPONSE_VALIDATION_BUDGET_MS;
}

function isAbortSignal(value) {
  return value && typeof value.aborted === "boolean" && typeof value.addEventListener === "function" && typeof value.removeEventListener === "function";
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isExactObject(value, fields) {
  return isPlainObject(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function isDenseArray(value) {
  return Array.isArray(value) && Object.keys(value).length === value.length;
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value, minimum, maximum) {
  return typeof value === "string" && [...value].length >= minimum && [...value].length <= maximum;
}

function assertId(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail();
}

function assertStrictDataTree(value, seen = new Set()) {
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(); return; }
  if (typeof value !== "object" || seen.has(value)) fail();
  seen.add(value);
  if (Array.isArray(value)) { if (!isDenseArray(value)) fail(); for (const item of value) assertStrictDataTree(item, seen); }
  else { if (!isPlainObject(value)) fail(); for (const item of Object.values(value)) assertStrictDataTree(item, seen); }
  seen.delete(value);
}

function measureNesting(value, maximum, depth = 1, seen = new Set()) {
  if (!value || typeof value !== "object") return depth;
  if (seen.has(value)) return maximum + 1;
  seen.add(value);
  let result = depth;
  for (const child of Object.values(value)) result = Math.max(result, measureNesting(child, maximum, depth + 1, seen));
  seen.delete(value);
  return result;
}

function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clonePlain(child)]));
  return value;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  return value;
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function providerError(code, retryable = false) {
  const error = new NpcReactionCandidateProviderError(code, retryable);
  INTERNAL_PROVIDER_ERRORS.add(error);
  return error;
}

function fail() {
  throw new TypeError("invalid");
}
