import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, classifyIdempotentWrite, npcClaimIdempotencyKey, playerClaimIdempotencyKey, sha256Fingerprint } from "../src/conversation/ids.mjs";
import { renderCanonicalClaim, renderCanonicalSuspicion, renderCanonicalVote, resolveHistoricalVariant, validateRendererSelection } from "../src/conversation/canonicalRenderer.mjs";
import { candidateFields, enums } from "../src/conversation/domain.mjs";
import { validateAcceptedSpeechAct, validateCanonicalClaim, validateControlledCommentaryVariant, validateConversationCommitResult, validateDisplayPublicationRecord, validateInterpreterModelOutput, validateNpcPublicationFinalizationResult, validateNpcReactionPlan, validatePendingRendererRequest, validatePlayerInputRecord, validatePlayerUtteranceDisplayPlan, validatePublicEvent, validateReferentialIntegrity, validateSelectedCommentaryVariant, validateSpeechActCandidates, validateSourceSpan } from "../src/conversation/validators.mjs";
import { classifyPublicationFinalizationAttempt, validateClaimReferences, validateCommitResultReferences, validateCommittedConversationGraph, validateConversationGraph, validateDisplayPlanReferences, validateEventReferences, validateNpcPublicationFinalizationResultReferences, validateNpcReactionCommitResultReferences, validatePersistedPublicationReferences, validatePlayerConversationCommitResultReferences, validatePlayerPublicationReferences, validatePreparedConversationGraph, validatePublicationFinalizationAtAppend, validateReactionPlanReferences } from "../src/conversation/references.mjs";
import { validateAcceptedActCoverage, validateFinalizationResultCompleteness, validatePublicationCompleteness, validateRequestIdentityCompleteness } from "../src/conversation/completeness.mjs";

const fingerprint = "a".repeat(64);
const input = { schemaVersion: 1, inputRecordId: "input-1", requestId: "request-1", correlationId: "corr-1", turnId: "turn-1", capturedStateVersion: 0, actorId: "player", rawText: "😀占い師です。Beniが怪しい。", locale: "ja-JP", createdOrder: 0 };
const playerSource = { sourceType: "player_accepted_act", acceptedSpeechActIds: ["act-1"], inputRecordId: "input-1", requestId: "request-1" };
const claim = { schemaVersion: 1, claimId: "claim-1", claimRevision: 1, actorId: "player", source: playerSource, idempotencyKey: playerClaimIdempotencyKey({ requestId: "request-1", acceptedSpeechActIds: ["act-1"], actorId: "player", claimKind: "role_claim" }), createdTurnId: "turn-1", createdStateVersion: 1, repeatsClaimId: null, contradictsClaimIds: [], status: "asserted", type: "role_claim", claimedRole: "seer" };
const actBase = { schemaVersion: 1, speechActId: "act-1", requestId: "request-1", acceptedTurnId: "turn-1", acceptedStateVersion: 0, acceptedPhase: "day_discussion", inputRecordId: "input-1", actorId: "player", causationId: "cause-1", correlationId: "corr-1", idempotencyKey: "idem-1", sourceSpan: { start: 1, end: 7 } };
const roleAct = { ...actBase, type: "accepted_role_claim", claimedRole: "seer" };
const participantsById = Object.freeze({ player: Object.freeze({ id: "player", displayName: "Player" }), "npc-1": Object.freeze({ id: "npc-1", displayName: "Aoi" }), "npc-2": Object.freeze({ id: "npc-2", displayName: "Beni" }) });
const playerEventSource = { sourceType: "player_accepted_act", acceptedSpeechActId: "act-1", inputRecordId: "input-1", requestId: "request-1" };
const eventBase = { schemaVersion: 1, requestId: "request-1", turnId: "turn-1", actorId: "player", causationId: "cause-1", correlationId: "corr-1", idempotencyKey: "idem-1", source: playerEventSource, stateVersion: 1, occurredPhase: "day_discussion", createdOrder: 0 };

test("SourceSpan uses Unicode code points including surrogate pairs", () => {
  assert.equal(validateSourceSpan({ start: 0, end: 1 }, "😀a").end, 1);
  assert.throws(() => validateSourceSpan({ start: 0, end: 3 }, "😀a"));
  assert.throws(() => validateSpeechActCandidates([{ type: "role_claim", claimedRole: "seer", sourceSpan: { start: 0, end: 6 } }, { type: "suspicion", targetId: "npc-1", sourceSpan: { start: 5, end: 8 } }], input.rawText));
});

test("all eight candidate union members and strict fields validate", () => {
  const candidates = [{ type: "non_game_statement" }, { type: "question", targetId: "npc-1", topic: "role" }, { type: "suspicion", targetId: "npc-1" }, { type: "vote_declaration", targetId: "npc-1" }, { type: "role_claim", claimedRole: "seer" }, { type: "result_claim", targetId: "npc-1", result: "werewolf" }, { type: "information_request", topic: "rules" }, { type: "uninterpretable", reason: "off_topic" }];
  candidates.forEach((candidate) => assert.doesNotThrow(() => validateSpeechActCandidates([{ ...candidate, sourceSpan: { start: 0, end: 1 } }], "😀")));
  assert.throws(() => validateSpeechActCandidates([{ type: "role_claim", claimedRole: "fox", sourceSpan: { start: 0, end: 1 } }], "a"));
  assert.throws(() => validateSpeechActCandidates([{ type: "role_claim", claimedRole: "seer", confidence: 1, sourceSpan: { start: 0, end: 1 } }], "a"));
});

test("InterpreterModelOutput enforces alternatives and uninterpretable semantics", () => {
  const rawText = "😀?", alternative = { alternativeId: "alt-1", confidence: 0.4, speechActs: [{ type: "uninterpretable", reason: "gibberish", sourceSpan: { start: 0, end: 2 } }] }, output = { schemaVersion: 1, alternatives: [alternative] };
  assert.equal(validateInterpreterModelOutput(output, rawText), output);
  assert.throws(() => validateInterpreterModelOutput({ schemaVersion: 1, alternatives: [] }, rawText));
  assert.throws(() => validateInterpreterModelOutput({ schemaVersion: 1, alternatives: [alternative, { ...alternative, alternativeId: "alt-2" }, { ...alternative, alternativeId: "alt-3" }, { ...alternative, alternativeId: "alt-4" }] }, rawText));
  assert.throws(() => validateInterpreterModelOutput({ schemaVersion: 1, alternatives: [{ ...alternative, confidence: 2 }] }, rawText));
  assert.throws(() => validateInterpreterModelOutput({ schemaVersion: 1, alternatives: [{ ...alternative, extra: true }] }, rawText));
  assert.throws(() => validateInterpreterModelOutput({ schemaVersion: 1, alternatives: [{ ...alternative, speechActs: [...alternative.speechActs, { type: "non_game_statement", sourceSpan: { start: 0, end: 1 } }] }] }, rawText));
  assert.throws(() => validateInterpreterModelOutput({ schemaVersion: 1, alternatives: [{ ...alternative, speechActs: [{ ...alternative.speechActs[0], sourceSpan: { start: 0, end: 1 } }] }] }, rawText));
});

test("all seven AcceptedSpeechAct members validate", () => {
  const values = [{ type: "accepted_non_game_statement" }, { type: "accepted_question", targetId: "npc-1", topic: "role" }, { type: "accepted_suspicion", targetId: "npc-1" }, { type: "accepted_vote_declaration", targetId: "npc-1" }, { type: "accepted_role_claim", claimedRole: "seer" }, { type: "accepted_result_claim", targetId: "npc-1", result: "werewolf" }, { type: "accepted_information_request", topic: "history" }];
  values.forEach((value, index) => assert.doesNotThrow(() => validateAcceptedSpeechAct({ ...actBase, speechActId: `act-${index}`, sourceSpan: { start: 0, end: 1 }, ...value }, "😀")));
});

test("PlayerInputRecord enforces locale and Unicode bounds", () => {
  assert.equal(validatePlayerInputRecord(input), input);
  assert.throws(() => validatePlayerInputRecord({ ...input, locale: "fr" }));
  assert.throws(() => validatePlayerInputRecord({ ...input, rawText: "" }));
});

test("CanonicalClaim validates both members, sources and revision one", () => {
  assert.equal(validateCanonicalClaim(claim), claim);
  assert.throws(() => validateCanonicalClaim({ ...claim, claimRevision: 999 }));
  assert.throws(() => validateCanonicalClaim({ ...claim, source: { ...playerSource, descriptorId: "bad" } }));
  assert.throws(() => validateCanonicalClaim({ ...claim, repeatsClaimId: "claim-0", contradictsClaimIds: ["claim-x"] }));
  const { claimedRole: _claimedRole, ...claimMetadata } = claim;
  assert.doesNotThrow(() => validateCanonicalClaim({ ...claimMetadata, claimId: "claim-result", type: "result_claim", targetId: "npc-1", result: "not_werewolf", source: { sourceType: "npc_reaction", reactionPlanId: "plan-1", descriptorId: "desc-1", originatingInputRecordId: "input-1", reactionCommitRequestId: "reaction-request-1" } }));
});

test("PublicEvent validates player and NPC strict provenance", () => {
  const event = { ...eventBase, eventId: "event-1", eventType: "role_claim_recorded", claimId: "claim-1" };
  assert.equal(validatePublicEvent(event), event);
  assert.doesNotThrow(() => validatePublicEvent({ ...eventBase, eventId: "event-2", actorId: "npc-1", eventType: "vote_declared", targetId: "npc-2", source: { sourceType: "npc_reaction", reactionPlanId: "plan-1", descriptorId: "desc-1", originatingInputRecordId: "input-1", reactionCommitRequestId: "reaction-request-1" } }));
  assert.throws(() => validatePublicEvent({ ...event, sourceSpan: { start: 0, end: 1 } }));
});

test("DisplayPlan rejects mismatched inputs, unordered raw spans and canonical duplication", () => {
  const plan = { schemaVersion: 1, displayPlanId: "display-1", inputRecordId: "input-1", turnId: "turn-1", stateVersion: 1, segments: [{ segmentId: "seg-1", type: "canonical_claim", claimId: "claim-1" }] };
  assert.equal(validatePlayerUtteranceDisplayPlan(plan, input), plan);
  assert.throws(() => validatePlayerUtteranceDisplayPlan({ ...plan, inputRecordId: "input-2" }, input));
  const rawPlan = { ...plan, segments: [{ segmentId: "raw-1", type: "raw_input", inputRecordId: "input-1", sourceSpan: { start: 4, end: 6 } }, { segmentId: "raw-2", type: "raw_input", inputRecordId: "input-1", sourceSpan: { start: 3, end: 5 } }] };
  assert.throws(() => validatePlayerUtteranceDisplayPlan(rawPlan, input));
  assert.throws(() => validatePlayerUtteranceDisplayPlan({ ...plan, segments: [{ segmentId: "raw-1", type: "raw_input", inputRecordId: "input-1", sourceSpan: { start: 1, end: 8 } }] }, input, { canonicalSpans: new Map([["claim-1", roleAct.sourceSpan]]) }));
});

function canonicalPlan() { return { schemaVersion: 1, requestId: "reaction-request-1", correlationId: "corr-1", causationId: "cause-1", originatingInputRecordId: "input-1", locale: "ja-JP", causationEventIds: [], reactionPlanId: "plan-1", turnId: "turn-1", resultingStateVersion: 2, npcId: "npc-1", renderMode: "canonical_only", intendedSpeechActs: [{ descriptorId: "desc-1", descriptorType: "role_claim", claimedRole: "seer" }], policies: { policyType: "reaction_policies", allowStateChanges: true, allowClaims: true, allowVoteDeclaration: false, allowSuspicionUpdate: false, allowMemoryUpdate: false }, canonicalSegments: [{ segmentId: "seg-1", descriptorId: "desc-1", type: "canonical_claim", claimId: "claim-2" }], maxChars: 200 }; }
function controlledPlan() { return { schemaVersion: 1, requestId: "reaction-request-1", correlationId: "corr-1", causationId: "cause-1", originatingInputRecordId: "input-1", locale: "ja-JP", causationEventIds: [], reactionPlanId: "plan-1", turnId: "turn-1", resultingStateVersion: 2, npcId: "npc-1", renderMode: "controlled_commentary", intendedSpeechActs: [{ descriptorId: "desc-1", descriptorType: "acknowledgement", referenceId: "event-1" }], policies: { policyType: "reaction_policies", allowStateChanges: false, allowClaims: false, allowVoteDeclaration: false, allowSuspicionUpdate: false, allowMemoryUpdate: false }, commentaryPlan: { intent: "acknowledge", allowedPublicReferenceIds: ["event-1"] }, maxChars: 200 }; }

test("ReactionPlan enforces descriptor/segment compatibility and exact policies", () => {
  const plan = canonicalPlan(); assert.equal(validateNpcReactionPlan(plan), plan);
  assert.throws(() => validateNpcReactionPlan({ ...plan, canonicalSegments: [{ segmentId: "seg-1", descriptorId: "desc-1", type: "canonical_vote", voteEventId: "event-1" }] }));
  assert.throws(() => validateNpcReactionPlan({ ...plan, policies: { ...plan.policies, allowClaims: false } }));
  for (const [descriptorType, type, field] of [["result_claim", "canonical_claim", "claimId"], ["vote_declaration", "canonical_vote", "voteEventId"], ["suspicion", "canonical_suspicion", "suspicionEventId"]]) { const descriptor = descriptorType === "result_claim" ? { descriptorId: "desc-1", descriptorType, targetId: "npc-2", result: "werewolf" } : { descriptorId: "desc-1", descriptorType, targetId: "npc-2" }; const policies = { ...plan.policies, allowClaims: descriptorType === "result_claim", allowVoteDeclaration: descriptorType === "vote_declaration", allowSuspicionUpdate: descriptorType === "suspicion", allowMemoryUpdate: descriptorType === "vote_declaration" }; assert.doesNotThrow(() => validateNpcReactionPlan({ ...plan, intendedSpeechActs: [descriptor], policies, canonicalSegments: [{ segmentId: "seg-1", descriptorId: "desc-1", type, [field]: "object-1" }] })); }
});

test("variant selection separates new selection from historical replay", () => {
  const variant = { schemaVersion: 1, variantId: "ack-1", variantVersion: 1, locale: "en", renderMode: "controlled_commentary", intent: "acknowledge", text: "Understood.", enabled: true, maximumRenderedChars: 20, toneTags: ["brief"], lifecycle: "active" }, selection = { variantId: "ack-1", variantVersion: 1, locale: "en" }, allowed = [{ schemaVersion: 1, variantId: "ack-1", variantVersion: 1, locale: "en", intent: "acknowledge", toneTags: ["brief"] }];
  assert.equal(validateControlledCommentaryVariant(variant), variant); assert.equal(validateSelectedCommentaryVariant(selection), selection);
  assert.equal(validateRendererSelection(selection, allowed, [variant], "acknowledge"), "Understood.");
  assert.equal(resolveHistoricalVariant(selection, [{ ...variant, enabled: false, lifecycle: "retired" }]), "Understood.");
  assert.throws(() => validateRendererSelection(selection, [], [variant], "acknowledge"));
  assert.throws(() => validateRendererSelection(selection, allowed, [variant, variant], "acknowledge"));
  assert.throws(() => validateRendererSelection(selection, [...allowed, { ...allowed[0], variantVersion: 2 }], [variant], "acknowledge"));
  assert.throws(() => validateRendererSelection(selection, allowed, [{ ...variant, enabled: false }], "acknowledge"));
});

test("all publication and commit-result union members validate", () => {
  const player = { schemaVersion: 1, recordType: "player_utterance_published", publicationId: "pub-player", requestId: "request-1", correlationId: "corr-1", turnId: "turn-1", gameStateVersion: 1, occurredPhase: "day_discussion", actorId: "player", inputRecordId: "input-1", displayPlanId: "display-1", idempotencyKey: "idem-1", publicationSlotOrder: 0, recordAppendOrder: 0 };
  const canonical = { schemaVersion: 1, recordType: "npc_canonical_published", publicationId: "pub-canonical", reactionPlanId: "plan-1", reactionCommitRequestId: "reaction-request-1", originatingInputRecordId: "input-1", correlationId: "corr-1", turnId: "turn-1", reactionResultingStateVersion: 2, actorId: "npc-1", locale: "ja-JP", canonicalRendererVersion: 1, canonicalSegmentIds: ["seg-1"], publicationSlotOrder: 1, recordAppendOrder: 1 };
  const reserved = { schemaVersion: 1, recordType: "npc_publication_reserved", publicationId: "pub-controlled", reservationId: "reservation-1", reactionPlanId: "plan-1", reactionCommitRequestId: "reaction-request-1", originatingInputRecordId: "input-1", correlationId: "corr-1", turnId: "turn-1", reactionResultingStateVersion: 2, actorId: "npc-1", locale: "ja-JP", renderMode: "controlled_commentary", fallbackVariantId: "fallback-1", fallbackVariantVersion: 1, status: "reserved", publicationSlotOrder: 2, recordAppendOrder: 2 };
  const finalized = { schemaVersion: 1, recordType: "npc_publication_finalized", finalizationId: "final-1", publicationId: "pub-controlled", reservationId: "reservation-1", reactionPlanId: "plan-1", source: { sourceType: "renderer_request", rendererRequestId: "renderer-1" }, correlationId: "corr-1", turnId: "turn-1", stateVersion: 2, actorId: "npc-1", locale: "ja-JP", selectedVariantId: "fallback-1", selectedVariantVersion: 1, finalizationReason: "renderer_timeout_fallback", fallbackUsed: true, publicationSlotOrder: 2, recordAppendOrder: 3, createdAt: "2026-07-11T00:00:00Z" };
  [player, canonical, reserved, finalized].forEach((value) => assert.doesNotThrow(() => validateDisplayPublicationRecord(value)));
  const { recordType: _recordType, actorId: _actorId, correlationId: _correlationId, turnId: _turnId, stateVersion: _stateVersion, ...finalizationResult } = finalized;
  assert.doesNotThrow(() => validateNpcPublicationFinalizationResult(finalizationResult));
  const common = { schemaVersion: 1, requestId: "request-1", correlationId: "corr-1", requestFingerprint: fingerprint, preconditionStateVersion: 0, resultingStateVersion: 1, createdEventIds: [], createdClaimIds: [], createdAtOrder: 0 };
  const results = [{ ...common, commitType: "player_conversation", inputRecordId: "input-1", displayPlanId: "display-1", playerPublicationId: "pub-player" }, { ...common, commitType: "npc_reaction", resultMode: "canonical_only", reactionPlanId: "plan-1", npcPublicationId: "pub-canonical" }, { ...common, commitType: "npc_reaction", resultMode: "controlled_commentary", reactionPlanId: "plan-1", npcPublicationId: "pub-controlled", reservationId: "reservation-1" }];
  results.forEach((value) => assert.doesNotThrow(() => validateConversationCommitResult(value)));
});

test("referential validators cover accepted sources and canonical display ownership", () => {
  const plan = { schemaVersion: 1, displayPlanId: "display-1", inputRecordId: "input-1", turnId: "turn-1", stateVersion: 1, segments: [{ segmentId: "raw-prefix", type: "raw_input", inputRecordId: "input-1", sourceSpan: { start: 0, end: 1 } }, { segmentId: "seg-1", type: "canonical_claim", claimId: "claim-1" }, { segmentId: "raw-suffix", type: "raw_input", inputRecordId: "input-1", sourceSpan: { start: 7, end: 16 } }] };
  assert.equal(validateReferentialIntegrity({ claims: [claim], acceptedSpeechActs: [roleAct], inputRecords: [input], displayPlans: [plan], canonicalSpans: new Map([["claim-1", roleAct.sourceSpan]]) }), true);
  assert.throws(() => validateReferentialIntegrity({ claims: [claim], inputRecords: [input], displayPlans: [plan], canonicalSpans: new Map([["claim-1", roleAct.sourceSpan]]) }));
});

test("canonical JSON rejects ambiguous values and detects payload conflicts", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}'); assert.equal(sha256Fingerprint({ b: 2, a: 1 }), sha256Fingerprint({ a: 1, b: 2 }));
  assert.equal(playerClaimIdempotencyKey({ requestId: "r", acceptedSpeechActIds: ["b", "a"], actorId: "p", claimKind: "role_claim" }), playerClaimIdempotencyKey({ requestId: "r", acceptedSpeechActIds: ["a", "b"], actorId: "p", claimKind: "role_claim" }));
  assert.match(npcClaimIdempotencyKey({ reactionCommitRequestId: "r", reactionPlanId: "p", descriptorId: "d", actorId: "n", claimKind: "result_claim" }), /^[0-9a-f]{64}$/);
  for (const invalid of [undefined, () => {}, Symbol("x"), 1n, NaN, Infinity, new Date()]) assert.throws(() => canonicalJson(invalid)); const cyclic = {}; cyclic.self = cyclic; assert.throws(() => canonicalJson(cyclic));
  assert.equal(classifyIdempotentWrite({ a: 1 }, { a: 1 }), "replay"); assert.equal(classifyIdempotentWrite({ a: 1 }, { a: 2 }), "idempotency_conflict");
});

test("canonical renderers validate schemas and resolve safe display names", () => {
  assert.equal(renderCanonicalClaim(claim, { locale: "en", participantsById }), "Player claimed to be a seer.");
  const source = { sourceType: "npc_reaction", reactionPlanId: "plan-1", descriptorId: "desc-1", originatingInputRecordId: "input-1", reactionCommitRequestId: "reaction-request-1" }, vote = { ...eventBase, eventId: "vote-1", actorId: "npc-1", eventType: "vote_declared", targetId: "npc-2", source };
  assert.equal(renderCanonicalVote(vote, { locale: "ja", participantsById }), "AoiはBeniへの投票を宣言しました。"); assert.equal(renderCanonicalSuspicion({ ...vote, eventId: "suspicion-1", eventType: "suspicion_expressed" }, { locale: "en-US", participantsById }), "Aoi expressed suspicion of Beni.");
  assert.throws(() => renderCanonicalClaim({ ...claim, actorId: "unknown" }, { locale: "en", participantsById })); assert.throws(() => renderCanonicalClaim({ ...claim, claimedRole: "fox" }, { locale: "en", participantsById })); assert.throws(() => renderCanonicalClaim(claim, { locale: "en", participantsById: { ...participantsById, player: { id: "player", displayName: "<b>Player</b>" } } })); assert.equal(participantsById.player.displayName, "Player");
});

test("exported schema definitions are deeply immutable", () => {
  assert.equal(Object.isFrozen(enums.supportedLocale), true); assert.equal(Object.isFrozen(candidateFields.question), true); assert.throws(() => enums.supportedLocale.push("fr")); assert.throws(() => candidateFields.question.push("extra"));
});

function controlledPublicationFixtures() {
  const reservation = { schemaVersion: 1, recordType: "npc_publication_reserved", publicationId: "pub-controlled", reservationId: "reservation-1", reactionPlanId: "plan-1", reactionCommitRequestId: "reaction-request-1", originatingInputRecordId: "input-1", correlationId: "corr-1", turnId: "turn-1", reactionResultingStateVersion: 2, actorId: "npc-1", locale: "ja-JP", renderMode: "controlled_commentary", fallbackVariantId: "fallback-1", fallbackVariantVersion: 1, status: "reserved", publicationSlotOrder: 2, recordAppendOrder: 2 };
  const finalization = { schemaVersion: 1, recordType: "npc_publication_finalized", finalizationId: "final-1", publicationId: "pub-controlled", reservationId: "reservation-1", reactionPlanId: "plan-1", source: { sourceType: "renderer_request", rendererRequestId: "renderer-1" }, correlationId: "corr-1", turnId: "turn-1", stateVersion: 2, actorId: "npc-1", locale: "ja-JP", selectedVariantId: "fallback-1", selectedVariantVersion: 1, finalizationReason: "renderer_timeout_fallback", fallbackUsed: true, publicationSlotOrder: 2, recordAppendOrder: 3, createdAt: "2026-07-11T00:00:00Z" };
  return { reservation, finalization };
}

test("persisted publication lifecycle validates without pending runtime state", () => {
  const { reservation, finalization } = controlledPublicationFixtures(), context = { reactionPlans: [controlledPlan()] };
  assert.equal(validatePersistedPublicationReferences([reservation, finalization], context), true);
  assert.throws(() => validatePersistedPublicationReferences([reservation, { ...reservation, reservationId: "reservation-2" }]));
  assert.throws(() => validatePersistedPublicationReferences([reservation, finalization, { ...finalization, finalizationId: "final-2" }]));
  assert.throws(() => validatePersistedPublicationReferences([finalization]));
  assert.throws(() => validatePersistedPublicationReferences([reservation, { ...finalization, locale: "en" }]));
  assert.throws(() => validatePersistedPublicationReferences([reservation, { ...finalization, publicationSlotOrder: 3 }]));
});

test("append-time finalization alone requires active matching pending renderer", () => {
  const { reservation, finalization } = controlledPublicationFixtures(), variant = { schemaVersion: 1, variantId: "fallback-1", variantVersion: 1, locale: "ja-JP", renderMode: "controlled_commentary", intent: "acknowledge", text: "了解しました。", enabled: true, maximumRenderedChars: 20, toneTags: ["brief"], lifecycle: "active" }, allowed = [{ schemaVersion: 1, variantId: "fallback-1", variantVersion: 1, locale: "ja-JP", intent: "acknowledge", toneTags: ["brief"] }], pending = { schemaVersion: 1, pendingType: "renderer", requestId: "renderer-1", correlationId: "corr-1", causationId: "plan-1", turnId: "turn-1", resultingStateVersion: 2, reactionPlanId: "plan-1", originatingInputRecordId: "input-1", locale: "ja-JP", targetNpcId: "npc-1", operation: "render_npc_utterance", status: "pending", startedAt: "2026-07-11T00:00:00Z" };
  assert.equal(validatePublicationFinalizationAtAppend(finalization, { publications: [reservation], reactionPlans: [controlledPlan()], pendingRendererRequests: [pending], registry: [variant], allowedVariants: allowed, expectedIntent: "acknowledge" }).classification, "new");
  assert.throws(() => validatePublicationFinalizationAtAppend(finalization, { publications: [reservation], reactionPlans: [controlledPlan()], registry: [variant], allowedVariants: allowed, expectedIntent: "acknowledge" }));
  assert.throws(() => validatePublicationFinalizationAtAppend(finalization, { publications: [reservation], reactionPlans: [controlledPlan()], pendingRendererRequests: [{ ...pending, status: "completed" }], registry: [variant], allowedVariants: allowed, expectedIntent: "acknowledge" }));
});

test("publicationId is an aggregate ID while record IDs remain unique", () => {
  const { reservation, finalization } = controlledPublicationFixtures(); assert.doesNotThrow(() => validatePersistedPublicationReferences([reservation, finalization], { reactionPlans: [controlledPlan()] }));
  assert.throws(() => validatePersistedPublicationReferences([reservation, { ...reservation }]));
  assert.throws(() => validatePersistedPublicationReferences([reservation, finalization, { ...finalization }]));
  const canonical = { schemaVersion: 1, recordType: "npc_canonical_published", publicationId: reservation.publicationId, reactionPlanId: "plan-1", reactionCommitRequestId: "reaction-request-1", originatingInputRecordId: "input-1", correlationId: "corr-1", turnId: "turn-1", reactionResultingStateVersion: 2, actorId: "npc-1", locale: "ja-JP", canonicalRendererVersion: 1, canonicalSegmentIds: ["seg-1"], publicationSlotOrder: 2, recordAppendOrder: 1 };
  assert.throws(() => validatePersistedPublicationReferences([canonical, reservation]));
});

test("player Event type must match its AcceptedSpeechAct", () => {
  const questionAct = { ...actBase, type: "accepted_question", targetId: "npc-1", topic: "role" }, roleEvent = { ...eventBase, eventId: "event-role", eventType: "role_claim_recorded", claimId: "claim-1" }, questionEvent = { ...eventBase, eventId: "event-question", eventType: "public_question_recorded", targetId: "npc-1", topic: "role" };
  assert.doesNotThrow(() => validateEventReferences([questionEvent], { acceptedSpeechActs: [questionAct] }));
  assert.throws(() => validateEventReferences([roleEvent], { acceptedSpeechActs: [questionAct], claims: [claim] }));
  assert.doesNotThrow(() => validateEventReferences([roleEvent], { acceptedSpeechActs: [roleAct], claims: [claim] }));
  const voteEvent = { ...eventBase, eventId: "event-vote", eventType: "vote_declared", targetId: "npc-1" };
  assert.throws(() => validateEventReferences([voteEvent], { acceptedSpeechActs: [roleAct] }));
});

test("claim events require matching claim member, actor, request and provenance", () => {
  const roleEvent = { ...eventBase, eventId: "event-role", eventType: "role_claim_recorded", claimId: "claim-1" };
  assert.doesNotThrow(() => validateEventReferences([roleEvent], { acceptedSpeechActs: [roleAct], claims: [claim] }));
  const { claimedRole: _role, ...resultBase } = claim, resultClaim = { ...resultBase, claimId: "claim-1", type: "result_claim", targetId: "npc-1", result: "werewolf" };
  assert.throws(() => validateEventReferences([roleEvent], { acceptedSpeechActs: [roleAct], claims: [resultClaim] }));
  assert.throws(() => validateEventReferences([{ ...roleEvent, actorId: "npc-1" }], { acceptedSpeechActs: [roleAct], claims: [claim] }));
  assert.throws(() => validateEventReferences([roleEvent], { acceptedSpeechActs: [{ ...roleAct, speechActId: "other" }], claims: [claim] }));
});

test("DisplayPlan resolves every segment span and enforces global source order", () => {
  const voteAct = { ...actBase, speechActId: "act-vote", type: "accepted_vote_declaration", targetId: "npc-1", sourceSpan: { start: 7, end: 12 } }, voteEvent = { ...eventBase, eventId: "event-vote", eventType: "vote_declared", targetId: "npc-1", source: { ...playerEventSource, acceptedSpeechActId: "act-vote" } }, plan = { schemaVersion: 1, displayPlanId: "display-1", inputRecordId: "input-1", turnId: "turn-1", stateVersion: 1, segments: [{ segmentId: "raw-1", type: "raw_input", inputRecordId: "input-1", sourceSpan: { start: 0, end: 1 } }, { segmentId: "claim-1", type: "canonical_claim", claimId: "claim-1" }, { segmentId: "vote-1", type: "canonical_vote", voteEventId: "event-vote" }, { segmentId: "raw-2", type: "raw_input", inputRecordId: "input-1", sourceSpan: { start: 12, end: 16 } }] };
  assert.doesNotThrow(() => validateDisplayPlanReferences([plan], { inputRecords: [input], claims: [claim], events: [voteEvent], acceptedSpeechActs: [roleAct, voteAct] }));
  assert.throws(() => validateDisplayPlanReferences([{ ...plan, segments: [plan.segments[2], plan.segments[1]] }], { inputRecords: [input], claims: [claim], events: [voteEvent], acceptedSpeechActs: [roleAct, voteAct] }));
  assert.throws(() => validateDisplayPlanReferences([{ ...plan, segments: [plan.segments[1], { ...plan.segments[1], segmentId: "claim-2" }] }], { inputRecords: [input], claims: [claim], events: [voteEvent], acceptedSpeechActs: [roleAct, voteAct] }));
  assert.throws(() => validateDisplayPlanReferences([plan], { inputRecords: [input], claims: [claim], events: [voteEvent], acceptedSpeechActs: [voteAct] }));
});

test("strict allowed variant projections and registry entries reject unknown fields", () => {
  const variant = { schemaVersion: 1, variantId: "ack-1", variantVersion: 1, locale: "en", renderMode: "controlled_commentary", intent: "acknowledge", text: "OK.", enabled: true, maximumRenderedChars: 3, toneTags: [], lifecycle: "active" }, allowed = [{ schemaVersion: 1, variantId: "ack-1", variantVersion: 1, locale: "en", intent: "acknowledge", toneTags: [] }], selection = { variantId: "ack-1", variantVersion: 1, locale: "en" };
  assert.throws(() => validateRendererSelection(selection, allowed, [{ ...variant, unknown: true }], "acknowledge"));
  assert.throws(() => validateRendererSelection(selection, [{ ...allowed[0], unknown: true }], [variant], "acknowledge"));
  assert.throws(() => validateRendererSelection(selection, [allowed[0], { ...allowed[0] }], [variant], "acknowledge"));
});

test("canonical JSON rejects sparse arrays and own symbol keys", () => {
  assert.equal(canonicalJson([]), "[]"); assert.equal(canonicalJson([1, 2]), "[1,2]"); assert.throws(() => canonicalJson(Array(1))); const value = { a: 1 }; value[Symbol("hidden")] = 2; assert.throws(() => canonicalJson(value));
});

test("claim repeat and contradiction semantics use array order", () => {
  const repeat = { ...claim, claimId: "claim-repeat", createdStateVersion: 2, repeatsClaimId: "claim-1" };
  assert.doesNotThrow(() => validateClaimReferences([claim, repeat], { acceptedSpeechActs: [roleAct] }));
  assert.throws(() => validateClaimReferences([claim, { ...repeat, actorId: "npc-1" }], { acceptedSpeechActs: [roleAct] }));
  assert.throws(() => validateClaimReferences([claim, { ...repeat, claimedRole: "citizen" }], { acceptedSpeechActs: [roleAct] }));
  const citizenAct = { ...roleAct, speechActId: "act-citizen", claimedRole: "citizen" }, contradiction = { ...claim, claimId: "claim-contradiction", createdStateVersion: 2, claimedRole: "citizen", source: { ...claim.source, acceptedSpeechActIds: ["act-citizen"] }, idempotencyKey: playerClaimIdempotencyKey({ requestId: "request-1", acceptedSpeechActIds: ["act-citizen"], actorId: "player", claimKind: "role_claim" }), repeatsClaimId: null, contradictsClaimIds: ["claim-1"] };
  assert.doesNotThrow(() => validateClaimReferences([claim, contradiction], { acceptedSpeechActs: [roleAct, citizenAct] }));
  assert.throws(() => validateClaimReferences([claim, { ...contradiction, claimedRole: "seer" }], { acceptedSpeechActs: [roleAct] }));
  assert.doesNotThrow(() => validateClaimReferences([contradiction, claim], { acceptedSpeechActs: [roleAct, citizenAct] }));
});

test("commit and finalization result references are member-specific", () => {
  const playerPublication = { schemaVersion: 1, recordType: "player_utterance_published", publicationId: "pub-player", requestId: "request-1", correlationId: "corr-1", turnId: "turn-1", gameStateVersion: 1, occurredPhase: "day_discussion", actorId: "player", inputRecordId: "input-1", displayPlanId: "display-1", idempotencyKey: "idem-1", publicationSlotOrder: 0, recordAppendOrder: 0 }, displayPlan = { schemaVersion: 1, displayPlanId: "display-1", inputRecordId: "input-1", turnId: "turn-1", stateVersion: 1, segments: [{ segmentId: "seg-1", type: "canonical_claim", claimId: "claim-1" }] }, playerResult = { schemaVersion: 1, requestId: "request-1", correlationId: "corr-1", requestFingerprint: fingerprint, commitType: "player_conversation", preconditionStateVersion: 0, resultingStateVersion: 1, inputRecordId: "input-1", displayPlanId: "display-1", playerPublicationId: "pub-player", createdEventIds: [], createdClaimIds: ["claim-1"], createdAtOrder: 0 };
  assert.doesNotThrow(() => validatePlayerConversationCommitResultReferences(playerResult, { inputRecords: [input], displayPlans: [displayPlan], publications: [playerPublication], claims: [claim] }));
  assert.throws(() => validatePlayerConversationCommitResultReferences({ ...playerResult, playerPublicationId: "missing" }, { inputRecords: [input], displayPlans: [displayPlan], publications: [playerPublication], claims: [claim] }));
  const { reservation, finalization } = controlledPublicationFixtures(), plan = controlledPlan(), npcResult = { schemaVersion: 1, requestId: "reaction-request-1", correlationId: "corr-1", requestFingerprint: fingerprint, commitType: "npc_reaction", resultMode: "controlled_commentary", preconditionStateVersion: 1, resultingStateVersion: 2, reactionPlanId: "plan-1", npcPublicationId: "pub-controlled", reservationId: "reservation-1", createdEventIds: [], createdClaimIds: [], createdAtOrder: 1 };
  assert.doesNotThrow(() => validateNpcReactionCommitResultReferences(npcResult, { reactionPlans: [plan], publications: [reservation] }));
  const { recordType: _recordType, actorId: _actorId, correlationId: _correlationId, turnId: _turnId, stateVersion: _stateVersion, ...finalizationResult } = finalization;
  assert.doesNotThrow(() => validateNpcPublicationFinalizationResultReferences(finalizationResult, { publications: [reservation, finalization] }));
  assert.throws(() => validateNpcPublicationFinalizationResultReferences({ ...finalizationResult, selectedVariantVersion: 2 }, { publications: [reservation, finalization] }));
});

test("validation errors expose path, code, and message without mutating input", () => {
  const invalid = Object.freeze({ ...input, locale: "fr" });
  assert.throws(() => validatePlayerInputRecord(invalid), (error) => typeof error.path === "string" && typeof error.code === "string" && typeof error.message === "string");
  assert.equal(invalid.locale, "fr");
});

function pendingRenderer(status = "pending") { return { schemaVersion: 1, pendingType: "renderer", requestId: "renderer-1", correlationId: "corr-1", causationId: "plan-1", turnId: "turn-1", resultingStateVersion: 2, reactionPlanId: "plan-1", originatingInputRecordId: "input-1", locale: "ja-JP", targetNpcId: "npc-1", operation: "render_npc_utterance", status, startedAt: "2026-07-11T00:00:00Z" }; }
function fallbackVariant(lifecycle = "active", enabled = true) { return { schemaVersion: 1, variantId: "fallback-1", variantVersion: 1, locale: "ja-JP", renderMode: "controlled_commentary", intent: "acknowledge", text: "了解しました。", enabled, maximumRenderedChars: 20, toneTags: ["brief"], lifecycle }; }
const fallbackAllowed = [{ schemaVersion: 1, variantId: "fallback-1", variantVersion: 1, locale: "ja-JP", intent: "acknowledge", toneTags: ["brief"] }];

test("PendingRendererRequest uses requestId and rejects rendererRequestId", () => {
  assert.doesNotThrow(() => validatePendingRendererRequest(pendingRenderer()));
  assert.throws(() => validatePendingRendererRequest({ ...pendingRenderer(), rendererRequestId: "renderer-1" }));
});

test("pending status is a closed mapping of finalization reason", () => {
  const { reservation, finalization } = controlledPublicationFixtures(), context = { publications: [reservation], reactionPlans: [controlledPlan()], registry: [fallbackVariant()], allowedVariants: fallbackAllowed, expectedIntent: "acknowledge" };
  const selected = { ...finalization, finalizationReason: "renderer_selected", fallbackUsed: false };
  assert.equal(validatePublicationFinalizationAtAppend(selected, { ...context, pendingRendererRequests: [pendingRenderer()] }).classification, "new");
  const aborted = { ...finalization, finalizationReason: "renderer_abort_fallback" };
  assert.equal(validatePublicationFinalizationAtAppend(aborted, { ...context, pendingRendererRequests: [pendingRenderer("aborting")] }).classification, "new");
  assert.throws(() => validatePublicationFinalizationAtAppend(aborted, { ...context, pendingRendererRequests: [pendingRenderer()] }));
  assert.throws(() => validatePublicationFinalizationAtAppend(selected, { ...context, pendingRendererRequests: [pendingRenderer("completed")] }));
  assert.throws(() => validatePublicationFinalizationAtAppend(selected, { ...context, pendingRendererRequests: [{ ...pendingRenderer(), requestId: "other" }] }));
});

test("finalization attempts classify new, replay, and conflict by operation identity", () => {
  const { finalization } = controlledPublicationFixtures();
  assert.equal(classifyPublicationFinalizationAttempt({ candidate: finalization, existingFinalizations: [] }).classification, "new");
  const replay = classifyPublicationFinalizationAttempt({ candidate: { ...finalization, finalizationId: "retry-id", recordAppendOrder: 99, createdAt: "2026-07-12T00:00:00Z" }, existingFinalizations: [finalization] }); assert.equal(replay.classification, "replay"); assert.equal(replay.existingFinalization.finalizationId, "final-1");
  assert.equal(classifyPublicationFinalizationAttempt({ candidate: { ...finalization, selectedVariantVersion: 2 }, existingFinalizations: [finalization] }).classification, "conflict");
  assert.equal(classifyPublicationFinalizationAttempt({ candidate: { ...finalization, finalizationReason: "renderer_error_fallback" }, existingFinalizations: [finalization] }).code, "idempotency_conflict");
  assert.equal(classifyPublicationFinalizationAttempt({ candidate: { ...finalization, locale: "en" }, existingFinalizations: [finalization] }).classification, "conflict");
});

test("fallback reason, flag, key, and historical registry resolution agree", () => {
  const { reservation, finalization } = controlledPublicationFixtures(), base = { publications: [reservation], reactionPlans: [controlledPlan()], pendingRendererRequests: [pendingRenderer()], allowedVariants: fallbackAllowed, expectedIntent: "acknowledge" };
  assert.equal(validatePublicationFinalizationAtAppend(finalization, { ...base, registry: [fallbackVariant("retired", false)] }).classification, "new");
  assert.throws(() => validatePublicationFinalizationAtAppend({ ...finalization, fallbackUsed: false }, { ...base, registry: [fallbackVariant()] }));
  assert.throws(() => validatePublicationFinalizationAtAppend({ ...finalization, selectedVariantId: "other" }, { ...base, registry: [fallbackVariant()] }));
  assert.throws(() => validatePublicationFinalizationAtAppend({ ...finalization, finalizationReason: "renderer_selected", fallbackUsed: true }, { ...base, registry: [fallbackVariant()] }));
});

test("Player and NPC claim provenance enforce type and payload", () => {
  assert.doesNotThrow(() => validateClaimReferences([claim], { acceptedSpeechActs: [roleAct] }));
  assert.throws(() => validateClaimReferences([claim], { acceptedSpeechActs: [{ ...roleAct, type: "accepted_question", targetId: "npc-1", topic: "role", claimedRole: undefined }] }));
  assert.throws(() => validateClaimReferences([claim], { acceptedSpeechActs: [{ ...roleAct, claimedRole: "citizen" }] }));
  const { claimedRole: _role, ...resultBase } = claim, resultClaim = { ...resultBase, claimId: "claim-result", type: "result_claim", targetId: "npc-2", result: "werewolf", source: { sourceType: "player_accepted_act", acceptedSpeechActIds: ["act-result"], inputRecordId: "input-1", requestId: "request-1" } }, resultAct = { ...actBase, speechActId: "act-result", type: "accepted_result_claim", targetId: "npc-1", result: "werewolf" };
  assert.throws(() => validateClaimReferences([resultClaim], { acceptedSpeechActs: [resultAct] }));
  const plan = canonicalPlan(), npcClaim = { ...claim, actorId: "npc-1", source: { sourceType: "npc_reaction", reactionPlanId: "plan-1", descriptorId: "desc-1", originatingInputRecordId: "input-1", reactionCommitRequestId: "reaction-request-1" }, idempotencyKey: npcClaimIdempotencyKey({ reactionCommitRequestId: "reaction-request-1", reactionPlanId: "plan-1", descriptorId: "desc-1", actorId: "npc-1", claimKind: "role_claim" }) };
  assert.doesNotThrow(() => validateClaimReferences([npcClaim], { reactionPlans: [plan] })); assert.throws(() => validateClaimReferences([{ ...npcClaim, claimedRole: "citizen" }], { reactionPlans: [plan] }));
});

test("CommitResult rejects foreign request and state-version objects", () => {
  const playerPublication = { schemaVersion: 1, recordType: "player_utterance_published", publicationId: "pub-player", requestId: "request-1", correlationId: "corr-1", turnId: "turn-1", gameStateVersion: 1, occurredPhase: "day_discussion", actorId: "player", inputRecordId: "input-1", displayPlanId: "display-1", idempotencyKey: "idem-1", publicationSlotOrder: 0, recordAppendOrder: 0 }, displayPlan = { schemaVersion: 1, displayPlanId: "display-1", inputRecordId: "input-1", turnId: "turn-1", stateVersion: 1, segments: [{ segmentId: "seg-1", type: "canonical_claim", claimId: "claim-1" }] }, event = { ...eventBase, eventId: "event-1", eventType: "role_claim_recorded", claimId: "claim-1" }, result = { schemaVersion: 1, requestId: "request-1", correlationId: "corr-1", requestFingerprint: fingerprint, commitType: "player_conversation", preconditionStateVersion: 0, resultingStateVersion: 1, inputRecordId: "input-1", displayPlanId: "display-1", playerPublicationId: "pub-player", createdEventIds: ["event-1"], createdClaimIds: ["claim-1"], createdAtOrder: 0 };
  assert.doesNotThrow(() => validatePlayerConversationCommitResultReferences(result, { inputRecords: [input], displayPlans: [displayPlan], publications: [playerPublication], events: [event], claims: [claim] }));
  assert.throws(() => validatePlayerConversationCommitResultReferences(result, { inputRecords: [input], displayPlans: [displayPlan], publications: [playerPublication], events: [{ ...event, source: { ...event.source, requestId: "foreign" } }], claims: [claim] }));
  assert.throws(() => validatePlayerConversationCommitResultReferences(result, { inputRecords: [input], displayPlans: [{ ...displayPlan, stateVersion: 2 }], publications: [playerPublication], events: [event], claims: [claim] }));
  assert.throws(() => validatePlayerConversationCommitResultReferences(result, { inputRecords: [input], displayPlans: [displayPlan], publications: [playerPublication], events: [event], claims: [{ ...claim, createdStateVersion: 2 }] }));
});

test("NPC CommitResult owns only objects from its reaction transaction", () => {
  const { reservation } = controlledPublicationFixtures(), plan = controlledPlan(), source = { sourceType: "npc_reaction", reactionPlanId: "plan-1", descriptorId: "desc-1", originatingInputRecordId: "input-1", reactionCommitRequestId: "reaction-request-1" }, event = { ...eventBase, eventId: "npc-event", requestId: "reaction-request-1", actorId: "npc-1", source, stateVersion: 2, eventType: "role_claim_recorded", claimId: "npc-claim" }, npcClaim = { ...claim, claimId: "npc-claim", actorId: "npc-1", source, createdStateVersion: 2 }, result = { schemaVersion: 1, requestId: "reaction-request-1", correlationId: "corr-1", requestFingerprint: fingerprint, commitType: "npc_reaction", resultMode: "controlled_commentary", preconditionStateVersion: 1, resultingStateVersion: 2, reactionPlanId: "plan-1", npcPublicationId: "pub-controlled", reservationId: "reservation-1", createdEventIds: ["npc-event"], createdClaimIds: ["npc-claim"], createdAtOrder: 1 };
  assert.doesNotThrow(() => validateNpcReactionCommitResultReferences(result, { reactionPlans: [plan], publications: [reservation], events: [event], claims: [npcClaim] }));
  assert.throws(() => validateNpcReactionCommitResultReferences(result, { reactionPlans: [plan], publications: [reservation], events: [{ ...event, source: { ...source, reactionPlanId: "foreign" } }], claims: [npcClaim] }));
  assert.throws(() => validateNpcReactionCommitResultReferences(result, { reactionPlans: [plan], publications: [reservation], events: [event], claims: [{ ...npcClaim, source: { ...source, reactionCommitRequestId: "foreign" } }] }));
});

test("Claim temporal relations use state version rather than array position", () => {
  const prior = claim, repeat = { ...claim, claimId: "repeat", createdStateVersion: 2, repeatsClaimId: "claim-1" };
  assert.doesNotThrow(() => validateClaimReferences([repeat, prior], { acceptedSpeechActs: [roleAct] }));
  assert.throws(() => validateClaimReferences([{ ...prior, createdStateVersion: 3 }, repeat], { acceptedSpeechActs: [roleAct] }));
  assert.throws(() => validateClaimReferences([{ ...prior, createdStateVersion: 2 }, repeat], { acceptedSpeechActs: [roleAct] }));
  assert.throws(() => validateClaimReferences([{ ...claim, repeatsClaimId: "claim-1" }], { acceptedSpeechActs: [roleAct] }));
});

test("display publication log enforces append and slot order globally", () => {
  const { reservation, finalization } = controlledPublicationFixtures(); assert.doesNotThrow(() => validatePersistedPublicationReferences([reservation, finalization], { reactionPlans: [controlledPlan()] }));
  assert.throws(() => validatePersistedPublicationReferences([reservation, { ...finalization, recordAppendOrder: reservation.recordAppendOrder }]));
  assert.throws(() => validatePersistedPublicationReferences([finalization, reservation]));
  const other = { ...reservation, publicationId: "pub-other", reservationId: "reservation-other", recordAppendOrder: 4 };
  assert.throws(() => validatePersistedPublicationReferences([reservation, finalization, other]));
});

test("DisplayPlan rejects claims with multiple accepted source acts", () => {
  const multiClaim = { ...claim, source: { ...claim.source, acceptedSpeechActIds: ["act-1", "act-2"] } }, secondAct = { ...roleAct, speechActId: "act-2" }, plan = { schemaVersion: 1, displayPlanId: "display-1", inputRecordId: "input-1", turnId: "turn-1", stateVersion: 1, segments: [{ segmentId: "claim-1", type: "canonical_claim", claimId: "claim-1" }] };
  assert.throws(() => validateDisplayPlanReferences([plan], { inputRecords: [input], claims: [multiClaim], acceptedSpeechActs: [roleAct, secondAct] }), (error) => error.code === "ambiguous_display_source");
});

test("high-level publication APIs enforce strict record schemas", () => {
  const { reservation, finalization } = controlledPublicationFixtures(), plan = controlledPlan();
  assert.throws(() => validatePersistedPublicationReferences([{ ...reservation, unknown: true }], { reactionPlans: [plan] }));
  assert.throws(() => validatePublicationFinalizationAtAppend({ ...finalization, actorId: undefined }, { publications: [reservation], reactionPlans: [plan] }));
  assert.throws(() => validatePublicationFinalizationAtAppend({ ...finalization, unknown: true }, { publications: [reservation], reactionPlans: [plan] }));
});

test("finalization replay identity includes actor, correlation, turn, and state", () => {
  const { finalization } = controlledPublicationFixtures();
  for (const changed of [{ actorId: "npc-2" }, { correlationId: "corr-2" }, { turnId: "turn-2" }, { stateVersion: 3 }]) assert.equal(classifyPublicationFinalizationAttempt({ candidate: { ...finalization, ...changed }, existingFinalizations: [finalization] }).classification, "conflict");
  assert.equal(classifyPublicationFinalizationAttempt({ candidate: { ...finalization, finalizationId: "new-id", recordAppendOrder: 99, createdAt: "2027-01-01T00:00:00Z" }, existingFinalizations: [finalization] }).classification, "replay");
});

test("persisted NPC publications require the matching ReactionPlan", () => {
  const { reservation, finalization } = controlledPublicationFixtures();
  assert.throws(() => validatePersistedPublicationReferences([reservation, finalization], { reactionPlans: [] }));
  assert.throws(() => validatePersistedPublicationReferences([reservation, finalization], { reactionPlans: [{ ...controlledPlan(), npcId: "npc-2" }] }));
});

test("canonical ReactionPlan segments require matching Claim provenance", () => {
  const plan = canonicalPlan(), npcSource = { sourceType: "npc_reaction", reactionPlanId: "plan-1", descriptorId: "desc-1", originatingInputRecordId: "input-1", reactionCommitRequestId: "reaction-request-1" }, npcClaim = { ...claim, claimId: "claim-2", actorId: "npc-1", source: npcSource, createdStateVersion: 2 };
  assert.doesNotThrow(() => validateReactionPlanReferences([plan], { inputRecords: [input], claims: [npcClaim] }));
  assert.throws(() => validateReactionPlanReferences([plan], { inputRecords: [input], claims: [{ ...npcClaim, source: { ...npcSource, descriptorId: "other" } }] }));
  assert.throws(() => validateReactionPlanReferences([plan], { inputRecords: [input], claims: [] }));
});

test("CommitResult created IDs exactly equal its transaction object sets", () => {
  const playerPublication = { schemaVersion: 1, recordType: "player_utterance_published", publicationId: "pub-player", requestId: "request-1", correlationId: "corr-1", turnId: "turn-1", gameStateVersion: 1, occurredPhase: "day_discussion", actorId: "player", inputRecordId: "input-1", displayPlanId: "display-1", idempotencyKey: "idem-1", publicationSlotOrder: 0, recordAppendOrder: 0 }, displayPlan = { schemaVersion: 1, displayPlanId: "display-1", inputRecordId: "input-1", turnId: "turn-1", stateVersion: 1, segments: [{ segmentId: "seg-1", type: "canonical_claim", claimId: "claim-1" }] }, result = { schemaVersion: 1, requestId: "request-1", correlationId: "corr-1", requestFingerprint: fingerprint, commitType: "player_conversation", preconditionStateVersion: 0, resultingStateVersion: 1, inputRecordId: "input-1", displayPlanId: "display-1", playerPublicationId: "pub-player", createdEventIds: [], createdClaimIds: [], createdAtOrder: 0 };
  assert.throws(() => validatePlayerConversationCommitResultReferences(result, { inputRecords: [input], displayPlans: [displayPlan], publications: [playerPublication], claims: [claim] }));
});

test("complete graph validation includes finalization result mirrors", () => {
  const { reservation, finalization } = controlledPublicationFixtures(), { recordType: _recordType, actorId: _actorId, correlationId: _correlationId, turnId: _turnId, stateVersion: _stateVersion, ...result } = finalization, reactionResult = { schemaVersion: 1, requestId: "reaction-request-1", correlationId: "corr-1", requestFingerprint: fingerprint, commitType: "npc_reaction", resultMode: "controlled_commentary", preconditionStateVersion: 1, resultingStateVersion: 2, reactionPlanId: "plan-1", npcPublicationId: "pub-controlled", reservationId: "reservation-1", createdEventIds: [], createdClaimIds: [], createdAtOrder: 0 }, graph = { inputRecords: [input], reactionPlans: [controlledPlan()], publications: [reservation, finalization], commitResults: [reactionResult], finalizationResults: [result] };
  assert.equal(validateConversationGraph(graph), true);
  assert.throws(() => validateConversationGraph({ ...graph, finalizationResults: [{ ...result, selectedVariantVersion: 2 }] }));
});

test("PublicEvent payload must match AcceptedSpeechAct and NPC descriptor", () => {
  const voteAct = { ...actBase, type: "accepted_vote_declaration", targetId: "npc-1" }, voteEvent = { ...eventBase, eventId: "vote-event", eventType: "vote_declared", targetId: "npc-2" };
  assert.throws(() => validateEventReferences([voteEvent], { acceptedSpeechActs: [voteAct] }), (error) => error.code === "event_payload_mismatch");
  const questionAct = { ...actBase, type: "accepted_question", targetId: "npc-1", topic: "role" }, questionEvent = { ...eventBase, eventId: "question-event", eventType: "public_question_recorded", targetId: "npc-2", topic: "vote" };
  assert.throws(() => validateEventReferences([questionEvent], { acceptedSpeechActs: [questionAct] }));
  const plan = { ...canonicalPlan(), intendedSpeechActs: [{ descriptorId: "desc-1", descriptorType: "vote_declaration", targetId: "npc-1" }] }, source = { sourceType: "npc_reaction", reactionPlanId: "plan-1", descriptorId: "desc-1", originatingInputRecordId: "input-1", reactionCommitRequestId: "reaction-request-1" }, npcEvent = { ...eventBase, eventId: "npc-vote", requestId: "reaction-request-1", actorId: "npc-1", source, stateVersion: 2, eventType: "vote_declared", targetId: "npc-2" };
  assert.throws(() => validateEventReferences([npcEvent], { reactionPlans: [plan] }));
});

test("conversation graph binds every AcceptedSpeechAct to PlayerInputRecord metadata", () => {
  const informationAct = { ...actBase, type: "accepted_information_request", topic: "rules" }, graph = { inputRecords: [input], acceptedSpeechActs: [informationAct] };
  assert.equal(validatePreparedConversationGraph(graph), true);
  for (const changed of [{ requestId: "other" }, { correlationId: "other" }, { acceptedTurnId: "other" }, { acceptedStateVersion: 1 }, { actorId: "npc-1" }]) assert.throws(() => validatePreparedConversationGraph({ ...graph, acceptedSpeechActs: [{ ...informationAct, ...changed }] }));
});

test("finalization version must match reservation, plan, and pending request", () => {
  const { reservation, finalization } = controlledPublicationFixtures(), plan = controlledPlan(), base = { publications: [reservation], reactionPlans: [plan], pendingRendererRequests: [pendingRenderer()], registry: [fallbackVariant()], allowedVariants: fallbackAllowed, expectedIntent: "acknowledge" };
  assert.throws(() => validatePersistedPublicationReferences([reservation, { ...finalization, stateVersion: 99 }], { reactionPlans: [plan] }), (error) => error.code === "state_version_mismatch");
  assert.throws(() => validatePublicationFinalizationAtAppend(finalization, { ...base, pendingRendererRequests: [{ ...pendingRenderer(), resultingStateVersion: 99 }] }));
  assert.throws(() => validatePublicationFinalizationAtAppend(finalization, { ...base, pendingRendererRequests: [{ ...pendingRenderer(), turnId: "turn-2" }] }));
  assert.throws(() => validatePublicationFinalizationAtAppend(finalization, { ...base, pendingRendererRequests: [{ ...pendingRenderer(), targetNpcId: "npc-2" }] }));
  assert.throws(() => validatePublicationFinalizationAtAppend({ ...finalization, stateVersion: 99 }, { ...base, pendingRendererRequests: [{ ...pendingRenderer(), resultingStateVersion: 99 }] }), (error) => error.code === "state_version_mismatch");
  assert.throws(() => validatePublicationFinalizationAtAppend(finalization, { ...base, pendingRendererRequests: [{ ...pendingRenderer(), correlationId: "corr-2" }] }));
  assert.throws(() => validatePublicationFinalizationAtAppend(finalization, { ...base, pendingRendererRequests: [{ ...pendingRenderer(), causationId: "other" }] }));
});

test("Player publication references reject dangling and duplicate owners", () => {
  const plan = { schemaVersion: 1, displayPlanId: "display-1", inputRecordId: "input-1", turnId: "turn-1", stateVersion: 1, segments: [{ segmentId: "seg-1", type: "raw_input", inputRecordId: "input-1", sourceSpan: { start: 0, end: 1 } }] }, publication = { schemaVersion: 1, recordType: "player_utterance_published", publicationId: "pub-1", requestId: "request-1", correlationId: "corr-1", turnId: "turn-1", gameStateVersion: 1, occurredPhase: "day_discussion", actorId: "player", inputRecordId: "input-1", displayPlanId: "display-1", idempotencyKey: "idem-1", publicationSlotOrder: 0, recordAppendOrder: 0 };
  assert.equal(validatePlayerPublicationReferences([publication], { inputRecords: [input], displayPlans: [plan], acceptedSpeechActs: [roleAct] }), true);
  assert.throws(() => validatePlayerPublicationReferences([publication], { inputRecords: [], displayPlans: [plan] }));
  assert.throws(() => validatePlayerPublicationReferences([publication, { ...publication, publicationId: "pub-2", recordAppendOrder: 1 }], { inputRecords: [input], displayPlans: [plan] }));
  assert.throws(() => validateConversationGraph({ inputRecords: [input], displayPlans: [plan], publications: [{ ...publication, inputRecordId: "missing" }] }));
  assert.throws(() => validatePlayerPublicationReferences([{ ...publication, occurredPhase: "night" }], { inputRecords: [input], displayPlans: [plan], acceptedSpeechActs: [roleAct] }));
  assert.throws(() => validatePlayerPublicationReferences([{ ...publication, gameStateVersion: 99 }], { inputRecords: [input], displayPlans: [{ ...plan, stateVersion: 99 }], acceptedSpeechActs: [roleAct] }));
  assert.throws(() => validatePlayerPublicationReferences([publication], { inputRecords: [input], displayPlans: [plan], acceptedSpeechActs: [{ ...roleAct, acceptedPhase: "night" }, roleAct] }));
});

test("semantic Event key is unique for player and NPC sources", () => {
  const voteAct = { ...actBase, type: "accepted_vote_declaration", targetId: "npc-1" }, first = { ...eventBase, eventId: "vote-1", eventType: "vote_declared", targetId: "npc-1" }, duplicate = { ...first, eventId: "vote-2", createdOrder: 1 };
  assert.throws(() => validateEventReferences([first, duplicate], { acceptedSpeechActs: [voteAct] }), (error) => error.code === "duplicate_semantic_event");
  assert.throws(() => validateEventReferences([first, { ...duplicate, targetId: "npc-2" }], { acceptedSpeechActs: [voteAct] }));
});

test("PublicEvent metadata is bound to its source transaction", () => {
  const statementAct = { ...actBase, type: "accepted_non_game_statement" }, event = { ...eventBase, eventId: "statement-1", eventType: "public_statement_recorded" };
  assert.doesNotThrow(() => validateEventReferences([event], { acceptedSpeechActs: [statementAct] }));
  for (const changed of [{ requestId: "other" }, { turnId: "other" }, { correlationId: "other" }, { stateVersion: 2 }, { causationId: "other" }]) assert.throws(() => validateEventReferences([{ ...event, ...changed }], { acceptedSpeechActs: [statementAct] }));
  const plan = { ...canonicalPlan(), intendedSpeechActs: [{ descriptorId: "desc-1", descriptorType: "vote_declaration", targetId: "npc-1" }] }, source = { sourceType: "npc_reaction", reactionPlanId: "plan-1", descriptorId: "desc-1", originatingInputRecordId: "input-1", reactionCommitRequestId: "reaction-request-1" }, npcEvent = { ...eventBase, eventId: "npc-vote", requestId: "reaction-request-1", actorId: "npc-1", source, stateVersion: 2, eventType: "vote_declared", targetId: "npc-1" };
  assert.doesNotThrow(() => validateEventReferences([npcEvent], { reactionPlans: [plan] }));
  assert.throws(() => validateEventReferences([{ ...npcEvent, correlationId: "other" }], { reactionPlans: [plan] }));
});

test("NpcReactionPlan version and correlation derive from originating input", () => {
  const plan = controlledPlan(); assert.doesNotThrow(() => validateReactionPlanReferences([plan], { inputRecords: [input] }));
  assert.throws(() => validateReactionPlanReferences([{ ...plan, resultingStateVersion: 3 }], { inputRecords: [input] }), (error) => error.code === "state_version_mismatch");
  assert.throws(() => validateReactionPlanReferences([{ ...plan, correlationId: "other" }], { inputRecords: [input] }));
});

test("DisplayPlan must cover raw input without prefix, gap, or suffix loss", () => {
  const complete = { schemaVersion: 1, displayPlanId: "display-complete", inputRecordId: "input-1", turnId: "turn-1", stateVersion: 1, segments: [{ segmentId: "raw-all", type: "raw_input", inputRecordId: "input-1", sourceSpan: { start: 0, end: 16 } }] };
  assert.doesNotThrow(() => validateDisplayPlanReferences([complete], { inputRecords: [input] }));
  assert.throws(() => validateDisplayPlanReferences([{ ...complete, segments: [{ ...complete.segments[0], sourceSpan: { start: 1, end: 16 } }] }], { inputRecords: [input] }));
  assert.throws(() => validateDisplayPlanReferences([{ ...complete, segments: [{ ...complete.segments[0], sourceSpan: { start: 0, end: 15 } }] }], { inputRecords: [input] }));
  assert.throws(() => validateDisplayPlanReferences([{ ...complete, segments: [{ segmentId: "raw-a", type: "raw_input", inputRecordId: "input-1", sourceSpan: { start: 0, end: 4 } }, { segmentId: "raw-b", type: "raw_input", inputRecordId: "input-1", sourceSpan: { start: 5, end: 16 } }] }], { inputRecords: [input] }));
});

test("graph enforces commit identity, finalization identity, and stream order uniqueness", () => {
  const baseResult = { schemaVersion: 1, requestId: "request-1", correlationId: "corr-1", requestFingerprint: fingerprint, commitType: "player_conversation", preconditionStateVersion: 0, resultingStateVersion: 1, inputRecordId: "input-1", displayPlanId: "display-1", playerPublicationId: "pub-1", createdEventIds: [], createdClaimIds: [], createdAtOrder: 0 };
  assert.throws(() => validateCommitResultReferences([baseResult, { ...baseResult }], {}));
  assert.throws(() => validateCommitResultReferences([baseResult, { ...baseResult, requestFingerprint: "b".repeat(64) }], {}), (error) => error.code === "idempotency_conflict");
  const { reservation, finalization } = controlledPublicationFixtures(), { recordType: _recordType, actorId: _actorId, correlationId: _correlationId, turnId: _turnId, stateVersion: _stateVersion, ...finalizationResult } = finalization;
  assert.throws(() => validateConversationGraph({ inputRecords: [input], reactionPlans: [controlledPlan()], publications: [reservation, finalization], finalizationResults: [finalizationResult, { ...finalizationResult }] }));
  assert.throws(() => validateConversationGraph({ inputRecords: [input, { ...input, inputRecordId: "input-2" }] }));
  const firstEvent = { ...eventBase, eventId: "event-a", eventType: "public_statement_recorded" }, secondEvent = { ...eventBase, eventId: "event-b", createdOrder: 0, eventType: "public_statement_recorded", source: { ...playerEventSource, acceptedSpeechActId: "act-2" } };
  assert.throws(() => validateConversationGraph({ inputRecords: [input], events: [firstEvent, secondEvent] }));
});

test("accepted act coverage enforces generated objects and canonical display ownership", () => {
  const roleEvent = { ...eventBase, eventId: "role-event", eventType: "role_claim_recorded", claimId: "claim-1" };
  const canonicalDisplay = { inputRecordId: "input-1", segments: [{ segmentId: "canonical-role", type: "canonical_claim", claimId: "claim-1" }] };
  assert.equal(validateAcceptedActCoverage({ acceptedSpeechActs: [roleAct], claims: [claim], events: [roleEvent], displayPlans: [canonicalDisplay] }), true);
  assert.throws(() => validateAcceptedActCoverage({ acceptedSpeechActs: [roleAct], claims: [], events: [roleEvent], displayPlans: [canonicalDisplay] }));
  assert.throws(() => validateAcceptedActCoverage({ acceptedSpeechActs: [roleAct], claims: [claim], events: [], displayPlans: [canonicalDisplay] }));
  assert.throws(() => validateAcceptedActCoverage({ acceptedSpeechActs: [roleAct], claims: [claim], events: [roleEvent], displayPlans: [{ ...canonicalDisplay, segments: [{ segmentId: "raw-role", type: "raw_input", inputRecordId: "input-1", sourceSpan: roleAct.sourceSpan }] }] }));
  const informationAct = { ...actBase, type: "accepted_information_request", topic: "rules" };
  assert.equal(validateAcceptedActCoverage({ acceptedSpeechActs: [informationAct] }), true);
  assert.throws(() => validateAcceptedActCoverage({ acceptedSpeechActs: [informationAct], events: [{ ...eventBase, eventId: "unexpected", eventType: "public_statement_recorded" }] }));
});

test("prepared and committed graph APIs have distinct completeness guarantees", () => {
  const informationAct = { ...actBase, type: "accepted_information_request", topic: "rules" }, partial = { inputRecords: [input], acceptedSpeechActs: [informationAct] };
  assert.equal(validatePreparedConversationGraph(partial), true);
  assert.throws(() => validateCommittedConversationGraph(partial), (error) => error.code === "publication_cardinality");
  assert.equal(validateConversationGraph, validateCommittedConversationGraph);
});

test("committed publication, finalization result, and request identities are complete", () => {
  const { reservation, finalization } = controlledPublicationFixtures(), reactionPlan = controlledPlan(), reactionResult = { schemaVersion: 1, requestId: "reaction-request-1", correlationId: "corr-1", requestFingerprint: fingerprint, commitType: "npc_reaction", resultMode: "controlled_commentary", preconditionStateVersion: 1, resultingStateVersion: 2, reactionPlanId: "plan-1", npcPublicationId: "pub-controlled", reservationId: "reservation-1", createdEventIds: [], createdClaimIds: [], createdAtOrder: 0 };
  assert.equal(validatePublicationCompleteness({ reactionPlans: [reactionPlan], publications: [reservation], commitResults: [reactionResult] }), true);
  assert.throws(() => validatePublicationCompleteness({ reactionPlans: [reactionPlan], publications: [], commitResults: [reactionResult] }));
  assert.throws(() => validatePublicationCompleteness({ reactionPlans: [reactionPlan], publications: [reservation], commitResults: [] }));
  assert.throws(() => validateFinalizationResultCompleteness({ publications: [reservation, finalization], finalizationResults: [] }));
  assert.equal(validateRequestIdentityCompleteness({ inputRecords: [input], reactionPlans: [reactionPlan] }), true);
  assert.throws(() => validateRequestIdentityCompleteness({ inputRecords: [input, { ...input, inputRecordId: "input-2" }] }));
  assert.throws(() => validateRequestIdentityCompleteness({ inputRecords: [input], reactionPlans: [{ ...reactionPlan, requestId: input.requestId }] }));
});

test("claim idempotency keys are recomputed from Player and NPC provenance", () => {
  assert.doesNotThrow(() => validateClaimReferences([claim], { acceptedSpeechActs: [roleAct] }));
  assert.throws(() => validateClaimReferences([{ ...claim, idempotencyKey: "f".repeat(64) }], { acceptedSpeechActs: [roleAct] }), (error) => error.code === "idempotency_key_mismatch");
  const plan = canonicalPlan(), source = { sourceType: "npc_reaction", reactionPlanId: "plan-1", descriptorId: "desc-1", originatingInputRecordId: "input-1", reactionCommitRequestId: "reaction-request-1" }, npcClaim = { ...claim, actorId: "npc-1", source, idempotencyKey: npcClaimIdempotencyKey({ reactionCommitRequestId: "reaction-request-1", reactionPlanId: "plan-1", descriptorId: "desc-1", actorId: "npc-1", claimKind: "role_claim" }) };
  assert.doesNotThrow(() => validateClaimReferences([npcClaim], { reactionPlans: [plan] }));
  assert.throws(() => validateClaimReferences([{ ...npcClaim, idempotencyKey: "e".repeat(64) }], { reactionPlans: [plan] }), (error) => error.code === "idempotency_key_mismatch");
});
