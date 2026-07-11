import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, classifyIdempotentWrite, npcClaimIdempotencyKey, playerClaimIdempotencyKey, sha256Fingerprint } from "../src/conversation/ids.mjs";
import { renderCanonicalClaim, renderCanonicalSuspicion, renderCanonicalVote, resolveHistoricalVariant, validateRendererSelection } from "../src/conversation/canonicalRenderer.mjs";
import { candidateFields, enums } from "../src/conversation/domain.mjs";
import { validateAcceptedSpeechAct, validateCanonicalClaim, validateControlledCommentaryVariant, validateConversationCommitResult, validateDisplayPublicationRecord, validateInterpreterModelOutput, validateNpcPublicationFinalizationResult, validateNpcReactionPlan, validatePlayerInputRecord, validatePlayerUtteranceDisplayPlan, validatePublicEvent, validateReferentialIntegrity, validateSelectedCommentaryVariant, validateSpeechActCandidates, validateSourceSpan } from "../src/conversation/validators.mjs";

const fingerprint = "a".repeat(64);
const input = { schemaVersion: 1, inputRecordId: "input-1", requestId: "request-1", correlationId: "corr-1", turnId: "turn-1", capturedStateVersion: 0, actorId: "player", rawText: "😀占い師です。Beniが怪しい。", locale: "ja-JP", createdOrder: 0 };
const playerSource = { sourceType: "player_accepted_act", acceptedSpeechActIds: ["act-1"], inputRecordId: "input-1", requestId: "request-1" };
const claim = { schemaVersion: 1, claimId: "claim-1", claimRevision: 1, actorId: "player", source: playerSource, idempotencyKey: fingerprint, createdTurnId: "turn-1", createdStateVersion: 1, repeatsClaimId: null, contradictsClaimIds: [], status: "asserted", type: "role_claim", claimedRole: "seer" };
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
  const plan = { schemaVersion: 1, displayPlanId: "display-1", inputRecordId: "input-1", turnId: "turn-1", stateVersion: 1, segments: [{ segmentId: "seg-1", type: "canonical_claim", claimId: "claim-1" }] };
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
