import test from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, sha256CanonicalJson } from "../src/conversation/ids.mjs";
import {
  NPC_REACTION_PREPARATION_INVARIANT_CODES,
  NPC_REACTION_PREPARATION_REJECTION_CODES,
  NPC_REACTION_PREPARATION_STAGES,
  NpcReactionPreparationInvariantError,
  prepareNpcReaction
} from "../src/npcReactionPreparation.mjs";

const REQUEST_FINGERPRINT = "a".repeat(64);
const PROJECTION_FINGERPRINT = "4".repeat(64);
const PLAYER_FINGERPRINT = "1".repeat(64);

function baseInput(proposals = [{ proposalType: "suspicion", targetId: "npc-beni" }]) {
  const candidate = { schemaVersion: 1, proposals: structuredClone(proposals) };
  const input = {
    schemaVersion: 1,
    validatedCandidate: {
      schemaVersion: 1,
      binding: {
        gameSessionId: "game-session-1", reactionPlanId: "reaction-plan-1", reactionAttemptId: "reaction-attempt-1",
        requestId: "reaction-request-1", requestFingerprint: REQUEST_FINGERPRINT, correlationId: "correlation-1",
        causationId: "player-request-1", originatingInputRecordId: "input-1", turnId: "turn-1", turnOrder: 1,
        preconditionPhase: "player_question", preconditionStateVersion: 2, npcId: "npc-aoi"
      },
      candidate,
      candidateFingerprint: sha256CanonicalJson(candidate),
      validationContext: {
        projectionFingerprint: PROJECTION_FINGERPRINT, roleDisclosurePolicy: "avoid_unnecessary_claim",
        permissionResult: "allowed", finalApplicabilityResult: "applicable"
      }
    },
    preparationSnapshot: {
      schemaVersion: 1, snapshotType: "npc_reaction_preparation", gameSessionId: "game-session-1", turnId: "turn-1",
      turnOrder: 1, currentPhase: "player_question", currentStateVersion: 2,
      logicalReaction: {
        schemaVersion: 1, gameSessionId: "game-session-1", reactionPlanId: "reaction-plan-1", requestId: "reaction-request-1",
        requestFingerprint: REQUEST_FINGERPRINT, correlationId: "correlation-1", causationId: "player-request-1",
        originatingInputRecordId: "input-1", turnId: "turn-1", turnOrder: 1, preconditionPhase: "player_question",
        preconditionStateVersion: 2, npcId: "npc-aoi", status: "active"
      },
      winningAttempt: { schemaVersion: 1, reactionPlanId: "reaction-plan-1", reactionAttemptId: "reaction-attempt-1", status: "validated" },
      triggeringCommitResult: {
        schemaVersion: 1, requestId: "player-request-1", correlationId: "player-correlation-1", requestFingerprint: PLAYER_FINGERPRINT,
        commitType: "player_conversation", preconditionStateVersion: 1, resultingStateVersion: 2, inputRecordId: "input-1",
        displayPlanId: "display-1", playerPublicationId: "publication-1", createdEventIds: [], createdClaimIds: [], createdAtOrder: 1
      },
      originatingInputRecord: {
        schemaVersion: 1, inputRecordId: "input-1", requestId: "player-request-1", correlationId: "player-correlation-1",
        turnId: "turn-1", capturedStateVersion: 1, actorId: "player", rawText: "Aoiはどう思う？", locale: "ja-JP", createdOrder: 0
      },
      triggeringEvents: [],
      currentRoster: [
        { participantId: "npc-aoi", participantClass: "npc", publicStatus: "alive" },
        { participantId: "npc-beni", participantClass: "npc", publicStatus: "alive" },
        { participantId: "npc-cyan", participantClass: "npc", publicStatus: "alive" },
        { participantId: "npc-dai", participantClass: "npc", publicStatus: "dead" },
        { participantId: "player", participantClass: "player", publicStatus: "alive" }
      ],
      actorApplicability: { schemaVersion: 1, presence: "present", actorId: "npc-aoi", alive: true, maySpeak: true },
      currentAuthorization: { schemaVersion: 1, availability: "available", actorId: "npc-aoi", roleDisclosurePolicy: "avoid_unnecessary_claim", allowedClaimRoles: [], authorizedResultFacts: [] },
      currentTargetIds: [...new Set(proposals.filter((proposal) => Object.hasOwn(proposal, "targetId")).map((proposal) => proposal.targetId))],
      existingClaims: [], existingEvents: [],
      nextOrderEvidence: { nextCreatedOrder: 2, nextPublicationSlotOrder: 1, nextRecordAppendOrder: 1 },
      occupiedArtifactIds: ["game-session-1", "input-1", "publication-1", "reaction-attempt-1", "reaction-plan-1", "reaction-request-1", "turn-1"]
    },
    artifactAllocation: allocationFor(proposals, "case"),
    orderReservation: orderFor(proposals.length)
  };
  authorizeClaims(input);
  return input;
}

function allocationFor(proposals, prefix) {
  return {
    schemaVersion: 1, allocationType: "npc_reaction_artifacts",
    descriptorIds: proposals.map((_, index) => `${prefix}-descriptor-${index + 1}`),
    claimAllocations: proposals.flatMap((proposal, index) => ["role_claim", "result_claim"].includes(proposal.proposalType) ? [{ proposalIndex: index, claimId: `${prefix}-claim-${index + 1}` }] : []),
    eventIds: proposals.map((_, index) => `${prefix}-event-${index + 1}`),
    segmentIds: proposals.map((_, index) => `${prefix}-segment-${index + 1}`), publicationId: `${prefix}-publication`
  };
}

function orderFor(count, nextCreatedOrder = 2, priorClaimCount = 0, priorEventCount = 0) {
  return {
    schemaVersion: 1, reservationType: "npc_reaction_orders", preconditionNextCreatedOrder: nextCreatedOrder,
    eventCreatedOrders: Array.from({ length: count }, (_, index) => nextCreatedOrder + index),
    commitResultCreatedAtOrder: nextCreatedOrder + count, resultingNextCreatedOrder: nextCreatedOrder + count + 1,
    preconditionNextPublicationSlotOrder: 1, publicationSlotOrder: 1, resultingNextPublicationSlotOrder: 2,
    preconditionNextRecordAppendOrder: 1, publicationRecordAppendOrder: 1, resultingNextRecordAppendOrder: 2,
    priorClaimCount, priorEventCount
  };
}

function authorizeClaims(input) {
  const proposals = input.validatedCandidate.candidate.proposals;
  const claimProposals = proposals.filter((proposal) => ["role_claim", "result_claim"].includes(proposal.proposalType));
  if (!claimProposals.length) return;
  input.validatedCandidate.validationContext.roleDisclosurePolicy = "claim_when_directly_asked_after_result";
  input.preparationSnapshot.currentAuthorization.roleDisclosurePolicy = "claim_when_directly_asked_after_result";
  input.preparationSnapshot.currentAuthorization.allowedClaimRoles = ["seer"];
  input.preparationSnapshot.currentAuthorization.authorizedResultFacts = proposals.filter((proposal) => proposal.proposalType === "result_claim").map(({ targetId, result }) => ({ targetId, result }));
  if (input.preparationSnapshot.currentAuthorization.authorizedResultFacts.length === 0) {
    input.preparationSnapshot.currentAuthorization.authorizedResultFacts = [{ targetId: "npc-beni", result: "werewolf" }];
  }
  const event = questionEvent(1);
  input.preparationSnapshot.triggeringEvents = [event];
  input.preparationSnapshot.existingEvents = [structuredClone(event)];
  input.preparationSnapshot.triggeringCommitResult.createdEventIds = [event.eventId];
  input.preparationSnapshot.triggeringCommitResult.createdAtOrder = 2;
  input.preparationSnapshot.nextOrderEvidence.nextCreatedOrder = 3;
  input.orderReservation = orderFor(proposals.length, 3, 0, 1);
}

function mutate(input, change) { const copy = structuredClone(input); change(copy); return copy; }
function advancePrecondition(input, version) {
  input.validatedCandidate.binding.preconditionStateVersion = version;
  input.preparationSnapshot.currentStateVersion = version;
  input.preparationSnapshot.logicalReaction.preconditionStateVersion = version;
  input.preparationSnapshot.triggeringCommitResult.preconditionStateVersion = version - 1;
  input.preparationSnapshot.triggeringCommitResult.resultingStateVersion = version;
  input.preparationSnapshot.originatingInputRecord.capturedStateVersion = version - 1;
}
function assertRejected(input, reasonCode, stage, location) {
  const result = prepareNpcReaction(input);
  assert.equal(result.status, "rejected"); assert.equal(result.rejection.reasonCode, reasonCode); assert.equal(result.rejection.stage, stage);
  assert.deepEqual(result.rejection.diagnostics, [{ code: reasonCode, location }]); assert.equal(result.rejection.retryable, false);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.rejection));
}
function assertInvariant(input, code) { assert.throws(() => prepareNpcReaction(input), (error) => error instanceof NpcReactionPreparationInvariantError && error.name === "NpcReactionPreparationInvariantError" && error.message === "Invalid NPC reaction preparation input." && error.code === code && !Object.hasOwn(error, "cause")); }

test("pure preparation constructs the canonical-only detached frozen graph", () => {
  const input = baseInput(); const before = canonicalJson(input); const result = prepareNpcReaction(input);
  assert.equal(result.status, "prepared"); assert.equal(canonicalJson(input), before);
  const { delta } = result.value;
  assert.equal(delta.plan.renderMode, "canonical_only"); assert.equal(delta.plan.successfulAttemptId, "reaction-attempt-1");
  assert.equal(delta.plan.preconditionStateVersion, 2); assert.equal(delta.plan.resultingStateVersion, 3);
  assert.equal(delta.plan.locale, "ja-JP"); assert.equal(delta.plan.maxChars, 1000); assert.equal(delta.publication.canonicalRendererVersion, 1);
  assert.deepEqual(delta.effects, { suspicionScoreUpdates: [], memoryUpdates: [], legacyPublicHistoryEntries: [], voteStateUpdates: [], phaseTransitions: [] });
  assert.equal(delta.events.length, 1); assert.equal(delta.claims.length, 0); assert.equal(delta.publication.recordType, "npc_canonical_published");
  assert.equal(delta.preparationFingerprint, result.value.preparationFingerprint); assert.equal(delta.idempotencyReservation.preparationFingerprint, result.value.preparationFingerprint);
  assert.match(result.value.preparationFingerprint, /^[a-f0-9]{64}$/); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(delta.plan.canonicalSegments));
  input.validatedCandidate.candidate.proposals[0].targetId = "npc-cyan"; assert.equal(delta.plan.intendedSpeechActs[0].targetId, "npc-beni");
});

test("all four proposal members map in source order with at most four claims", () => {
  const proposals = [
    { proposalType: "role_claim", claimedRole: "seer" },
    { proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" },
    { proposalType: "vote_declaration", targetId: "npc-cyan" },
    { proposalType: "suspicion", targetId: "npc-beni" }
  ];
  const result = prepareNpcReaction(baseInput(proposals)); assert.equal(result.status, "prepared"); const { delta } = result.value;
  assert.deepEqual(delta.plan.intendedSpeechActs.map((item) => item.descriptorType), proposals.map((item) => item.proposalType));
  assert.deepEqual(delta.events.map((item) => item.eventType), ["role_claim_recorded", "result_claim_recorded", "vote_declared", "suspicion_expressed"]);
  assert.deepEqual(delta.plan.canonicalSegments.map((item) => item.type), ["canonical_claim", "canonical_claim", "canonical_vote", "canonical_suspicion"]);
  assert.equal(delta.claims.length, 2); assert.deepEqual(delta.expectedCommitResult.createdClaimIds, delta.claims.map((claim) => claim.claimId));
  assert.deepEqual(delta.plan.policies, { policyType: "reaction_policies", allowStateChanges: true, allowClaims: true, allowVoteDeclaration: true, allowSuspicionUpdate: true, allowMemoryUpdate: false });
  assert.ok(!Object.hasOwn(delta.plan, "requestFingerprint")); assert.ok(!Object.hasOwn(delta.plan, "turnOrder"));
  assert.ok(!Object.hasOwn(delta.expectedCommitResult, "successfulAttemptId"));
});

test("preparation is deterministic, key-order independent, and array-order sensitive", () => {
  const input = baseInput([{ proposalType: "vote_declaration", targetId: "npc-beni" }, { proposalType: "suspicion", targetId: "npc-cyan" }]);
  const first = prepareNpcReaction(input), second = prepareNpcReaction(structuredClone(input)); assert.deepEqual(second, first);
  const reorderedKeys = { orderReservation: input.orderReservation, artifactAllocation: input.artifactAllocation, preparationSnapshot: input.preparationSnapshot, validatedCandidate: input.validatedCandidate, schemaVersion: 1 };
  assert.deepEqual(prepareNpcReaction(reorderedKeys), first);
  const reversed = baseInput([...input.validatedCandidate.candidate.proposals].reverse()); assert.notEqual(prepareNpcReaction(reversed).value.preparationFingerprint, first.value.preparationFingerprint);
  const changedAllocation = structuredClone(input); changedAllocation.artifactAllocation.publicationId = "other-publication"; assert.notEqual(prepareNpcReaction(changedAllocation).value.preparationFingerprint, first.value.preparationFingerprint);
});

test("claim relations use only prior committed same-actor claims", () => {
  const first = prepareNpcReaction(baseInput([{ proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" }])).value.delta.claims[0];
  const repeat = baseInput([{ proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" }]);
  advancePrecondition(repeat, 3); repeat.preparationSnapshot.existingClaims = [first]; repeat.orderReservation.priorClaimCount = 1;
  let claim = prepareNpcReaction(repeat).value.delta.claims[0]; assert.equal(claim.repeatsClaimId, first.claimId); assert.deepEqual(claim.contradictsClaimIds, []);
  const contradiction = baseInput([{ proposalType: "result_claim", targetId: "npc-beni", result: "not_werewolf" }]);
  advancePrecondition(contradiction, 3); contradiction.preparationSnapshot.existingClaims = [first]; contradiction.orderReservation.priorClaimCount = 1;
  claim = prepareNpcReaction(contradiction).value.delta.claims[0]; assert.equal(claim.repeatsClaimId, null); assert.deepEqual(claim.contradictsClaimIds, [first.claimId]);
  const foreign = structuredClone(first); foreign.claimId = "foreign-claim"; foreign.actorId = "npc-cyan";
  const unrelated = baseInput([{ proposalType: "result_claim", targetId: "npc-beni", result: "not_werewolf" }]); advancePrecondition(unrelated, 3); unrelated.preparationSnapshot.existingClaims = [foreign]; unrelated.orderReservation.priorClaimCount = 1;
  assert.deepEqual(prepareNpcReaction(unrelated).value.delta.claims[0].contradictsClaimIds, []);
  const future = structuredClone(first); future.claimId = "future-claim"; future.createdStateVersion = 3;
  const futureIgnored = baseInput([{ proposalType: "result_claim", targetId: "npc-beni", result: "not_werewolf" }]); futureIgnored.preparationSnapshot.existingClaims = [future]; futureIgnored.orderReservation.priorClaimCount = 1;
  assert.deepEqual(prepareNpcReaction(futureIgnored).value.delta.claims[0].contradictsClaimIds, []);
});

test("all closed logical and attempt statuses remain well-shaped and classify in order", () => {
  for (const status of ["planned", "committed", "rejected", "superseded", "cancelled", "exhausted"]) {
    const input = baseInput(); input.preparationSnapshot.logicalReaction.status = status;
    assertRejected(input, "logical_reaction_mismatch", "applicability", "logical_reaction");
  }
  for (const status of ["attempting", "candidate_received", "accepted", "failed", "timed_out", "rejected", "aborted"]) {
    const input = baseInput(); input.preparationSnapshot.winningAttempt.status = status;
    assertRejected(input, "attempt_mismatch", "applicability", "attempt");
  }
});

test("absent, dead, and unable-to-speak actors are closed eligibility rejections", () => {
  const absent = baseInput(); absent.preparationSnapshot.currentRoster = absent.preparationSnapshot.currentRoster.filter((entry) => entry.participantId !== "npc-aoi"); absent.preparationSnapshot.actorApplicability = { schemaVersion: 1, presence: "absent", actorId: "npc-aoi", absenceReason: "removed_from_roster" }; absent.preparationSnapshot.currentAuthorization = { schemaVersion: 1, availability: "unavailable", actorId: "npc-aoi", reason: "actor_absent" };
  assertRejected(absent, "actor_ineligible", "authorization", "actor");
  const dead = baseInput(); dead.preparationSnapshot.currentRoster.find((entry) => entry.participantId === "npc-aoi").publicStatus = "dead"; dead.preparationSnapshot.actorApplicability.alive = false;
  assertRejected(dead, "actor_ineligible", "authorization", "actor");
  const unable = baseInput(); unable.preparationSnapshot.actorApplicability.maySpeak = false;
  assertRejected(unable, "actor_ineligible", "authorization", "actor");
});

test("dead-but-rostered result targets remain eligible while dead action targets reject", () => {
  const resultClaim = baseInput([{ proposalType: "result_claim", targetId: "npc-dai", result: "not_werewolf" }]);
  assert.equal(prepareNpcReaction(resultClaim).status, "prepared");
  const suspicion = baseInput([{ proposalType: "suspicion", targetId: "npc-dai" }]);
  assertRejected(suspicion, "target_ineligible", "authorization", "target");
});

test("closed rejection codes have reachable first-failure vectors", () => {
  const vectors = [
    ["stale_validated_binding", "binding", "validated_candidate", (i) => { i.validatedCandidate.binding.requestId = "other-request"; }],
    ["stale_session", "applicability", "session", (i) => { i.validatedCandidate.binding.gameSessionId = "other-session"; }],
    ["stale_turn", "applicability", "turn", (i) => { i.validatedCandidate.binding.turnOrder = 2; }],
    ["stale_phase", "applicability", "phase", (i) => { i.preparationSnapshot.currentPhase = "day_discussion"; }],
    ["stale_state_version", "applicability", "state_version", (i) => { i.preparationSnapshot.currentStateVersion = 3; }],
    ["logical_reaction_mismatch", "applicability", "logical_reaction", (i) => { i.preparationSnapshot.logicalReaction.status = "planned"; }],
    ["attempt_mismatch", "applicability", "attempt", (i) => { i.preparationSnapshot.winningAttempt.status = "candidate_received"; }],
    ["actor_ineligible", "authorization", "actor", (i) => { i.preparationSnapshot.currentRoster = i.preparationSnapshot.currentRoster.filter((entry) => entry.participantId !== "npc-aoi"); i.preparationSnapshot.actorApplicability = { schemaVersion: 1, presence: "absent", actorId: "npc-aoi", absenceReason: "removed_from_roster" }; i.preparationSnapshot.currentAuthorization = { schemaVersion: 1, availability: "unavailable", actorId: "npc-aoi", reason: "actor_absent" }; }],
    ["target_ineligible", "authorization", "target", (i) => { i.preparationSnapshot.currentTargetIds = []; }],
    ["permission_denied", "authorization", "policy", (i) => { i.validatedCandidate = baseInput([{ proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" }]).validatedCandidate; i.artifactAllocation = allocationFor(i.validatedCandidate.candidate.proposals, "permission"); i.preparationSnapshot.currentAuthorization = { schemaVersion: 1, availability: "available", actorId: "npc-aoi", roleDisclosurePolicy: "avoid_unnecessary_claim", allowedClaimRoles: [], authorizedResultFacts: [] }; }],
    ["result_fact_mismatch", "authorization", "known_information", (i) => { const fresh = baseInput([{ proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" }]); Object.assign(i, fresh); i.preparationSnapshot.currentAuthorization.authorizedResultFacts = [{ targetId: "npc-beni", result: "not_werewolf" }]; }],
    ["artifact_id_collision", "allocation", "artifact_allocation", (i) => { i.preparationSnapshot.occupiedArtifactIds = [...i.preparationSnapshot.occupiedArtifactIds, i.artifactAllocation.publicationId].sort(); }]
  ];
  for (const [code, stage, location, change] of vectors) { const input = baseInput(); change(input); assertRejected(input, code, stage, location); }
});

test("invalid current references reject without exposing the record", () => {
  const input = baseInput(); const event = questionEvent(1); input.preparationSnapshot.triggeringEvents = [event]; input.preparationSnapshot.triggeringCommitResult.createdEventIds = [event.eventId];
  assertRejected(input, "invalid_reference", "authorization", "reference");
});

test("state, order, and causation exhaustion use closed rejections", () => {
  const state = baseInput(); const max = Number.MAX_SAFE_INTEGER; state.validatedCandidate.binding.preconditionStateVersion = max; state.preparationSnapshot.currentStateVersion = max; state.preparationSnapshot.logicalReaction.preconditionStateVersion = max; state.preparationSnapshot.triggeringCommitResult.preconditionStateVersion = max - 1; state.preparationSnapshot.triggeringCommitResult.resultingStateVersion = max; state.preparationSnapshot.originatingInputRecord.capturedStateVersion = max - 1;
  assertRejected(state, "state_version_exhausted", "ordering", "state_version");
  const order = baseInput(); order.preparationSnapshot.nextOrderEvidence.nextCreatedOrder = max; order.orderReservation.preconditionNextCreatedOrder = max; order.orderReservation.eventCreatedOrders = [max]; order.orderReservation.commitResultCreatedAtOrder = max; order.orderReservation.resultingNextCreatedOrder = max;
  assertRejected(order, "order_exhausted", "ordering", "order_reservation");
  const overflow = baseInput(); const events = Array.from({ length: 17 }, (_, index) => questionEvent(index + 1)); overflow.preparationSnapshot.triggeringEvents = events; overflow.preparationSnapshot.existingEvents = structuredClone(events); overflow.preparationSnapshot.triggeringCommitResult.createdEventIds = events.map((event) => event.eventId); overflow.preparationSnapshot.triggeringCommitResult.createdAtOrder = 18; overflow.preparationSnapshot.nextOrderEvidence.nextCreatedOrder = 19; overflow.orderReservation = orderFor(1, 19, 0, 17);
  assertRejected(overflow, "causation_event_overflow", "construction", "causation_events");
});

test("malformed engine-owned inputs throw each active invariant category", () => {
  const vectors = [
    ["invalid_preparation_input", (i) => { i.extra = true; }],
    ["unsupported_preparation_schema", (i) => { i.schemaVersion = 2; }],
    ["invalid_validated_candidate", (i) => { i.validatedCandidate.extra = true; }],
    ["invalid_snapshot", (i) => { i.preparationSnapshot.extra = true; }],
    ["contradictory_snapshot", (i) => { i.preparationSnapshot.actorApplicability.actorId = "npc-beni"; }],
    ["invalid_artifact_allocation", (i) => { i.artifactAllocation.descriptorIds = []; }],
    ["invalid_order_reservation", (i) => { delete i.orderReservation.publicationSlotOrder; }],
    ["duplicate_engine_id", (i) => { i.artifactAllocation.eventIds[0] = i.artifactAllocation.descriptorIds[0]; }]
  ];
  for (const [code, change] of vectors) { const input = baseInput(); change(input); assertInvariant(input, code); }
  const committed = baseInput([{ proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" }]); const claim = prepareNpcReaction(committed).value.delta.claims[0]; committed.preparationSnapshot.existingClaims = [claim, structuredClone(claim)]; committed.orderReservation.priorClaimCount = 2; assertInvariant(committed, "invalid_committed_graph_projection");
  const fingerprintError = new NpcReactionPreparationInvariantError("preparation_fingerprint_failure"); assert.equal(fingerprintError.code, "preparation_fingerprint_failure"); assert.equal(Object.keys(fingerprintError).sort().join(","), "code,name");
});

test("closed constants are exact, immutable, and no provider or state API is exported", () => {
  assert.deepEqual(NPC_REACTION_PREPARATION_REJECTION_CODES, ["stale_validated_binding", "stale_session", "stale_turn", "stale_phase", "stale_state_version", "logical_reaction_mismatch", "attempt_mismatch", "actor_ineligible", "target_ineligible", "invalid_reference", "permission_denied", "result_fact_mismatch", "state_version_exhausted", "order_exhausted", "artifact_id_collision", "causation_event_overflow"]);
  assert.deepEqual(NPC_REACTION_PREPARATION_STAGES, ["binding", "applicability", "authorization", "allocation", "ordering", "construction"]);
  assert.equal(NPC_REACTION_PREPARATION_INVARIANT_CODES.length, 10); assert.ok(Object.isFrozen(NPC_REACTION_PREPARATION_REJECTION_CODES));
});

function questionEvent(index) {
  return {
    schemaVersion: 1, eventId: `question-event-${index}`, requestId: "player-request-1", turnId: "turn-1", actorId: "player",
    causationId: "input-1", correlationId: "player-correlation-1", idempotencyKey: index.toString(16).padStart(64, "0"),
    source: { sourceType: "player_accepted_act", acceptedSpeechActId: `act-${index}`, inputRecordId: "input-1", requestId: "player-request-1" },
    stateVersion: 2, occurredPhase: "day_discussion", createdOrder: index, eventType: "public_question_recorded", targetId: "npc-aoi", topic: "result"
  };
}
