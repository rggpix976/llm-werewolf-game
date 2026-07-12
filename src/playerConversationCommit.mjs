import { acceptedTypeForCandidate } from "./conversation/domain.mjs";
import { playerClaimIdempotencyKey, sha256Fingerprint } from "./conversation/ids.mjs";
import { validateCommittedConversationGraph } from "./conversation/references.mjs";
import { validateAcceptedSpeechAct, validateCanonicalClaim, validateConversationCommitResult, validateDisplayPublicationRecord, validatePlayerInputRecord, validatePlayerUtteranceDisplayPlan, validatePublicEvent } from "./conversation/validators.mjs";

const eventType = Object.freeze({
  non_game_statement: "public_statement_recorded", question: "public_question_recorded", suspicion: "suspicion_expressed",
  vote_declaration: "vote_declared", role_claim: "role_claim_recorded", result_claim: "result_claim_recorded"
});

export function resolvePlayerConversationCommitPolicy(config = {}) {
  const enabled = config.playerConversationCommitMode === true;
  if (enabled && config.interpreterValidationMode !== true) throw typedError("invalid_phase4_dependency");
  return Object.freeze({ enabled, interpreterValidationRequired: true });
}

export function preparePlayerConversationCommit({ state, binding, alternative, targetNpcId, createId, fault = () => {} }) {
  assertCommitPreconditions(state, binding, alternative, targetNpcId);
  const existing = state.conversation;
  const replay = existing.idempotencyRecords.find((record) => record.requestId === binding.requestId);
  if (replay) {
    if (replay.requestFingerprint !== binding.requestFingerprint) throw typedError("idempotency_conflict");
    return Object.freeze({ replay: true, result: structuredClone(replay.result) });
  }
  const nextVersion = binding.preconditionStateVersion + 1;
  let createdOrder = existing.nextCreatedOrder, publicationSlotOrder = existing.nextPublicationSlotOrder, recordAppendOrder = existing.nextRecordAppendOrder;
  const inputRecord = structuredClone(binding.stagedInput.record); inputRecord.createdOrder = createdOrder++; validatePlayerInputRecord(inputRecord); fault("input");
  const acts = alternative.speechActs.map((candidate, index) => {
    const act = { schemaVersion: 1, speechActId: id("act", createId), requestId: binding.requestId, acceptedTurnId: binding.turnId, acceptedStateVersion: binding.preconditionStateVersion, acceptedPhase: binding.preconditionPhase, inputRecordId: binding.inputRecordId, actorId: binding.actorId, causationId: binding.inputRecordId, correlationId: binding.correlationId, idempotencyKey: sha256Fingerprint(binding.requestId, binding.inputRecordId, index, candidate), sourceSpan: structuredClone(candidate.sourceSpan), type: acceptedTypeForCandidate[candidate.type] };
    for (const key of Object.keys(candidate)) if (!new Set(["type", "sourceSpan"]).has(key)) act[key] = candidate[key];
    validateAcceptedSpeechAct(act, inputRecord.rawText); return act;
  }); fault("acts");
  const claims = [], events = [], claimForAct = new Map(), eventForAct = new Map();
  for (const [index, candidate] of alternative.speechActs.entries()) {
    const act = acts[index];
    if (candidate.type === "role_claim" || candidate.type === "result_claim") {
      const prior = [...existing.claims, ...claims], relation = claimRelation(prior, candidate, binding.actorId);
      const source = { sourceType: "player_accepted_act", acceptedSpeechActIds: [act.speechActId], inputRecordId: binding.inputRecordId, requestId: binding.requestId };
      const claim = { schemaVersion: 1, claimId: id("claim", createId), claimRevision: 1, actorId: binding.actorId, source, idempotencyKey: playerClaimIdempotencyKey({ requestId: binding.requestId, acceptedSpeechActIds: source.acceptedSpeechActIds, actorId: binding.actorId, claimKind: candidate.type }), createdTurnId: binding.turnId, createdStateVersion: nextVersion, repeatsClaimId: relation.repeat, contradictsClaimIds: relation.contradictions, status: "asserted", type: candidate.type };
      if (candidate.type === "role_claim") claim.claimedRole = candidate.claimedRole; else { claim.targetId = candidate.targetId; claim.result = candidate.result; }
      validateCanonicalClaim(claim); claims.push(claim); claimForAct.set(act.speechActId, claim);
    }
    if (eventType[candidate.type]) {
      const event = { schemaVersion: 1, eventId: id("event", createId), requestId: binding.requestId, turnId: binding.turnId, actorId: binding.actorId, causationId: act.causationId, correlationId: binding.correlationId, idempotencyKey: sha256Fingerprint(binding.requestId, act.speechActId, eventType[candidate.type]), source: { sourceType: "player_accepted_act", acceptedSpeechActId: act.speechActId, inputRecordId: binding.inputRecordId, requestId: binding.requestId }, stateVersion: nextVersion, occurredPhase: binding.preconditionPhase, createdOrder: createdOrder++, eventType: eventType[candidate.type] };
      if (["question", "suspicion", "vote_declaration"].includes(candidate.type)) event.targetId = candidate.targetId;
      if (candidate.type === "question") event.topic = candidate.topic;
      if (candidate.type === "role_claim" || candidate.type === "result_claim") event.claimId = claimForAct.get(act.speechActId).claimId;
      validatePublicEvent(event); events.push(event); eventForAct.set(act.speechActId, event);
    }
  }
  fault("claims"); fault("relations"); fault("events");
  const displayPlan = { schemaVersion: 1, displayPlanId: id("display", createId), inputRecordId: binding.inputRecordId, turnId: binding.turnId, stateVersion: nextVersion, segments: buildSegments(inputRecord.rawText, alternative.speechActs, acts, claimForAct, eventForAct, createId) };
  validatePlayerUtteranceDisplayPlan(displayPlan, inputRecord, { canonicalSpans: new Map(acts.filter((act) => claimForAct.has(act.speechActId) || ["accepted_vote_declaration", "accepted_suspicion"].includes(act.type)).map((act) => [act.speechActId, act.sourceSpan])) }); fault("display_plan");
  const publication = { schemaVersion: 1, recordType: "player_utterance_published", publicationId: id("publication", createId), correlationId: binding.correlationId, turnId: binding.turnId, actorId: binding.actorId, publicationSlotOrder: publicationSlotOrder++, recordAppendOrder: recordAppendOrder++, requestId: binding.requestId, gameStateVersion: nextVersion, occurredPhase: binding.preconditionPhase, inputRecordId: binding.inputRecordId, displayPlanId: displayPlan.displayPlanId, idempotencyKey: sha256Fingerprint(binding.requestId, binding.inputRecordId, "player_publication") };
  validateDisplayPublicationRecord(publication); fault("publication");
  const result = { schemaVersion: 1, requestId: binding.requestId, correlationId: binding.correlationId, requestFingerprint: binding.requestFingerprint, commitType: "player_conversation", preconditionStateVersion: binding.preconditionStateVersion, resultingStateVersion: nextVersion, createdEventIds: events.map((event) => event.eventId), createdClaimIds: claims.map((claim) => claim.claimId), createdAtOrder: createdOrder++, inputRecordId: binding.inputRecordId, displayPlanId: displayPlan.displayPlanId, playerPublicationId: publication.publicationId };
  validateConversationCommitResult(result); fault("commit_result");
  const targetName = state.players.find((player) => player.id === targetNpcId).name;
  const legacyDelta = Object.freeze({ playerLogEntry: { day: state.day, phase: "player_question", message: `あなた -> ${targetName}: ${inputRecord.rawText}` }, publicInfoEntry: { day: state.day, phase: "player_question", type: "player_question", actorId: "player", targetId: targetNpcId, text: `プレイヤーが${targetName}に質問: ${inputRecord.rawText}` } });
  const idempotencyRecord = { requestId: binding.requestId, requestFingerprint: binding.requestFingerprint, result: structuredClone(result) }; fault("idempotency");
  const objects = { inputRecords: [inputRecord], acceptedSpeechActs: acts, claims, events, displayPlans: [displayPlan], publications: [publication], commitResults: [result] };
  validateCommittedConversationGraph({ inputRecords: [...existing.inputRecords, inputRecord], acceptedSpeechActs: [...existing.acceptedSpeechActs, ...acts], claims: [...existing.claims, ...claims], events: [...existing.events, ...events], displayPlans: [...existing.displayPlans, displayPlan], publications: [...existing.publications, publication], commitResults: [...existing.commitResults, result] });
  const delta = validateConversationCommitDelta({ schemaVersion: 1, commitType: "player_conversation", gameSessionId: binding.gameSessionId, requestId: binding.requestId, correlationId: binding.correlationId, inputRecordId: binding.inputRecordId, turnId: binding.turnId, preconditionPhase: binding.preconditionPhase, resultingPhase: "player_question", preconditionStateVersion: binding.preconditionStateVersion, resultingStateVersion: nextVersion, requestFingerprint: binding.requestFingerprint, objects: structuredClone(objects), legacyDelta: structuredClone(legacyDelta), idempotencyRecord: structuredClone(idempotencyRecord), counters: { nextCreatedOrder: createdOrder, nextPublicationSlotOrder: publicationSlotOrder, nextRecordAppendOrder: recordAppendOrder } });
  return deepFreeze({ replay: false, result, delta });
}

export function validateConversationCommitDelta(value) {
  exact(value, ["schemaVersion", "commitType", "gameSessionId", "requestId", "correlationId", "inputRecordId", "turnId", "preconditionPhase", "resultingPhase", "preconditionStateVersion", "resultingStateVersion", "requestFingerprint", "objects", "legacyDelta", "idempotencyRecord", "counters"]);
  if (value.schemaVersion !== 1 || value.commitType !== "player_conversation" || value.resultingStateVersion !== value.preconditionStateVersion + 1 || value.resultingPhase !== "player_question") throw typedError("invalid_commit_delta");
  exact(value.objects, ["inputRecords", "acceptedSpeechActs", "claims", "events", "displayPlans", "publications", "commitResults"]); exact(value.legacyDelta, ["playerLogEntry", "publicInfoEntry"]); exact(value.idempotencyRecord, ["requestId", "requestFingerprint", "result"]); exact(value.counters, ["nextCreatedOrder", "nextPublicationSlotOrder", "nextRecordAppendOrder"]);
  if (value.idempotencyRecord.requestId !== value.requestId || value.idempotencyRecord.requestFingerprint !== value.requestFingerprint) throw typedError("invalid_commit_delta");
  for (const counter of Object.values(value.counters)) if (!Number.isSafeInteger(counter) || counter < 0) throw typedError("invalid_commit_delta"); return value;
}

function assertCommitPreconditions(state, binding, alternative, targetNpcId) {
  if (!state.conversation || binding.gameSessionId !== state.gameSessionId) throw typedError("stale_session");
  if (binding.turnId !== state.turnId || binding.turnOrder !== state.turnOrder) throw typedError("stale_turn");
  if (binding.preconditionStateVersion !== state.stateVersion) throw typedError("stale_state_version");
  if (binding.preconditionPhase !== state.phase) throw typedError("stale_phase");
  if (binding.actorId !== "player" || binding.requestId !== binding.request.requestId || binding.correlationId !== binding.request.correlationId || binding.inputRecordId !== binding.request.inputRecordId) throw typedError("stale_identity");
  if (sha256Fingerprint(binding.request) !== binding.requestFingerprint) throw typedError("idempotency_conflict");
  if (!alternative || !Array.isArray(alternative.speechActs) || alternative.speechActs.length < 1 || alternative.speechActs.some((act) => act.type === "uninterpretable")) throw typedError("candidate_invalid");
  const roster = new Map(binding.request.publicRoster.map((entry) => [entry.playerId, entry])), current = state.players.find((player) => player.id === targetNpcId); if (!current || !roster.has(targetNpcId)) throw typedError("invalid_reference");
  for (const act of alternative.speechActs) if (act.targetId && (!roster.has(act.targetId) || act.targetId === "player" || !state.players.some((player) => player.id === act.targetId))) throw typedError("invalid_reference");
}

function claimRelation(prior, candidate, actorId) {
  const same = prior.filter((claim) => claim.actorId === actorId && claim.type === candidate.type && (candidate.type === "result_claim" ? claim.targetId === candidate.targetId : true));
  const matching = same.filter((claim) => candidate.type === "result_claim" ? claim.result === candidate.result : claim.claimedRole === candidate.claimedRole);
  return matching.length ? { repeat: matching[0].claimId, contradictions: [] } : { repeat: null, contradictions: same.map((claim) => claim.claimId) };
}

function buildSegments(rawText, candidates, acts, claimForAct, eventForAct, createId) {
  const segments = [], length = [...rawText].length; let cursor = 0;
  const raw = (start, end) => { if (start >= end) return; const prior = segments.at(-1); if (prior?.type === "raw_input" && prior.sourceSpan.end === start) prior.sourceSpan.end = end; else segments.push({ segmentId: id("segment", createId), type: "raw_input", inputRecordId: acts[0].inputRecordId, sourceSpan: { start, end } }); };
  candidates.forEach((candidate, index) => { raw(cursor, candidate.sourceSpan.start); const act = acts[index], claim = claimForAct.get(act.speechActId), event = eventForAct.get(act.speechActId); if (claim) segments.push({ segmentId: id("segment", createId), type: "canonical_claim", claimId: claim.claimId }); else if (candidate.type === "vote_declaration") segments.push({ segmentId: id("segment", createId), type: "canonical_vote", voteEventId: event.eventId }); else if (candidate.type === "suspicion") segments.push({ segmentId: id("segment", createId), type: "canonical_suspicion", suspicionEventId: event.eventId }); else raw(candidate.sourceSpan.start, candidate.sourceSpan.end); cursor = candidate.sourceSpan.end; }); raw(cursor, length); return segments;
}
function exact(value, keys) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw typedError("invalid_commit_delta"); }
function id(prefix, createId) { return `${prefix}-${createId()}`; }
function typedError(code) { const error = new Error(code); error.code = code; return error; }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
