function fail(message) { throw new TypeError(message); }
function uniqueIndex(values, key, label) {
  const index = new Map();
  for (const value of values) {
    const id = value[key];
    if (index.has(id)) fail(`duplicate ${label} ${id}`);
    index.set(id, value);
  }
  return index;
}

export function validateClaimReferences(claims, { acceptedSpeechActs = [], reactionPlans = [] } = {}) {
  const acts = uniqueIndex(acceptedSpeechActs, "speechActId", "accepted speech act"), plans = uniqueIndex(reactionPlans, "reactionPlanId", "reaction plan"), claimIndex = uniqueIndex(claims, "claimId", "claim");
  for (const claim of claims) {
    if (claim.source.sourceType === "player_accepted_act") {
      for (const actId of claim.source.acceptedSpeechActIds) { const act = acts.get(actId); if (!act || act.inputRecordId !== claim.source.inputRecordId || act.requestId !== claim.source.requestId || act.actorId !== claim.actorId) fail(`invalid player claim source ${actId}`); }
    } else {
      const plan = plans.get(claim.source.reactionPlanId), descriptor = plan?.intendedSpeechActs.find((item) => item.descriptorId === claim.source.descriptorId);
      if (!plan || plan.npcId !== claim.actorId || plan.originatingInputRecordId !== claim.source.originatingInputRecordId || plan.requestId !== claim.source.reactionCommitRequestId || descriptor?.descriptorType !== claim.type) fail(`invalid NPC claim source ${claim.claimId}`);
    }
    for (const relatedId of [claim.repeatsClaimId, ...claim.contradictsClaimIds].filter(Boolean)) if (!claimIndex.has(relatedId)) fail(`dangling related claim ${relatedId}`);
  }
  return true;
}

export function validateEventReferences(events, { acceptedSpeechActs = [], reactionPlans = [] } = {}) {
  const acts = uniqueIndex(acceptedSpeechActs, "speechActId", "accepted speech act"), plans = uniqueIndex(reactionPlans, "reactionPlanId", "reaction plan");
  const compatible = { public_statement_recorded: "accepted_non_game_statement", public_question_recorded: "accepted_question", suspicion_expressed: "suspicion", vote_declared: "vote_declaration", role_claim_recorded: "role_claim", result_claim_recorded: "result_claim" };
  for (const event of events) {
    if (event.source.sourceType === "player_accepted_act") { const act = acts.get(event.source.acceptedSpeechActId); if (!act || act.inputRecordId !== event.source.inputRecordId || act.requestId !== event.source.requestId || act.actorId !== event.actorId) fail(`invalid player event source ${event.eventId}`); }
    else { const plan = plans.get(event.source.reactionPlanId), descriptor = plan?.intendedSpeechActs.find((item) => item.descriptorId === event.source.descriptorId); if (!plan || plan.npcId !== event.actorId || plan.originatingInputRecordId !== event.source.originatingInputRecordId || plan.requestId !== event.source.reactionCommitRequestId || descriptor?.descriptorType !== compatible[event.eventType]) fail(`invalid NPC event source ${event.eventId}`); }
  }
  return true;
}

export function validateReactionPlanReferences(reactionPlans, { inputRecords = [], events = [] } = {}) {
  const inputs = uniqueIndex(inputRecords, "inputRecordId", "input record"), eventIndex = uniqueIndex(events, "eventId", "event");
  for (const plan of reactionPlans) { const input = inputs.get(plan.originatingInputRecordId); if (!input || input.locale !== plan.locale || input.turnId !== plan.turnId) fail(`invalid originating input for ${plan.reactionPlanId}`); for (const eventId of plan.causationEventIds) { const event = eventIndex.get(eventId); if (!event || event.stateVersion >= plan.resultingStateVersion) fail(`invalid causation event ${eventId}`); } }
  return true;
}

export function validateDisplayPlanReferences(displayPlans, { inputRecords = [], claims = [], events = [], canonicalSpans = new Map() } = {}) {
  const inputs = uniqueIndex(inputRecords, "inputRecordId", "input record"), claimIndex = uniqueIndex(claims, "claimId", "claim"), eventIndex = uniqueIndex(events, "eventId", "event");
  for (const plan of displayPlans) { const input = inputs.get(plan.inputRecordId); if (!input || input.turnId !== plan.turnId) fail(`invalid display input ${plan.displayPlanId}`); for (const segment of plan.segments) { if (segment.type === "raw_input" && segment.inputRecordId !== plan.inputRecordId) fail(`invalid raw input segment ${segment.segmentId}`); if (segment.claimId && !claimIndex.has(segment.claimId)) fail(`dangling claim ${segment.claimId}`); if (segment.voteEventId && eventIndex.get(segment.voteEventId)?.eventType !== "vote_declared") fail(`invalid vote event ${segment.voteEventId}`); if (segment.suspicionEventId && eventIndex.get(segment.suspicionEventId)?.eventType !== "suspicion_expressed") fail(`invalid suspicion event ${segment.suspicionEventId}`); const source = segment.claimId ?? segment.voteEventId ?? segment.suspicionEventId; if (source && !canonicalSpans.has(source)) fail(`missing accepted source span for ${source}`); } }
  return true;
}

export function validatePublicationReferences(publications, { inputRecords = [], displayPlans = [], reactionPlans = [], pendingRendererRequests = [] } = {}) {
  const inputs = uniqueIndex(inputRecords, "inputRecordId", "input record"), plans = uniqueIndex(displayPlans, "displayPlanId", "display plan"), reactions = uniqueIndex(reactionPlans, "reactionPlanId", "reaction plan"), pending = uniqueIndex(pendingRendererRequests, "rendererRequestId", "renderer request"), reservations = uniqueIndex(publications.filter((item) => item.recordType === "npc_publication_reserved"), "reservationId", "reservation");
  for (const record of publications) { if (record.recordType === "player_utterance_published" && (!inputs.has(record.inputRecordId) || plans.get(record.displayPlanId)?.inputRecordId !== record.inputRecordId)) fail(`invalid player publication ${record.publicationId}`); if (record.reactionPlanId) { const plan = reactions.get(record.reactionPlanId); if (!plan || plan.locale !== record.locale) fail(`invalid reaction publication ${record.publicationId}`); } if (record.recordType === "npc_publication_finalized") { const reservation = reservations.get(record.reservationId), request = pending.get(record.source.rendererRequestId); if (!reservation || reservation.publicationId !== record.publicationId || reservation.locale !== record.locale || !request || request.reactionPlanId !== record.reactionPlanId || request.locale !== record.locale) fail(`invalid finalization ${record.finalizationId}`); } }
  return true;
}

export function validateCommitResultReferences(results, { publications = [] } = {}) {
  const publicationIndex = uniqueIndex(publications, "publicationId", "publication");
  for (const result of results) { const publicationId = result.playerPublicationId ?? result.npcPublicationId, publication = publicationIndex.get(publicationId); if (!publication) fail(`dangling commit publication ${publicationId}`); if (result.reservationId && publication.reservationId !== result.reservationId) fail(`invalid commit reservation ${result.reservationId}`); }
  return true;
}

export function validateReferentialIntegrity(graph) {
  validateClaimReferences(graph.claims ?? [], graph);
  validateEventReferences(graph.events ?? [], graph);
  validateReactionPlanReferences(graph.reactionPlans ?? [], graph);
  validateDisplayPlanReferences(graph.displayPlans ?? [], graph);
  validatePublicationReferences(graph.publications ?? [], graph);
  validateCommitResultReferences(graph.commitResults ?? [], graph);
  return true;
}
