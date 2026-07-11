/**
 * Browser-side response provider that calls the server API.
 */
export class HttpResponseProvider {
  constructor(options = {}) {
    this.name = "http-provider";
    this.sessionManager = options.sessionManager;
    this.fetch = options.fetch;
  }

  async generateResponse(request) {
    const controller = new AbortController();

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
      if (this.sessionManager) {
        this.sessionManager.unregisterRequest(controller);
      }
    }
  }

  async interpretPlayerInput(request, options = {}) {
    validateInterpreterRequest(request);
    const controller = new AbortController(), pending = { schemaVersion: 1, pendingType: "interpreter", requestId: request.requestId, correlationId: request.correlationId, turnId: request.turnId, preconditionStateVersion: request.preconditionStateVersion, inputRecordId: request.requestId, targetNpcId: options.targetNpcId ?? request.publicRoster.find((entry) => entry.playerId !== request.playerContext.playerId)?.playerId ?? request.playerContext.playerId, operation: "interpret_player_input", status: "pending", startedAt: new Date().toISOString() };
    validatePendingConversationRequest(pending);
    if (this.sessionManager) this.sessionManager.registerPendingRequest(pending, controller);
    let terminalStatus = "failed";
    try {
      const response = await (this.fetch ?? globalThis.fetch)("/api/interpret-player-input", { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(request), signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) { let validatedError; try { validatedError = validateErrorEnvelope(body); } catch { const malformed = new Error("Interpreter error response was invalid"); malformed.name = "InterpreterTransportError"; malformed.status = response.status; malformed.code = "invalid_provider_response"; malformed.retryable = false; throw malformed; } const error = new Error("Interpreter transport failed"); error.name = "InterpreterTransportError"; error.status = response.status; error.code = validatedError.error.code; error.retryable = validatedError.error.retryable; throw error; }
      if (!body) throw new TypeError("Interpreter HTTP response must be JSON");
      const validated = validateInterpreterHttpResponse(body, request); terminalStatus = "completed"; return validated;
    } finally {
      if (this.sessionManager) this.sessionManager.completePendingRequest(request.requestId, terminalStatus);
    }
  }
}

/**
 * Manages game sessions and request cancellation.
 */
export class SessionManager {
  constructor() {
    this.activeControllers = new Set();
    this.pendingRequests = new Map();
    this.currentGameId = 0;
  }

  startNewGame() {
    this.currentGameId++;
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
    this.pendingRequests.clear();
    return this.currentGameId;
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
    this.unregisterRequest(active.controller);
    return true;
  }

  isCurrentGame(gameId) {
    return gameId === this.currentGameId;
  }
}
import { validateErrorEnvelope, validateInterpreterHttpResponse, validateInterpreterRequest, validatePendingConversationRequest } from "../src/conversation/contracts.mjs";
