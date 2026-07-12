import { validateInterpreterHttpResponse, validateInterpreterRequest, validatePendingConversationRequest } from "./conversation/contracts.mjs";
import { candidateFields } from "./conversation/domain.mjs";
import { sha256Fingerprint } from "./conversation/ids.mjs";
import { validatePlayerInputRecord, validateSpeechActCandidates } from "./conversation/validators.mjs";

const phaseCandidates = Object.freeze({
  day_discussion: Object.freeze(["non_game_statement", "question", "suspicion", "role_claim", "result_claim", "information_request", "uninterpretable"]),
  player_question: Object.freeze(["uninterpretable"]), npc_response: Object.freeze(["uninterpretable"]),
  vote: Object.freeze(["vote_declaration", "information_request", "uninterpretable"]),
  execution: Object.freeze(["uninterpretable"]), night: Object.freeze(["uninterpretable"]),
  seer_action: Object.freeze(["uninterpretable"]), werewolf_attack: Object.freeze(["uninterpretable"]), win_check: Object.freeze(["uninterpretable"])
});

export function createPhase3Binding({ state, rawText, targetNpcId, createId }) {
  const requestId = `interpreter-${createId()}`, correlationId = `correlation-${createId()}`, inputRecordId = `input-${createId()}`;
  const publicRoster = [{ playerId: "player", displayName: "Player", publicStatus: "alive" }, ...state.players.map((player) => ({ playerId: player.id, displayName: player.name, publicStatus: player.alive ? "alive" : "dead" }))];
  const allowedCandidateTypes = [...phaseCandidates[state.phase]];
  const request = validateInterpreterRequest({ schemaVersion: 1, requestId, correlationId, inputRecordId, turnId: state.turnId, preconditionStateVersion: state.stateVersion, preconditionPhase: state.phase, locale: "ja-JP", rawText, playerContext: { playerId: "player", publicStatus: "alive" }, publicRoster, allowedCandidateTypes, publicContext: { publicEvents: [], publicClaims: [], publicVotes: [], executions: [], attackDeaths: [] }, limits: { maxAlternatives: 3, maxActsPerAlternative: 4, maxNestingDepth: 8 } });
  const inputRecord = validatePlayerInputRecord({ schemaVersion: 1, inputRecordId, requestId, correlationId, turnId: state.turnId, capturedStateVersion: state.stateVersion, actorId: "player", rawText, locale: "ja-JP", createdOrder: state.conversation?.nextCreatedOrder ?? state.turnOrder });
  const pendingRecord = validatePendingConversationRequest({ schemaVersion: 1, pendingType: "interpreter", requestId, correlationId, turnId: state.turnId, preconditionStateVersion: state.stateVersion, inputRecordId, targetNpcId, operation: "interpret_player_input", status: "pending", startedAt: new Date().toISOString() });
  return deepFreeze({ gameSessionId: state.gameSessionId, turnId: state.turnId, turnOrder: state.turnOrder, preconditionStateVersion: state.stateVersion, preconditionPhase: state.phase, actorId: "player", inputRecordId, requestId, correlationId, targetNpcId, requestFingerprint: sha256Fingerprint(request), request: structuredClone(request), pendingRecord: structuredClone(pendingRecord), stagedInput: { status: "staged", record: structuredClone(inputRecord) } });
}

export function validatePhase3Response(response, binding, state) {
  validateInterpreterHttpResponse(response, binding.request);
  const stale = staleReason(binding, state); if (stale) return { category: stale === "idempotency_conflict" ? "conflict" : "stale", reasonCode: stale, stale: stale !== "idempotency_conflict", candidateCount: 0, alternativeCount: response.result.modelOutput.alternatives.length };
  const alternatives = response.result.modelOutput.alternatives;
  if (alternatives.length > 1) return outcome("clarification", "multiple_alternatives", alternatives);
  const acts = alternatives[0].speechActs;
  if (acts.length === 1 && acts[0].type === "uninterpretable") return outcome("clarification", "uninterpretable", alternatives);
  try { validateSemanticSet(acts, binding, state); return { ...outcome("validated", "candidate_valid", alternatives), selectedAlternative: deepFreeze(structuredClone(alternatives[0])) }; }
  catch (error) { return { ...outcome("rejected", error.code ?? "candidate_rejected", alternatives), rejectionPath: error.path }; }
}

function staleReason(binding, state) {
  if (binding.requestId !== binding.request.requestId || binding.correlationId !== binding.request.correlationId) return "correlation_mismatch";
  if (binding.inputRecordId !== binding.request.inputRecordId || binding.stagedInput.record.inputRecordId !== binding.inputRecordId || binding.pendingRecord.inputRecordId !== binding.inputRecordId) return "stale_input";
  if (binding.turnId !== binding.request.turnId || binding.pendingRecord.turnId !== binding.turnId) return "stale_turn";
  if (binding.preconditionStateVersion !== binding.request.preconditionStateVersion || binding.pendingRecord.preconditionStateVersion !== binding.preconditionStateVersion) return "stale_state_version";
  if (binding.preconditionPhase !== binding.request.preconditionPhase) return "stale_phase";
  if (binding.actorId !== binding.request.playerContext.playerId || binding.stagedInput.record.actorId !== binding.actorId) return "stale_actor";
  if (binding.requestFingerprint !== sha256Fingerprint(binding.request)) return "idempotency_conflict";
  if (binding.gameSessionId !== state.gameSessionId) return "stale_session";
  if (binding.turnId !== state.turnId) return "stale_turn";
  if (binding.preconditionStateVersion !== state.stateVersion) return "stale_state_version";
  if (binding.preconditionPhase !== state.phase) return "stale_phase";
  if (binding.actorId !== "player") return "stale_actor";
  return null;
}

function outcome(category, reasonCode, alternatives) { return { category, reasonCode, stale: false, alternativeCount: alternatives.length, candidateCount: alternatives.reduce((sum, alternative) => sum + alternative.speechActs.length, 0) }; }

function validateSemanticSet(acts, binding, state) {
  validateSpeechActCandidates(acts, binding.request.rawText);
  const roster = new Map(binding.request.publicRoster.map((entry) => [entry.playerId, entry]));
  for (const [index, act] of acts.entries()) {
    if (!binding.request.allowedCandidateTypes.includes(act.type)) fail(`speechActs[${index}].type`, "candidate_not_allowed");
    if (!Object.hasOwn(candidateFields, act.type)) fail(`speechActs[${index}].type`, "invalid_discriminator");
    if (act.targetId) {
      const target = roster.get(act.targetId); if (!target) fail(`speechActs[${index}].targetId`, "invalid_reference");
      if (act.targetId === "player") fail(`speechActs[${index}].targetId`, "invalid_target_class");
      if (["question", "suspicion", "vote_declaration"].includes(act.type) && target.publicStatus !== "alive") fail(`speechActs[${index}].targetId`, "target_not_alive");
    }
  }
  if (binding.preconditionPhase !== state.phase) fail("preconditionPhase", "stale_phase");
}

function fail(path, code) { const error = new TypeError(code); error.code = code; error.path = path; throw error; }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
