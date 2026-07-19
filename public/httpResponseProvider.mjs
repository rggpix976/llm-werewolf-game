/**
 * Browser-side response provider that calls the server API.
 */
export class HttpResponseProvider {
  constructor(options = {}) {
    this.name = "http-provider";
    this.sessionManager = options.sessionManager;
    this.fetch = options.fetch;
  }

  async generateResponse(request, options = {}) {
    const controller = new AbortController(), onExternalAbort = () => controller.abort(options.signal.reason);
    if (options.signal?.aborted) controller.abort(options.signal.reason);
    else options.signal?.addEventListener("abort", onExternalAbort, { once: true });

    // Register the request for cancellation if a new game starts
    if (this.sessionManager) {
      this.sessionManager.registerRequest(controller);
    }

    try {
      const response = await (this.fetch ?? globalThis.fetch)("/api/npc-response", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(errorData.error || `HTTP ${response.status}`);
        error.name = "ResponseProviderError";
        error.status = response.status;
        error.type = errorData.type;
        error.diagnostics = errorData.diagnostics;
        throw error;
      }

      return await response.json();
    } finally {
      options.signal?.removeEventListener("abort", onExternalAbort);
      if (this.sessionManager) {
        this.sessionManager.unregisterRequest(controller);
      }
    }
  }

  async interpretPlayerInput(request, options = {}) {
    validateInterpreterRequest(request);
    const controller = new AbortController(), onExternalAbort = () => controller.abort(options.signal.reason), pending = { schemaVersion: 1, pendingType: "interpreter", requestId: request.requestId, correlationId: request.correlationId, turnId: request.turnId, preconditionStateVersion: request.preconditionStateVersion, inputRecordId: request.inputRecordId, targetNpcId: options.targetNpcId ?? request.publicRoster.find((entry) => entry.playerId !== request.playerContext.playerId)?.playerId ?? request.playerContext.playerId, operation: "interpret_player_input", status: "pending", startedAt: new Date().toISOString() };
    validatePendingConversationRequest(pending);
    if (options.signal?.aborted) controller.abort(options.signal.reason);
    else options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (this.sessionManager) this.sessionManager.registerPendingRequest(pending, controller);
    let terminalStatus = "failed";
    try {
      const response = await (this.fetch ?? globalThis.fetch)("/api/interpret-player-input", { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(request), signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) { let validatedError; try { validatedError = validateErrorEnvelope(body); } catch { const malformed = new Error("Interpreter error response was invalid"); malformed.name = "InterpreterTransportError"; malformed.status = response.status; malformed.code = "invalid_provider_response"; malformed.retryable = false; throw malformed; } const error = new Error("Interpreter transport failed"); error.name = "InterpreterTransportError"; error.status = response.status; error.code = validatedError.error.code; error.retryable = validatedError.error.retryable; throw error; }
      if (!body) throw new TypeError("Interpreter HTTP response must be JSON");
      const validated = validateInterpreterHttpResponse(body, request); terminalStatus = "completed"; return validated;
    } finally {
      options.signal?.removeEventListener("abort", onExternalAbort);
      if (this.sessionManager) this.sessionManager.completePendingRequest(request.requestId, terminalStatus);
    }
  }

  async generateCandidateTransport(request, options = {}) {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(options.signal.reason);
    if (options.signal?.aborted) controller.abort(options.signal.reason);
    else options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    this.sessionManager?.registerRequest(controller);
    try {
      const response = await (this.fetch ?? globalThis.fetch)("/api/generate-npc-reaction-candidate", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(request),
        signal: controller.signal
      });
      const bodyBytes = new Uint8Array(await response.arrayBuffer());
      if (response.status === 200) {
        return Object.freeze({
          schemaVersion: 1,
          status: "success",
          transportEvidence: Object.freeze({
            schemaVersion: 1,
            evidenceType: "npc_reaction_candidate_http_success",
            httpStatus: 200,
            contentTypeHeader: response.headers.get("content-type"),
            contentEncodingHeader: response.headers.get("content-encoding"),
            bodyBytes
          })
        });
      }
      let body = null;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes)); } catch {}
      return responseToTransport({
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type"),
          "content-encoding": response.headers.get("content-encoding")
        },
        body
      });
    } finally {
      options.signal?.removeEventListener("abort", onExternalAbort);
      this.sessionManager?.unregisterRequest(controller);
    }
  }
}

/**
 * Manages game sessions and request cancellation.
 */
export class SessionManager {
  constructor(options = {}) {
    this.activeControllers = new Set();
    this.pendingRequests = new Map();
    this.shadowInputs = new Map();
    this.currentGameId = 0;
    this.sessionId = null;
    this.shadowSnapshotVersion = 0;
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID());
  }

  startNewGame() {
    this.currentGameId++;
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
    this.pendingRequests.clear();
    this.shadowInputs.clear();
    this.sessionId = `shadow-session-${this.createId()}`;
    this.shadowSnapshotVersion = 0;
    return this.currentGameId;
  }

  stageShadowInput({ rawText, actorId = "player", locale = "ja-JP" }) {
    if (!this.sessionId) throw new TypeError("shadow session has not started");
    const binding = validateShadowInterpreterBinding({ schemaVersion: 1, sessionId: this.sessionId, inputRecordId: `shadow-input-${this.createId()}`, shadowTurnId: `shadow-turn-${this.createId()}`, shadowSnapshotVersion: this.shadowSnapshotVersion++ });
    const record = validateShadowPlayerInputRecord({ ...binding, actorId, rawText, locale });
    this.shadowInputs.set(binding.inputRecordId, Object.freeze(record));
    return Object.freeze(binding);
  }

  registerRequest(controller) {
    this.activeControllers.add(controller);
  }

  unregisterRequest(controller) {
    this.activeControllers.delete(controller);
  }

  registerPendingRequest(pending, controller) {
    if (this.pendingRequests.has(pending.requestId)) throw new TypeError(`duplicate pending request ${pending.requestId}`);
    this.pendingRequests.set(pending.requestId, { pending, controller });
    this.registerRequest(controller);
  }

  completePendingRequest(requestId, status = "completed") {
    const active = this.pendingRequests.get(requestId);
    if (!active) return false;
    active.pending = Object.freeze({ ...active.pending, status });
    this.pendingRequests.delete(requestId);
    this.shadowInputs.delete(active.pending.inputRecordId);
    this.unregisterRequest(active.controller);
    return true;
  }

  isCurrentGame(gameId) {
    return gameId === this.currentGameId;
  }
}
import { validateErrorEnvelope, validateInterpreterHttpResponse, validateInterpreterRequest, validatePendingConversationRequest, validateShadowInterpreterBinding, validateShadowPlayerInputRecord } from "../src/conversation/contracts.mjs";
import { responseToTransport } from "../src/npcReactionCandidateTransport.mjs";
