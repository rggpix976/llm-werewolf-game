/**
 * Browser-side response provider that calls the server API.
 */
export class HttpResponseProvider {
  constructor(options = {}) {
    this.name = "http-provider";
    this.sessionManager = options.sessionManager;
    this.isGuarded = true; // The server already guards the output
  }

  async generateResponse(request) {
    const controller = new AbortController();

    // Register the request for cancellation if a new game starts
    if (this.sessionManager) {
      this.sessionManager.registerRequest(controller);
    }

    try {
      const response = await fetch("/api/npc-response", {
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
}

/**
 * Manages game sessions and request cancellation.
 */
export class SessionManager {
  constructor() {
    this.activeControllers = new Set();
    this.currentGameId = 0;
  }

  startNewGame() {
    this.currentGameId++;
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
    return this.currentGameId;
  }

  registerRequest(controller) {
    this.activeControllers.add(controller);
  }

  unregisterRequest(controller) {
    this.activeControllers.delete(controller);
  }

  isCurrentGame(gameId) {
    return gameId === this.currentGameId;
  }
}
