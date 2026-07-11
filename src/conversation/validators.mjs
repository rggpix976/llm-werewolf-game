import { ID_PATTERN, SHA256_PATTERN, SCHEMA_VERSION, acceptedTypeForCandidate, candidateFields, canonicalDescriptorTypes, commentaryDescriptorTypes, descriptorFields, enums, eventFields } from "./domain.mjs";
import { assertUniqueIds } from "./ids.mjs";

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function fail(path, message) { throw new TypeError(`${path}: ${message}`); }
function object(value, path) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object"); }
function exact(value, required, optional = [], path = "value") {
  object(value, path); const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!own(value, key)) fail(path, `missing ${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(path, `unknown field ${key}`);
}
function literal(value, expected, path) { if (value !== expected) fail(path, `must equal ${expected}`); }
function id(value, path) { if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(path, "must be an ID"); }
function integer(value, min, path, max = Infinity) { if (!Number.isInteger(value) || value < min || value > max) fail(path, `must be an integer from ${min} to ${max}`); }
function oneOf(value, values, path) { if (!values.includes(value)) fail(path, "has an unsupported value"); }
function ids(values, min, max, path) { if (!Array.isArray(values) || values.length < min || values.length > max) fail(path, `must contain ${min}-${max} IDs`); try { assertUniqueIds(values, path); } catch (error) { fail(path, error.message); } }
function schema(value, path) { literal(value.schemaVersion, SCHEMA_VERSION, `${path}.schemaVersion`); }
function bool(value, path) { if (typeof value !== "boolean") fail(path, "must be boolean"); }
function enumField(obj, key, values, path) { oneOf(obj[key], values, `${path}.${key}`); }

export function validateSourceSpan(span, rawText, path = "sourceSpan") {
  exact(span, ["start", "end"], [], path); integer(span.start, 0, `${path}.start`); integer(span.end, 1, `${path}.end`);
  if (span.start >= span.end || span.end > [...rawText].length) fail(path, "must be within rawText Unicode code point bounds"); return span;
}

function validateTypedFields(value, fields, path) {
  for (const field of fields) {
    const key = field.replace("?", ""); if (field.endsWith("?") && !own(value, key)) continue;
    if (["targetId", "claimId", "referenceId"].includes(key)) id(value[key], `${path}.${key}`);
    else if (key === "claimedRole") enumField(value, key, enums.claimableRole, path);
    else if (key === "result") enumField(value, key, enums.claimResult, path);
    else if (key === "topic") oneOf(value[key], value.type === "information_request" || value.type === "accepted_information_request" ? ["rules", "commands", "history"] : enums.questionTopic, `${path}.${key}`);
    else if (key === "reason") oneOf(value[key], value.descriptorType === "decline" ? enums.declineReason : value.descriptorType === "clarification_request" ? enums.clarificationReason : ["gibberish", "missing_required_reference", "unsupported_intent", "off_topic"], `${path}.${key}`);
    else if (key === "allowedTargetIds") ids(value[key], 0, 16, `${path}.${key}`);
  }
}

export function validateSpeechActCandidate(value, rawText, path = "candidate") {
  object(value, path); const fields = candidateFields[value.type]; if (!fields) fail(path, "unknown candidate type");
  exact(value, ["type", ...fields, "sourceSpan"], [], path); validateTypedFields(value, fields, path); validateSourceSpan(value.sourceSpan, rawText, `${path}.sourceSpan`); return value;
}

export function validateSpeechActCandidates(values, rawText) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 4) fail("candidates", "must contain 1-4 items");
  let end = -1; values.forEach((value, index) => { validateSpeechActCandidate(value, rawText, `candidates[${index}]`); if (value.sourceSpan.start < end) fail(`candidates[${index}].sourceSpan`, "must be ordered and non-overlapping"); end = value.sourceSpan.end; }); return values;
}

export function validateUninterpretableAlternative(value, rawText, path = "alternative") {
  if (value.speechActs.length !== 1 || value.speechActs[0].type !== "uninterpretable") fail(path, "uninterpretable must be the only speech act");
  const span = value.speechActs[0].sourceSpan;
  if (span.start !== 0 || span.end !== [...rawText].length) fail(`${path}.speechActs[0].sourceSpan`, "uninterpretable must span the entire input");
  return value;
}

export function validateSpeechActAlternative(value, rawText, path = "alternative") {
  exact(value, ["alternativeId", "speechActs", "confidence"], [], path);
  id(value.alternativeId, `${path}.alternativeId`);
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) fail(`${path}.confidence`, "must be a finite number from 0 to 1");
  validateSpeechActCandidates(value.speechActs, rawText);
  if (value.speechActs.some((act) => act.type === "uninterpretable")) validateUninterpretableAlternative(value, rawText, path);
  return value;
}

export function validateInterpreterModelOutput(value, rawText) {
  const path = "interpreterModelOutput";
  exact(value, ["schemaVersion", "alternatives"], [], path); schema(value, path);
  if (!Array.isArray(value.alternatives) || value.alternatives.length < 1 || value.alternatives.length > 3) fail(`${path}.alternatives`, "must contain 1-3 alternatives");
  value.alternatives.forEach((alternative, index) => validateSpeechActAlternative(alternative, rawText, `${path}.alternatives[${index}]`));
  assertUniqueIds(value.alternatives.map((alternative) => alternative.alternativeId), "alternativeIds");
  return value;
}

const acceptedCommon = ["schemaVersion", "speechActId", "requestId", "acceptedTurnId", "acceptedStateVersion", "acceptedPhase", "inputRecordId", "actorId", "causationId", "correlationId", "idempotencyKey", "sourceSpan", "type"];
export function validateAcceptedSpeechAct(value, rawText, path = "acceptedSpeechAct") {
  const candidateType = Object.entries(acceptedTypeForCandidate).find(([, accepted]) => accepted === value?.type)?.[0]; if (!candidateType) fail(path, "unknown accepted type");
  const fields = candidateFields[candidateType]; exact(value, [...acceptedCommon, ...fields], [], path); schema(value, path);
  for (const key of ["speechActId", "requestId", "acceptedTurnId", "inputRecordId", "actorId", "causationId", "correlationId", "idempotencyKey"]) id(value[key], `${path}.${key}`);
  integer(value.acceptedStateVersion, 0, `${path}.acceptedStateVersion`); enumField(value, "acceptedPhase", enums.gamePhase, path); validateTypedFields(value, fields, path); validateSourceSpan(value.sourceSpan, rawText, `${path}.sourceSpan`); return value;
}

export function validatePlayerInputRecord(value) {
  const path = "playerInputRecord"; exact(value, ["schemaVersion", "inputRecordId", "requestId", "correlationId", "turnId", "capturedStateVersion", "actorId", "rawText", "locale", "createdOrder"], [], path); schema(value, path);
  for (const key of ["inputRecordId", "requestId", "correlationId", "turnId", "actorId"]) id(value[key], `${path}.${key}`); integer(value.capturedStateVersion, 0, `${path}.capturedStateVersion`); integer(value.createdOrder, 0, `${path}.createdOrder`); enumField(value, "locale", enums.supportedLocale, path); if (typeof value.rawText !== "string" || [...value.rawText].length < 1 || [...value.rawText].length > 2000) fail(`${path}.rawText`, "must contain 1-2000 Unicode code points"); return value;
}

export function validateClaimSource(value, path = "claimSource") {
  if (value?.sourceType === "player_accepted_act") { exact(value, ["sourceType", "acceptedSpeechActIds", "inputRecordId", "requestId"], [], path); ids(value.acceptedSpeechActIds, 1, 4, `${path}.acceptedSpeechActIds`); id(value.inputRecordId, `${path}.inputRecordId`); id(value.requestId, `${path}.requestId`); }
  else if (value?.sourceType === "npc_reaction") { exact(value, ["sourceType", "reactionPlanId", "descriptorId", "originatingInputRecordId", "reactionCommitRequestId"], [], path); for (const k of Object.keys(value).filter((k) => k !== "sourceType")) id(value[k], `${path}.${k}`); }
  else fail(path, "unknown sourceType"); return value;
}

export function validateCanonicalClaim(value, path = "canonicalClaim") {
  const extra = value?.type === "role_claim" ? ["claimedRole"] : value?.type === "result_claim" ? ["targetId", "result"] : fail(path, "unknown type");
  exact(value, ["schemaVersion", "claimId", "claimRevision", "actorId", "source", "idempotencyKey", "createdTurnId", "createdStateVersion", "repeatsClaimId", "contradictsClaimIds", "status", "type", ...extra], [], path); schema(value, path);
  for (const k of ["claimId", "actorId", "createdTurnId"]) id(value[k], `${path}.${k}`); literal(value.claimRevision, 1, `${path}.claimRevision`); integer(value.createdStateVersion, 0, `${path}.createdStateVersion`); if (!SHA256_PATTERN.test(value.idempotencyKey)) fail(`${path}.idempotencyKey`, "must be SHA-256");
  if (value.repeatsClaimId !== null) id(value.repeatsClaimId, `${path}.repeatsClaimId`); ids(value.contradictsClaimIds, 0, 64, `${path}.contradictsClaimIds`); if (value.repeatsClaimId && value.contradictsClaimIds.length) fail(path, "repeat and contradiction are mutually exclusive"); literal(value.status, "asserted", `${path}.status`); validateClaimSource(value.source, `${path}.source`); validateTypedFields(value, extra, path); return value;
}

export function validateSemanticEventSource(value, path = "source") {
  const keys = value?.sourceType === "player_accepted_act" ? ["acceptedSpeechActId", "inputRecordId", "requestId"] : value?.sourceType === "npc_reaction" ? ["reactionPlanId", "descriptorId", "originatingInputRecordId", "reactionCommitRequestId"] : fail(path, "unknown sourceType"); exact(value, ["sourceType", ...keys], [], path); keys.forEach((k) => id(value[k], `${path}.${k}`)); return value;
}

export function validatePublicEvent(value, path = "publicEvent") {
  const extra = eventFields[value?.eventType]; if (!extra) fail(path, "unknown eventType"); const common = ["schemaVersion", "eventId", "requestId", "turnId", "actorId", "causationId", "correlationId", "idempotencyKey", "source", "stateVersion", "occurredPhase", "createdOrder", "eventType"];
  exact(value, [...common, ...extra], [], path); schema(value, path); for (const k of ["eventId", "requestId", "turnId", "actorId", "causationId", "correlationId", "idempotencyKey"]) id(value[k], `${path}.${k}`); integer(value.stateVersion, 0, `${path}.stateVersion`); integer(value.createdOrder, 0, `${path}.createdOrder`); enumField(value, "occurredPhase", enums.gamePhase, path); validateSemanticEventSource(value.source, `${path}.source`); validateTypedFields(value, extra, path); return value;
}

export function validatePlayerUtteranceDisplayPlan(value, input, displaySources = {}) {
  const path = "displayPlan"; exact(value, ["schemaVersion", "displayPlanId", "inputRecordId", "turnId", "stateVersion", "segments"], [], path); schema(value, path); ["displayPlanId", "inputRecordId", "turnId"].forEach((k) => id(value[k], `${path}.${k}`)); integer(value.stateVersion, 0, `${path}.stateVersion`); if (!Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > 64) fail(`${path}.segments`, "must contain 1-64 segments");
  if (!input || value.inputRecordId !== input.inputRecordId || value.turnId !== input.turnId) fail(path, "input and turn references must match the PlayerInputRecord");
  const canonicalSpans = displaySources.canonicalSpans ?? new Map(); let previousRawEnd = -1;
  const segmentIds = []; value.segments.forEach((segment, i) => { const p = `${path}.segments[${i}]`; const fields = segment.type === "raw_input" ? ["inputRecordId", "sourceSpan"] : segment.type === "canonical_claim" ? ["claimId"] : segment.type === "canonical_vote" ? ["voteEventId"] : segment.type === "canonical_suspicion" ? ["suspicionEventId"] : fail(p, "unknown type"); exact(segment, ["segmentId", "type", ...fields], [], p); id(segment.segmentId, `${p}.segmentId`); segmentIds.push(segment.segmentId); fields.filter((k) => k !== "sourceSpan").forEach((k) => id(segment[k], `${p}.${k}`)); if (segment.sourceSpan) { validateSourceSpan(segment.sourceSpan, input.rawText, `${p}.sourceSpan`); if (segment.inputRecordId !== value.inputRecordId || segment.sourceSpan.start < previousRawEnd) fail(p, "raw spans must match the input and be ordered without overlap"); for (const span of canonicalSpans.values()) if (segment.sourceSpan.start < span.end && span.start < segment.sourceSpan.end) fail(p, "raw span duplicates canonicalized content"); previousRawEnd = segment.sourceSpan.end; } }); assertUniqueIds(segmentIds, "segmentIds"); return value;
}

export function validateSpeechActDescriptor(value, expectedMode, path = "descriptor") {
  const fields = descriptorFields[value?.descriptorType]; if (!fields) fail(path, "unknown descriptorType"); const allowed = expectedMode === "canonical_only" ? canonicalDescriptorTypes : commentaryDescriptorTypes; if (!allowed.includes(value.descriptorType)) fail(path, `descriptor is not allowed in ${expectedMode}`); const required = fields.filter((x) => !x.endsWith("?")); const optional = fields.filter((x) => x.endsWith("?")).map((x) => x.slice(0, -1)); exact(value, ["descriptorId", "descriptorType", ...required], optional, path); id(value.descriptorId, `${path}.descriptorId`); validateTypedFields(value, fields, path); return value;
}

export function validateNpcReactionPlan(value) {
  const path = "reactionPlan", common = ["schemaVersion", "requestId", "correlationId", "causationId", "originatingInputRecordId", "locale", "causationEventIds", "reactionPlanId", "turnId", "resultingStateVersion", "npcId", "renderMode", "intendedSpeechActs", "policies", "maxChars"];
  const tail = value?.renderMode === "canonical_only" ? ["canonicalSegments"] : value?.renderMode === "controlled_commentary" ? ["commentaryPlan"] : fail(path, "unknown renderMode"); exact(value, [...common, ...tail], [], path); schema(value, path); ["requestId", "correlationId", "causationId", "originatingInputRecordId", "reactionPlanId", "turnId", "npcId"].forEach((k) => id(value[k], `${path}.${k}`)); enumField(value, "locale", enums.supportedLocale, path); ids(value.causationEventIds, 0, 16, `${path}.causationEventIds`); integer(value.resultingStateVersion, 1, `${path}.resultingStateVersion`); integer(value.maxChars, 1, `${path}.maxChars`, 1000);
  if (!Array.isArray(value.intendedSpeechActs) || value.intendedSpeechActs.length < 1 || value.intendedSpeechActs.length > 16) fail(`${path}.intendedSpeechActs`, "must contain 1-16 descriptors"); value.intendedSpeechActs.forEach((d, i) => validateSpeechActDescriptor(d, value.renderMode, `${path}.intendedSpeechActs[${i}]`)); assertUniqueIds(value.intendedSpeechActs.map((d) => d.descriptorId), "descriptorIds");
  exact(value.policies, ["policyType", "allowStateChanges", "allowClaims", "allowVoteDeclaration", "allowSuspicionUpdate", "allowMemoryUpdate"], [], `${path}.policies`); literal(value.policies.policyType, "reaction_policies", `${path}.policies.policyType`); Object.keys(value.policies).filter((k) => k !== "policyType").forEach((k) => bool(value.policies[k], `${path}.policies.${k}`));
  const types = new Set(value.intendedSpeechActs.map((descriptor) => descriptor.descriptorType));
  const expectedPolicies = value.renderMode === "controlled_commentary" ? { allowStateChanges: false, allowClaims: false, allowVoteDeclaration: false, allowSuspicionUpdate: false, allowMemoryUpdate: false } : { allowStateChanges: true, allowClaims: types.has("role_claim") || types.has("result_claim"), allowVoteDeclaration: types.has("vote_declaration"), allowSuspicionUpdate: types.has("suspicion"), allowMemoryUpdate: types.has("vote_declaration") };
  for (const [key, expected] of Object.entries(expectedPolicies)) if (value.policies[key] !== expected) fail(`${path}.policies.${key}`, "does not reflect intended descriptors");
  if (value.renderMode === "controlled_commentary") { exact(value.commentaryPlan, ["intent", "allowedPublicReferenceIds"], [], `${path}.commentaryPlan`); enumField(value.commentaryPlan, "intent", enums.commentaryIntent, `${path}.commentaryPlan`); ids(value.commentaryPlan.allowedPublicReferenceIds, 0, 32, `${path}.commentaryPlan.allowedPublicReferenceIds`); }
  else validateCanonicalSegments(value.canonicalSegments, value.intendedSpeechActs); return value;
}

function validateCanonicalSegments(segments, descriptors) { const compatible = { role_claim: "canonical_claim", result_claim: "canonical_claim", vote_declaration: "canonical_vote", suspicion: "canonical_suspicion" }; if (!Array.isArray(segments) || segments.length < 1 || segments.length > 16 || segments.length !== descriptors.length) fail("reactionPlan.canonicalSegments", "must cover descriptors exactly once"); segments.forEach((s, i) => { const field = s.type === "canonical_claim" ? "claimId" : s.type === "canonical_vote" ? "voteEventId" : s.type === "canonical_suspicion" ? "suspicionEventId" : fail(`canonicalSegments[${i}]`, "unknown type"); exact(s, ["segmentId", "descriptorId", "type", field], [], `canonicalSegments[${i}]`); ["segmentId", "descriptorId", field].forEach((k) => id(s[k], `canonicalSegments[${i}].${k}`)); if (s.descriptorId !== descriptors[i].descriptorId || s.type !== compatible[descriptors[i].descriptorType]) fail(`canonicalSegments[${i}]`, "segment type and order must match its descriptor"); }); assertUniqueIds(segments.map((s) => s.segmentId), "canonicalSegmentIds"); }

export function validateControlledCommentaryVariant(value) { const p = "variant"; exact(value, ["schemaVersion", "variantId", "variantVersion", "locale", "renderMode", "intent", "text", "enabled", "maximumRenderedChars", "toneTags", "lifecycle"], [], p); schema(value, p); id(value.variantId, `${p}.variantId`); integer(value.variantVersion, 1, `${p}.variantVersion`); enumField(value, "locale", enums.supportedLocale, p); literal(value.renderMode, "controlled_commentary", `${p}.renderMode`); enumField(value, "intent", enums.commentaryIntent, p); if (typeof value.text !== "string" || [...value.text].length < 1 || [...value.text].length > 240 || /\{[^}]*\}/.test(value.text)) fail(`${p}.text`, "must be placeholder-free text of 1-240 code points"); bool(value.enabled, `${p}.enabled`); integer(value.maximumRenderedChars, [...value.text].length, `${p}.maximumRenderedChars`, 240); if (!Array.isArray(value.toneTags) || value.toneTags.length > 4 || new Set(value.toneTags).size !== value.toneTags.length) fail(`${p}.toneTags`, "must contain 0-4 unique tags"); value.toneTags.forEach((tag) => oneOf(tag, enums.toneTag, `${p}.toneTags`)); enumField(value, "lifecycle", enums.variantLifecycle, p); return value; }

export function validateSelectedCommentaryVariant(value) { exact(value, ["variantId", "variantVersion", "locale"], [], "selection"); id(value.variantId, "selection.variantId"); integer(value.variantVersion, 1, "selection.variantVersion"); enumField(value, "locale", enums.supportedLocale, "selection"); return value; }

export function validateDisplayPublicationRecord(value) {
  const p = "publication", base = ["schemaVersion", "recordType", "publicationId", "correlationId", "turnId", "actorId", "publicationSlotOrder", "recordAppendOrder"];
  const fields = {
    player_utterance_published: ["requestId", "gameStateVersion", "occurredPhase", "inputRecordId", "displayPlanId", "idempotencyKey"],
    npc_canonical_published: ["reactionPlanId", "reactionCommitRequestId", "originatingInputRecordId", "reactionResultingStateVersion", "locale", "canonicalRendererVersion", "canonicalSegmentIds"],
    npc_publication_reserved: ["reservationId", "reactionPlanId", "reactionCommitRequestId", "originatingInputRecordId", "reactionResultingStateVersion", "locale", "renderMode", "fallbackVariantId", "fallbackVariantVersion", "status"],
    npc_publication_finalized: ["finalizationId", "reservationId", "reactionPlanId", "source", "stateVersion", "locale", "selectedVariantId", "selectedVariantVersion", "finalizationReason", "fallbackUsed", "createdAt"]
  }[value?.recordType]; if (!fields) fail(p, "unknown recordType"); exact(value, [...base, ...fields], [], p); schema(value, p);
  for (const k of [...base, ...fields]) if (!new Set(["schemaVersion", "recordType", "gameStateVersion", "reactionResultingStateVersion", "canonicalRendererVersion", "fallbackVariantVersion", "stateVersion", "selectedVariantVersion", "publicationSlotOrder", "recordAppendOrder", "occurredPhase", "locale", "renderMode", "status", "source", "canonicalSegmentIds", "finalizationReason", "fallbackUsed", "createdAt"]).has(k)) id(value[k], `${p}.${k}`);
  integer(value.publicationSlotOrder, 0, `${p}.publicationSlotOrder`); integer(value.recordAppendOrder, 0, `${p}.recordAppendOrder`);
  for (const k of ["gameStateVersion", "reactionResultingStateVersion", "stateVersion"]) if (own(value, k)) integer(value[k], k === "gameStateVersion" ? 0 : 1, `${p}.${k}`);
  for (const k of ["canonicalRendererVersion", "fallbackVariantVersion", "selectedVariantVersion"]) if (own(value, k)) integer(value[k], 1, `${p}.${k}`);
  if (own(value, "locale")) enumField(value, "locale", enums.supportedLocale, p); if (own(value, "occurredPhase")) enumField(value, "occurredPhase", enums.gamePhase, p); if (own(value, "canonicalSegmentIds")) ids(value.canonicalSegmentIds, 1, 16, `${p}.canonicalSegmentIds`);
  if (value.recordType === "npc_publication_reserved") { literal(value.renderMode, "controlled_commentary", `${p}.renderMode`); literal(value.status, "reserved", `${p}.status`); }
  if (value.recordType === "npc_publication_finalized") { exact(value.source, ["sourceType", "rendererRequestId"], [], `${p}.source`); literal(value.source.sourceType, "renderer_request", `${p}.source.sourceType`); id(value.source.rendererRequestId, `${p}.source.rendererRequestId`); enumField(value, "finalizationReason", enums.finalizationReason, p); bool(value.fallbackUsed, `${p}.fallbackUsed`); if (typeof value.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value.createdAt)) fail(`${p}.createdAt`, "must be RFC3339 UTC"); }
  return value;
}

export function validateNpcPublicationFinalizationResult(value) {
  const p = "finalizationResult";
  exact(value, ["schemaVersion", "publicationId", "reservationId", "finalizationId", "reactionPlanId", "source", "locale", "selectedVariantId", "selectedVariantVersion", "fallbackUsed", "finalizationReason", "publicationSlotOrder", "recordAppendOrder", "createdAt"], [], p);
  schema(value, p);
  for (const key of ["publicationId", "reservationId", "finalizationId", "reactionPlanId", "selectedVariantId"]) id(value[key], `${p}.${key}`);
  exact(value.source, ["sourceType", "rendererRequestId"], [], `${p}.source`); literal(value.source.sourceType, "renderer_request", `${p}.source.sourceType`); id(value.source.rendererRequestId, `${p}.source.rendererRequestId`);
  enumField(value, "locale", enums.supportedLocale, p); integer(value.selectedVariantVersion, 1, `${p}.selectedVariantVersion`); bool(value.fallbackUsed, `${p}.fallbackUsed`); enumField(value, "finalizationReason", enums.finalizationReason, p); integer(value.publicationSlotOrder, 0, `${p}.publicationSlotOrder`); integer(value.recordAppendOrder, 0, `${p}.recordAppendOrder`);
  if (typeof value.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value.createdAt)) fail(`${p}.createdAt`, "must be RFC3339 UTC");
  return value;
}

export function validateConversationCommitResult(value) {
  const p = "commitResult", common = ["schemaVersion", "requestId", "correlationId", "requestFingerprint", "commitType", "preconditionStateVersion", "resultingStateVersion", "createdEventIds", "createdClaimIds", "createdAtOrder"];
  let extra;
  if (value?.commitType === "player_conversation") extra = ["inputRecordId", "displayPlanId", "playerPublicationId"];
  else if (value?.commitType === "npc_reaction" && value.resultMode === "canonical_only") extra = ["resultMode", "reactionPlanId", "npcPublicationId"];
  else if (value?.commitType === "npc_reaction" && value.resultMode === "controlled_commentary") extra = ["resultMode", "reactionPlanId", "npcPublicationId", "reservationId"];
  else fail(p, "unknown commit result member"); exact(value, [...common, ...extra], [], p); schema(value, p); ["requestId", "correlationId", ...extra.filter((k) => !["resultMode"].includes(k))].forEach((k) => id(value[k], `${p}.${k}`)); if (!SHA256_PATTERN.test(value.requestFingerprint)) fail(`${p}.requestFingerprint`, "must be SHA-256"); integer(value.preconditionStateVersion, 0, `${p}.preconditionStateVersion`); integer(value.resultingStateVersion, 1, `${p}.resultingStateVersion`); if (value.resultingStateVersion !== value.preconditionStateVersion + 1) fail(p, "state version must increment exactly once"); ids(value.createdEventIds, 0, 64, `${p}.createdEventIds`); ids(value.createdClaimIds, 0, 4, `${p}.createdClaimIds`); integer(value.createdAtOrder, 0, `${p}.createdAtOrder`); return value;
}

export { validateReferentialIntegrity } from "./references.mjs";
