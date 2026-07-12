import { renderCanonicalClaim, renderCanonicalSuspicion, renderCanonicalVote, validateCanonicalRenderingContext } from "./conversation/canonicalRenderer.mjs";
import { validateCommittedConversationGraph } from "./conversation/references.mjs";
import { validateDisplayPublicationRecord, validatePlayerInputRecord, validatePlayerUtteranceDisplayPlan } from "./conversation/validators.mjs";

export function resolvePlayerStructuredConsumerPolicy(config = {}) {
  const enabled = config.playerStructuredConsumerMode === true;
  if (enabled && config.playerConversationCommitMode !== true) throw consumerError("consumer_configuration_invalid");
  return Object.freeze({ enabled, playerConversationCommitRequired: true });
}

export function renderPlayerPublication({ gameSessionId, activeGameSessionId = gameSessionId, conversation, publicationId, publicParticipantsById }) {
  if (typeof gameSessionId !== "string" || gameSessionId !== activeGameSessionId || !conversation) throw consumerError("mismatched_session");
  const matches = conversation.publications.filter((record) => record.recordType === "player_utterance_published" && record.publicationId === publicationId);
  if (matches.length === 0) throw consumerError("publication_not_found");
  if (matches.length !== 1) throw consumerError("duplicate_publication");
  const publication = matches[0];
  try { validateDisplayPublicationRecord(publication); } catch { throw consumerError("invalid_publication"); }
  const input = unique(conversation.inputRecords, "inputRecordId", publication.inputRecordId, "dangling_input_reference");
  const plan = unique(conversation.displayPlans, "displayPlanId", publication.displayPlanId, "dangling_display_plan_reference");
  try { validateCommittedConversationGraph(conversation); } catch (error) { throw consumerError(reasonForGraphError(error)); }
  try { validatePlayerInputRecord(input); validatePlayerUtteranceDisplayPlan(plan, input, canonicalSpans(conversation)); } catch { throw consumerError("invalid_segment"); }
  if (publication.inputRecordId !== plan.inputRecordId) throw consumerError("mismatched_input");
  if (publication.turnId !== plan.turnId || publication.turnId !== input.turnId) throw consumerError("mismatched_turn");
  if (publication.gameStateVersion !== plan.stateVersion) throw consumerError("mismatched_version");
  if (publication.actorId !== input.actorId) throw consumerError("mismatched_actor");
  if (publication.requestId !== input.requestId || publication.correlationId !== input.correlationId) throw consumerError("mismatched_request_correlation");
  const context = { locale: input.locale, publicParticipantsById }; try { validateCanonicalRenderingContext(context); } catch { throw consumerError("missing_public_participant_projection"); }
  let renderedText; try { renderedText = plan.segments.map((segment) => renderSegment(segment, input, conversation, context)).join(""); } catch (error) { if (error?.name === "PlayerStructuredConsumerError") throw error; throw consumerError(/unknown participant/.test(error?.message) ? "missing_public_participant_projection" : "invalid_segment"); }
  if ([...renderedText].length === 0) throw consumerError("empty_rendered_output");
  return deepFreeze({ gameSessionId, publicationId, displayPlanId: plan.displayPlanId, inputRecordId: input.inputRecordId, actorId: input.actorId, turnId: publication.turnId, requestId: publication.requestId, correlationId: publication.correlationId, gameStateVersion: publication.gameStateVersion, publicationSlotOrder: publication.publicationSlotOrder, recordAppendOrder: publication.recordAppendOrder, locale: input.locale, renderedText });
}

export function renderUnconsumedPlayerPublications({ gameSessionId, activeGameSessionId = gameSessionId, conversation, publicParticipantsById, consumedPublicationIds = new Set() }) {
  const publications = conversation.publications.filter((record) => record.recordType === "player_utterance_published").sort((a, b) => a.publicationSlotOrder - b.publicationSlotOrder);
  const slots = new Set();
  return publications.flatMap((publication) => {
    if (slots.has(publication.publicationSlotOrder)) throw consumerError("duplicate_publication_slot"); slots.add(publication.publicationSlotOrder);
    return consumedPublicationIds.has(publication.publicationId) ? [] : [renderPlayerPublication({ gameSessionId, activeGameSessionId, conversation, publicationId: publication.publicationId, publicParticipantsById })];
  });
}

export function mergeStructuredPlayerEntries(legacyEntries, structuredEntries) {
  const queue = [...structuredEntries].sort((a, b) => a.publicationSlotOrder - b.publicationSlotOrder), output = [];
  for (const entry of legacyEntries) {
    if (entry.phase === "player_question" && queue.length) { const structured = queue.shift(); output.push({ day: entry.day, phase: entry.phase, message: structured.renderedText, actorId: structured.actorId, publicationId: structured.publicationId, structured: true }); }
    else output.push(structuredClone(entry));
  }
  if (queue.length) throw consumerError("history_projection_failure");
  return output;
}

export function sanitizeTerminalText(value) { return String(value).replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, "[control]"); }

function renderSegment(segment, input, conversation, context) {
  if (segment.type === "raw_input") {
    if (segment.inputRecordId !== input.inputRecordId) throw consumerError("invalid_source_span");
    const codePoints = [...input.rawText], { start, end } = segment.sourceSpan;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > codePoints.length) throw consumerError("invalid_source_span");
    return codePoints.slice(start, end).join("");
  }
  if (segment.type === "canonical_claim") { const claim = unique(conversation.claims, "claimId", segment.claimId, "dangling_claim_reference"); if (claim.source.sourceType !== "player_accepted_act") throw consumerError("invalid_claim_source"); return renderCanonicalClaim(claim, context); }
  if (segment.type === "canonical_vote") return renderCanonicalVote(unique(conversation.events, "eventId", segment.voteEventId, "dangling_event_reference"), context);
  if (segment.type === "canonical_suspicion") return renderCanonicalSuspicion(unique(conversation.events, "eventId", segment.suspicionEventId, "dangling_event_reference"), context);
  throw consumerError("unsupported_segment_type");
}

function canonicalSpans(conversation) { return { canonicalSpans: new Map(conversation.acceptedSpeechActs.filter((act) => ["accepted_role_claim", "accepted_result_claim", "accepted_vote_declaration", "accepted_suspicion"].includes(act.type)).map((act) => [act.speechActId, act.sourceSpan])) }; }
function reasonForGraphError(error) { const path = String(error?.path ?? ""); if (path.includes("input")) return "dangling_input_reference"; if (path.includes("displayPlan")) return "dangling_display_plan_reference"; if (path.includes("claim")) return "dangling_claim_reference"; if (path.includes("event")) return "dangling_event_reference"; if (path.includes("publication")) return "invalid_publication"; return "history_projection_failure"; }
function unique(values, key, id, code) { const matches = values.filter((value) => value[key] === id); if (matches.length !== 1) throw consumerError(matches.length ? "duplicate_publication" : code); return matches[0]; }
function consumerError(code) { const error = new Error(code); error.name = "PlayerStructuredConsumerError"; error.code = code; return error; }
function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child); return value; }
