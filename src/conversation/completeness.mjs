import { ConversationValidationError } from "./validators.mjs";

function fail(path, code, message) { throw new ConversationValidationError(path, code, message); }
function count(values, predicate) { return values.filter(predicate).length; }

export function validateAcceptedActCoverage({ acceptedSpeechActs = [], claims = [], events = [], displayPlans = [] }) {
  for (const [index, act] of acceptedSpeechActs.entries()) {
    const sourcedClaims = claims.filter((claim) => claim.source.sourceType === "player_accepted_act" && claim.source.acceptedSpeechActIds.includes(act.speechActId));
    const sourcedEvents = events.filter((event) => event.source.sourceType === "player_accepted_act" && event.source.acceptedSpeechActId === act.speechActId);
    const plans = displayPlans.filter((plan) => plan.inputRecordId === act.inputRecordId), segments = plans.flatMap((plan) => plan.segments);
    const expectedEventType = { accepted_non_game_statement: "public_statement_recorded", accepted_question: "public_question_recorded", accepted_suspicion: "suspicion_expressed", accepted_vote_declaration: "vote_declared", accepted_role_claim: "role_claim_recorded", accepted_result_claim: "result_claim_recorded" }[act.type];
    const expectedClaimType = act.type === "accepted_role_claim" ? "role_claim" : act.type === "accepted_result_claim" ? "result_claim" : null;
    if (expectedClaimType ? sourcedClaims.length !== 1 || sourcedClaims[0].type !== expectedClaimType : sourcedClaims.length !== 0) fail(`acceptedSpeechActs[${index}]`, "missing_generated_object", "accepted act must generate exactly its required canonical claim set");
    if (expectedEventType ? sourcedEvents.length !== 1 || sourcedEvents[0].eventType !== expectedEventType : sourcedEvents.length !== 0) fail(`acceptedSpeechActs[${index}]`, "missing_generated_object", "accepted act must generate exactly its required semantic event set");
    if (expectedClaimType) { const claim = sourcedClaims[0], matching = segments.filter((segment) => segment.type === "canonical_claim" && segment.claimId === claim?.claimId); if (matching.length !== 1) fail(`acceptedSpeechActs[${index}]`, "missing_display_segment", "claim act must have exactly one canonical claim segment"); }
    if (act.type === "accepted_vote_declaration") { const matching = segments.filter((segment) => segment.type === "canonical_vote" && segment.voteEventId === sourcedEvents[0]?.eventId); if (matching.length !== 1) fail(`acceptedSpeechActs[${index}]`, "missing_display_segment", "vote act must have exactly one canonical vote segment"); }
    if (act.type === "accepted_suspicion") { const matching = segments.filter((segment) => segment.type === "canonical_suspicion" && segment.suspicionEventId === sourcedEvents[0]?.eventId); if (matching.length !== 1) fail(`acceptedSpeechActs[${index}]`, "missing_display_segment", "suspicion act must have exactly one canonical suspicion segment"); }
    if (["accepted_role_claim", "accepted_result_claim", "accepted_vote_declaration", "accepted_suspicion"].includes(act.type) && segments.some((segment) => segment.type === "raw_input" && segment.sourceSpan.start < act.sourceSpan.end && act.sourceSpan.start < segment.sourceSpan.end)) fail(`acceptedSpeechActs[${index}]`, "raw_state_changing_display", "state-changing source span cannot be displayed as raw input");
  }
  return true;
}

export function validateCommitCompleteness({ inputRecords = [], acceptedSpeechActs = [], reactionPlans = [], commitResults = [] }) {
  const playerResults = commitResults.filter((result) => result.commitType === "player_conversation"), npcResults = commitResults.filter((result) => result.commitType === "npc_reaction");
  for (const [index, result] of playerResults.entries()) {
    const inputs = inputRecords.filter((input) => input.inputRecordId === result.inputRecordId && input.requestId === result.requestId), acts = acceptedSpeechActs.filter((act) => act.inputRecordId === result.inputRecordId && act.requestId === result.requestId);
    if (inputs.length !== 1) fail(`commitResults[${index}].inputRecordId`, "commit_cardinality", "player commit requires exactly one input record");
    if (acts.length < 1 || acts.length > 4) fail(`commitResults[${index}]`, "accepted_act_cardinality", "player commit requires 1-4 accepted speech acts");
  }
  for (const [index, act] of acceptedSpeechActs.entries()) if (count(playerResults, (result) => result.inputRecordId === act.inputRecordId && result.requestId === act.requestId) !== 1) fail(`acceptedSpeechActs[${index}]`, "commit_result_cardinality", "committed accepted act requires exactly one player commit result");
  for (const [index, result] of npcResults.entries()) if (count(reactionPlans, (plan) => plan.reactionPlanId === result.reactionPlanId && plan.requestId === result.requestId) !== 1) fail(`commitResults[${index}].reactionPlanId`, "commit_cardinality", "NPC commit requires exactly one reaction plan");
  for (const [index, plan] of reactionPlans.entries()) if (count(npcResults, (result) => result.reactionPlanId === plan.reactionPlanId && result.requestId === plan.requestId) !== 1) fail(`reactionPlans[${index}]`, "commit_result_cardinality", "committed reaction plan requires exactly one NPC commit result");
  return true;
}

export function validateReactionDescriptorCoverage({ reactionPlans = [], claims = [], events = [] }) {
  for (const [planIndex, plan] of reactionPlans.entries()) for (const descriptor of plan.intendedSpeechActs) {
    const sourcedClaims = claims.filter((claim) => claim.source.sourceType === "npc_reaction" && claim.source.reactionPlanId === plan.reactionPlanId && claim.source.descriptorId === descriptor.descriptorId), sourcedEvents = events.filter((event) => event.source.sourceType === "npc_reaction" && event.source.reactionPlanId === plan.reactionPlanId && event.source.descriptorId === descriptor.descriptorId);
    const expectedEventType = { role_claim: "role_claim_recorded", result_claim: "result_claim_recorded", vote_declaration: "vote_declared", suspicion: "suspicion_expressed" }[descriptor.descriptorType], expectedClaimType = descriptor.descriptorType === "role_claim" ? "role_claim" : descriptor.descriptorType === "result_claim" ? "result_claim" : null;
    if (expectedClaimType ? sourcedClaims.length !== 1 || sourcedClaims[0].type !== expectedClaimType : sourcedClaims.length !== 0) fail(`reactionPlans[${planIndex}].intendedSpeechActs.${descriptor.descriptorId}`, "missing_generated_object", "reaction descriptor must generate exactly its required canonical claim set");
    if (expectedEventType ? sourcedEvents.length !== 1 || sourcedEvents[0].eventType !== expectedEventType : sourcedEvents.length !== 0) fail(`reactionPlans[${planIndex}].intendedSpeechActs.${descriptor.descriptorId}`, "missing_generated_object", "reaction descriptor must generate exactly its required semantic event set");
  }
  return true;
}

export function validatePublicationCompleteness({ inputRecords = [], acceptedSpeechActs = [], displayPlans = [], reactionPlans = [], publications = [], commitResults = [] }) {
  const committedInputs = inputRecords.filter((input) => acceptedSpeechActs.some((act) => act.inputRecordId === input.inputRecordId));
  for (const input of committedInputs) {
    if (count(displayPlans, (plan) => plan.inputRecordId === input.inputRecordId) !== 1) fail(`inputRecords.${input.inputRecordId}`, "publication_cardinality", "committed input requires exactly one display plan");
    if (count(publications, (record) => record.recordType === "player_utterance_published" && record.inputRecordId === input.inputRecordId) !== 1) fail(`inputRecords.${input.inputRecordId}`, "publication_cardinality", "committed input requires exactly one player publication");
    if (count(commitResults, (result) => result.commitType === "player_conversation" && result.inputRecordId === input.inputRecordId) !== 1) fail(`inputRecords.${input.inputRecordId}`, "commit_result_cardinality", "committed input requires exactly one player commit result");
  }
  for (const plan of reactionPlans) {
    const expected = plan.renderMode === "canonical_only" ? "npc_canonical_published" : "npc_publication_reserved";
    if (count(publications, (record) => record.recordType === expected && record.reactionPlanId === plan.reactionPlanId) !== 1) fail(`reactionPlans.${plan.reactionPlanId}`, "publication_cardinality", "committed reaction requires exactly one matching publication record");
    if (count(commitResults, (result) => result.commitType === "npc_reaction" && result.reactionPlanId === plan.reactionPlanId) !== 1) fail(`reactionPlans.${plan.reactionPlanId}`, "commit_result_cardinality", "committed reaction requires exactly one NPC commit result");
  }
  return true;
}

export function validateFinalizationResultCompleteness({ publications = [], finalizationResults = [] }) {
  for (const finalization of publications.filter((record) => record.recordType === "npc_publication_finalized")) if (count(finalizationResults, (result) => result.finalizationId === finalization.finalizationId && result.publicationId === finalization.publicationId) !== 1) fail(`publications.${finalization.publicationId}`, "finalization_result_cardinality", "settled finalization requires exactly one persisted result");
  return true;
}

export function validateRequestIdentityCompleteness({ inputRecords = [], reactionPlans = [] }) {
  const playerRequests = new Set(), reactionRequests = new Set();
  for (const input of inputRecords) { if (playerRequests.has(input.requestId)) fail(`inputRecords.${input.inputRecordId}.requestId`, "duplicate_request_id", "player request ID must identify exactly one input record"); playerRequests.add(input.requestId); }
  for (const plan of reactionPlans) { if (reactionRequests.has(plan.requestId) || playerRequests.has(plan.requestId)) fail(`reactionPlans.${plan.reactionPlanId}.requestId`, "duplicate_request_id", "reaction request ID must be unique across player and NPC requests"); reactionRequests.add(plan.requestId); }
  return true;
}
