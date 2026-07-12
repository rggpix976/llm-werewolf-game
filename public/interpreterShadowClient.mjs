import { validateInterpreterRequest } from "../src/conversation/contracts.mjs";

const candidateTypes = Object.freeze(["non_game_statement", "question", "suspicion", "vote_declaration", "role_claim", "result_claim", "information_request", "uninterpretable"]);

export function shouldObserveInterpreterShadow(runtimeConfig = {}) {
  return runtimeConfig.interpreterShadowMode === true && runtimeConfig.interpreterValidationMode !== true;
}

export function buildShadowInterpreterRequest({ snapshot, rawText, binding, requestId, correlationId }) {
  const roster = [{ playerId: "player", displayName: "Player", publicStatus: "alive" }, ...snapshot.players.map((player) => ({ playerId: player.id, displayName: player.name, publicStatus: player.alive ? "alive" : "dead" }))];
  const request = { schemaVersion: 1, requestId, correlationId, inputRecordId: binding.inputRecordId, turnId: binding.shadowTurnId, preconditionStateVersion: binding.shadowSnapshotVersion, preconditionPhase: snapshot.phase, locale: "ja-JP", rawText, playerContext: { playerId: "player", publicStatus: "alive" }, publicRoster: roster, allowedCandidateTypes: [...candidateTypes], publicContext: { publicEvents: [], publicClaims: [], publicVotes: [], executions: [], attackDeaths: [] }, limits: { maxAlternatives: 3, maxActsPerAlternative: 4, maxNestingDepth: 8 } };
  return validateInterpreterRequest(request);
}

export class InterpreterShadowClient {
  constructor({ provider, sessionManager, observer = () => {}, createId = () => crypto.randomUUID(), now = () => performance.now() }) { this.provider = provider; this.sessionManager = sessionManager; this.observer = observer; this.createId = createId; this.now = now; }

  observe({ snapshot, rawText, gameId, targetNpcId }) {
    const binding = this.sessionManager.stageShadowInput({ rawText }), request = buildShadowInterpreterRequest({ snapshot, rawText, binding, requestId: `interpreter-${this.createId()}`, correlationId: `correlation-${this.createId()}` }), started = this.now();
    void this.provider.interpretPlayerInput(request, { targetNpcId }).then((response) => {
      if (!this.sessionManager.isCurrentGame(gameId) || this.sessionManager.sessionId !== binding.sessionId) return;
      this.observer({ status: "success", requestId: request.requestId, clientCorrelationId: request.correlationId, serverCorrelationId: response.serverCorrelationId, durationMs: Math.max(0, this.now() - started), attemptCount: response.result.diagnostics.attemptCount, alternativeCount: response.result.modelOutput.alternatives.length, endpoint: "/api/interpret-player-input" });
    }, (error) => {
      if (!this.sessionManager.isCurrentGame(gameId) || this.sessionManager.sessionId !== binding.sessionId || error?.name === "AbortError") return;
      this.observer({ status: "failure", requestId: request.requestId, clientCorrelationId: request.correlationId, durationMs: Math.max(0, this.now() - started), errorCode: error?.code ?? "provider_unavailable", endpoint: "/api/interpret-player-input" });
    });
    return request.requestId;
  }
}
