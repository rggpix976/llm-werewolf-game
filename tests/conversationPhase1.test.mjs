import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, npcClaimIdempotencyKey, playerClaimIdempotencyKey, sha256Fingerprint } from "../src/conversation/ids.mjs";
import { renderCanonicalClaim, renderCanonicalSuspicion, renderCanonicalVote, resolveSelectedCommentaryVariant } from "../src/conversation/canonicalRenderer.mjs";
import { validateCanonicalClaim, validateControlledCommentaryVariant, validateConversationCommitResult, validateDisplayPublicationRecord, validateNpcReactionPlan, validatePlayerInputRecord, validatePlayerUtteranceDisplayPlan, validatePublicEvent, validateReferentialIntegrity, validateSelectedCommentaryVariant, validateSpeechActCandidates, validateSourceSpan } from "../src/conversation/validators.mjs";

const fingerprint = "a".repeat(64);
const input = { schemaVersion: 1, inputRecordId: "input-1", requestId: "request-1", correlationId: "corr-1", turnId: "turn-1", capturedStateVersion: 0, actorId: "player", rawText: "😀占い師です。Beniが怪しい。", locale: "ja-JP", createdOrder: 0 };
const playerSource = { sourceType: "player_accepted_act", acceptedSpeechActIds: ["act-1"], inputRecordId: "input-1", requestId: "request-1" };
const claim = { schemaVersion: 1, claimId: "claim-1", claimRevision: 1, actorId: "player", source: playerSource, idempotencyKey: fingerprint, createdTurnId: "turn-1", createdStateVersion: 1, repeatsClaimId: null, contradictsClaimIds: [], status: "asserted", type: "role_claim", claimedRole: "seer" };

test("SourceSpan counts Unicode code points and candidates reject overlap", () => {
  assert.equal(validateSourceSpan({ start: 0, end: 1 }, "😀a").end, 1);
  assert.throws(() => validateSourceSpan({ start: 0, end: 3 }, "😀a"));
  assert.throws(() => validateSpeechActCandidates([{ type: "role_claim", claimedRole: "seer", sourceSpan: { start: 0, end: 6 } }, { type: "suspicion", targetId: "npc-1", sourceSpan: { start: 5, end: 8 } }], input.rawText));
});

test("candidate unions are closed and enums are strict", () => {
  assert.doesNotThrow(() => validateSpeechActCandidates([{ type: "role_claim", claimedRole: "seer", sourceSpan: { start: 1, end: 7 } }], input.rawText));
  assert.throws(() => validateSpeechActCandidates([{ type: "role_claim", claimedRole: "fox", sourceSpan: { start: 1, end: 7 } }], input.rawText));
  assert.throws(() => validateSpeechActCandidates([{ type: "role_claim", claimedRole: "seer", confidence: 1, sourceSpan: { start: 1, end: 7 } }], input.rawText));
});

test("PlayerInputRecord enforces locale and Unicode length", () => {
  assert.equal(validatePlayerInputRecord(input), input);
  assert.throws(() => validatePlayerInputRecord({ ...input, locale: "fr" }));
  assert.throws(() => validatePlayerInputRecord({ ...input, rawText: "" }));
});

test("canonical claim validates strict provenance and relationship rules", () => {
  assert.equal(validateCanonicalClaim(claim), claim);
  assert.throws(() => validateCanonicalClaim({ ...claim, source: { ...playerSource, descriptorId: "bad" } }));
  assert.throws(() => validateCanonicalClaim({ ...claim, repeatsClaimId: "claim-0", contradictsClaimIds: ["claim-x"] }));
});

test("PublicEvent source is a strict discriminated union", () => {
  const event = { schemaVersion: 1, eventId: "event-1", requestId: "request-1", turnId: "turn-1", actorId: "player", causationId: "cause-1", correlationId: "corr-1", idempotencyKey: "idem-1", source: { sourceType: "player_accepted_act", acceptedSpeechActId: "act-1", inputRecordId: "input-1", requestId: "request-1" }, stateVersion: 1, occurredPhase: "day_discussion", createdOrder: 0, eventType: "role_claim_recorded", claimId: "claim-1" };
  assert.equal(validatePublicEvent(event), event);
  assert.throws(() => validatePublicEvent({ ...event, sourceSpan: { start: 0, end: 1 } }));
});

test("display plan validates segment unions and references", () => {
  const plan = { schemaVersion: 1, displayPlanId: "display-1", inputRecordId: "input-1", turnId: "turn-1", stateVersion: 1, segments: [{ segmentId: "seg-1", type: "canonical_claim", claimId: "claim-1" }] };
  assert.equal(validatePlayerUtteranceDisplayPlan(plan, input), plan);
  assert.equal(validateReferentialIntegrity({ claims: [claim], inputRecords: [input], displayPlans: [plan] }), true);
  assert.throws(() => validateReferentialIntegrity({ inputRecords: [input], displayPlans: [plan] }));
});

test("NPC canonical plan requires exact descriptor coverage", () => {
  const plan = { schemaVersion: 1, requestId: "reaction-request-1", correlationId: "corr-1", causationId: "cause-1", originatingInputRecordId: "input-1", locale: "ja", causationEventIds: [], reactionPlanId: "plan-1", turnId: "turn-1", resultingStateVersion: 2, npcId: "npc-1", renderMode: "canonical_only", intendedSpeechActs: [{ descriptorId: "desc-1", descriptorType: "role_claim", claimedRole: "seer" }], policies: { policyType: "reaction_policies", allowStateChanges: true, allowClaims: true, allowVoteDeclaration: false, allowSuspicionUpdate: false, allowMemoryUpdate: false }, canonicalSegments: [{ segmentId: "seg-1", descriptorId: "desc-1", type: "canonical_claim", claimId: "claim-2" }], maxChars: 200 };
  assert.equal(validateNpcReactionPlan(plan), plan);
  assert.throws(() => validateNpcReactionPlan({ ...plan, canonicalSegments: [{ ...plan.canonicalSegments[0], descriptorId: "desc-2" }] }));
});

test("controlled commentary prohibits state changes and validates registry entries", () => {
  const variant = { schemaVersion: 1, variantId: "ack-1", variantVersion: 1, locale: "en", renderMode: "controlled_commentary", intent: "acknowledge", text: "Understood.", enabled: true, maximumRenderedChars: 20, toneTags: ["brief"], lifecycle: "active" };
  assert.equal(validateControlledCommentaryVariant(variant), variant);
  assert.throws(() => validateControlledCommentaryVariant({ ...variant, text: "Hello {name}" }));
  const selection = { variantId: "ack-1", variantVersion: 1, locale: "en" };
  assert.equal(validateSelectedCommentaryVariant(selection), selection);
  assert.equal(resolveSelectedCommentaryVariant(selection, [variant]), "Understood.");
  assert.throws(() => resolveSelectedCommentaryVariant({ ...selection, locale: "en-US" }, [variant]));
});

test("publication and commit-result unions are strict", () => {
  const publication = { schemaVersion: 1, recordType: "player_utterance_published", publicationId: "pub-1", requestId: "request-1", correlationId: "corr-1", turnId: "turn-1", gameStateVersion: 1, occurredPhase: "day_discussion", actorId: "player", inputRecordId: "input-1", displayPlanId: "display-1", idempotencyKey: "idem-1", publicationSlotOrder: 0, recordAppendOrder: 0 };
  assert.equal(validateDisplayPublicationRecord(publication), publication);
  const result = { schemaVersion: 1, requestId: "request-1", correlationId: "corr-1", requestFingerprint: fingerprint, commitType: "player_conversation", preconditionStateVersion: 0, resultingStateVersion: 1, inputRecordId: "input-1", displayPlanId: "display-1", playerPublicationId: "pub-1", createdEventIds: [], createdClaimIds: ["claim-1"], createdAtOrder: 0 };
  assert.equal(validateConversationCommitResult(result), result);
  assert.throws(() => validateConversationCommitResult({ ...result, resultingStateVersion: 2 }));
});

test("ID fingerprints use deterministic canonical JSON", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(sha256Fingerprint({ b: 2, a: 1 }), sha256Fingerprint({ a: 1, b: 2 }));
  assert.equal(playerClaimIdempotencyKey({ requestId: "r", acceptedSpeechActIds: ["b", "a"], actorId: "p", claimKind: "role_claim" }), playerClaimIdempotencyKey({ requestId: "r", acceptedSpeechActIds: ["a", "b"], actorId: "p", claimKind: "role_claim" }));
  assert.match(npcClaimIdempotencyKey({ reactionCommitRequestId: "r", reactionPlanId: "p", descriptorId: "d", actorId: "n", claimKind: "result_claim" }), /^[0-9a-f]{64}$/);
});

test("canonical renderers are deterministic and locale-owned", () => {
  assert.equal(renderCanonicalClaim(claim, "en"), "player claimed seer.");
  assert.equal(renderCanonicalVote({ actorId: "npc-1", targetId: "npc-2" }, "ja"), "npc-1はnpc-2への投票を宣言しました。");
  assert.equal(renderCanonicalSuspicion({ actorId: "npc-1", targetId: "npc-2" }, "en-US"), "npc-1 expressed suspicion of npc-2.");
});
