import { sha256CanonicalJson } from "../../src/conversation/ids.mjs";
import {
  createNpcReactionAttempt,
  createNpcReactionCoordinatorRoot,
  createPlannedNpcReaction,
  observeNpcReactionCandidate,
  receiveNpcReactionCandidate
} from "../../src/npcReactionCoordinator.mjs";
import { prepareNpcReaction } from "../../src/npcReactionPreparation.mjs";

const REQUEST_FP = "a".repeat(64);
const PROJECTION_FP = "b".repeat(64);
const PLAYER_FP = "c".repeat(64);

export function createAuthorityTranslationFixture(
  proposals = [{ proposalType: "suspicion", targetId: "npc-beni" }]
) {
  const preparationInput = preparationFixture(proposals);
  const preparedResult = prepareNpcReaction(preparationInput);
  if (preparedResult.status !== "prepared") throw new Error("fixture preparation failed");
  const preparedReaction = structuredClone(preparedResult.value);
  const currentState = commitStateFixture(preparationInput);
  const gameState = gameStateFixture(currentState);
  return {
    gameState,
    preparedReaction,
    preCommitReferenceContext: {
      schemaVersion: 1,
      contextType: "pre_commit",
      preparationBinding: structuredClone(preparedReaction.delta.binding),
      commitDelta: structuredClone(preparedReaction.delta),
      validatedCandidateBinding: structuredClone(preparationInput.validatedCandidate.binding)
    },
    coordinatorRoot: structuredClone(coordinatorFixture(preparationInput)),
    liveValidationContext: liveFixture(preparationInput)
  };
}

export function commitInputFromProjection(fixture, currentProjection) {
  return {
    schemaVersion: 1,
    currentState: structuredClone(currentProjection),
    preparedReaction: structuredClone(fixture.preparedReaction),
    preCommitReferenceContext: structuredClone(fixture.preCommitReferenceContext),
    coordinatorRoot: structuredClone(fixture.coordinatorRoot),
    liveValidationContext: structuredClone(fixture.liveValidationContext)
  };
}

export function refreshPreparedReaction(preparedReaction) {
  const delta = preparedReaction.delta;
  delta.preparationFingerprint = "0".repeat(64);
  delta.idempotencyReservation.preparationFingerprint = "0".repeat(64);
  const fingerprint = sha256CanonicalJson(delta);
  delta.preparationFingerprint = fingerprint;
  delta.idempotencyReservation.preparationFingerprint = fingerprint;
  preparedReaction.preparationFingerprint = fingerprint;
  return preparedReaction;
}

function preparationFixture(proposals) {
  const candidate = { schemaVersion: 1, proposals: structuredClone(proposals) };
  const playerResult = {
    schemaVersion: 1,
    requestId: "player-request-1",
    correlationId: "player-correlation-1",
    requestFingerprint: PLAYER_FP,
    commitType: "player_conversation",
    preconditionStateVersion: 1,
    resultingStateVersion: 2,
    inputRecordId: "input-1",
    displayPlanId: "display-1",
    playerPublicationId: "publication-1",
    createdEventIds: [],
    createdClaimIds: [],
    createdAtOrder: 1
  };
  const input = {
    schemaVersion: 1,
    validatedCandidate: {
      schemaVersion: 1,
      binding: {
        gameSessionId: "game-session-1",
        reactionPlanId: "reaction-plan-1",
        reactionAttemptId: "reaction-attempt-1",
        requestId: "reaction-request-1",
        requestFingerprint: REQUEST_FP,
        correlationId: "player-correlation-1",
        causationId: "player-request-1",
        originatingInputRecordId: "input-1",
        turnId: "turn-1",
        turnOrder: 1,
        preconditionPhase: "player_question",
        preconditionStateVersion: 2,
        npcId: "npc-aoi"
      },
      candidate,
      candidateFingerprint: sha256CanonicalJson(candidate),
      validationContext: {
        projectionFingerprint: PROJECTION_FP,
        roleDisclosurePolicy: proposals.some((proposal) =>
          ["role_claim", "result_claim"].includes(proposal.proposalType))
          ? "claim_when_directly_asked_after_result"
          : "avoid_unnecessary_claim",
        permissionResult: "allowed",
        finalApplicabilityResult: "applicable"
      }
    },
    preparationSnapshot: {
      schemaVersion: 1,
      snapshotType: "npc_reaction_preparation",
      gameSessionId: "game-session-1",
      turnId: "turn-1",
      turnOrder: 1,
      currentPhase: "player_question",
      currentStateVersion: 2,
      logicalReaction: {
        schemaVersion: 1,
        gameSessionId: "game-session-1",
        reactionPlanId: "reaction-plan-1",
        requestId: "reaction-request-1",
        requestFingerprint: REQUEST_FP,
        correlationId: "player-correlation-1",
        causationId: "player-request-1",
        originatingInputRecordId: "input-1",
        turnId: "turn-1",
        turnOrder: 1,
        preconditionPhase: "player_question",
        preconditionStateVersion: 2,
        npcId: "npc-aoi",
        status: "active"
      },
      winningAttempt: {
        schemaVersion: 1,
        reactionPlanId: "reaction-plan-1",
        reactionAttemptId: "reaction-attempt-1",
        status: "validated"
      },
      triggeringCommitResult: playerResult,
      originatingInputRecord: {
        schemaVersion: 1,
        inputRecordId: "input-1",
        requestId: "player-request-1",
        correlationId: "player-correlation-1",
        turnId: "turn-1",
        capturedStateVersion: 1,
        actorId: "player",
        rawText: "Question?",
        locale: "ja-JP",
        createdOrder: 0
      },
      triggeringEvents: [],
      currentRoster: [
        { participantId: "npc-aoi", participantClass: "npc", publicStatus: "alive" },
        { participantId: "npc-beni", participantClass: "npc", publicStatus: "alive" },
        { participantId: "player", participantClass: "player", publicStatus: "alive" }
      ],
      actorApplicability: {
        schemaVersion: 1,
        presence: "present",
        actorId: "npc-aoi",
        alive: true,
        maySpeak: true
      },
      currentAuthorization: {
        schemaVersion: 1,
        availability: "available",
        actorId: "npc-aoi",
        roleDisclosurePolicy: "avoid_unnecessary_claim",
        allowedClaimRoles: [],
        authorizedResultFacts: []
      },
      currentTargetIds: ["npc-beni"],
      existingClaims: [],
      existingEvents: [],
      nextOrderEvidence: {
        nextCreatedOrder: 2,
        nextPublicationSlotOrder: 1,
        nextRecordAppendOrder: 1
      },
      occupiedArtifactIds: [
        "game-session-1", "input-1", "publication-1", "reaction-attempt-1",
        "reaction-plan-1", "reaction-request-1", "turn-1"
      ]
    },
    artifactAllocation: {
      schemaVersion: 1,
      allocationType: "npc_reaction_artifacts",
      descriptorIds: proposals.map((_, index) => `case-descriptor-${index + 1}`),
      claimAllocations: proposals.flatMap((proposal, index) =>
        ["role_claim", "result_claim"].includes(proposal.proposalType)
          ? [{ proposalIndex: index, claimId: `case-claim-${index + 1}` }]
          : []),
      eventIds: proposals.map((_, index) => `case-event-${index + 1}`),
      segmentIds: proposals.map((_, index) => `case-segment-${index + 1}`),
      publicationId: "case-publication"
    },
    orderReservation: {
      schemaVersion: 1,
      reservationType: "npc_reaction_orders",
      preconditionNextCreatedOrder: 2,
      eventCreatedOrders: proposals.map((_, index) => 2 + index),
      commitResultCreatedAtOrder: 2 + proposals.length,
      resultingNextCreatedOrder: 3 + proposals.length,
      preconditionNextPublicationSlotOrder: 1,
      publicationSlotOrder: 1,
      resultingNextPublicationSlotOrder: 2,
      preconditionNextRecordAppendOrder: 1,
      publicationRecordAppendOrder: 1,
      resultingNextRecordAppendOrder: 2,
      priorClaimCount: 0,
      priorEventCount: 0
    }
  };
  if (proposals.some((proposal) => ["role_claim", "result_claim"].includes(proposal.proposalType))) {
    input.validatedCandidate.validationContext.roleDisclosurePolicy = "claim_when_directly_asked_after_result";
    input.preparationSnapshot.currentAuthorization.roleDisclosurePolicy = "claim_when_directly_asked_after_result";
    input.preparationSnapshot.currentAuthorization.allowedClaimRoles = ["seer"];
    input.preparationSnapshot.currentAuthorization.authorizedResultFacts = proposals
      .filter((proposal) => proposal.proposalType === "result_claim")
      .map(({ targetId, result }) => ({ targetId, result }));
    if (input.preparationSnapshot.currentAuthorization.authorizedResultFacts.length === 0) {
      input.preparationSnapshot.currentAuthorization.authorizedResultFacts = [
        { targetId: "npc-beni", result: "werewolf" }
      ];
    }
    const event = questionEvent();
    input.preparationSnapshot.triggeringEvents = [event];
    input.preparationSnapshot.existingEvents = [structuredClone(event)];
    input.preparationSnapshot.triggeringCommitResult.createdEventIds = [event.eventId];
    input.preparationSnapshot.triggeringCommitResult.createdAtOrder = 2;
    input.preparationSnapshot.nextOrderEvidence.nextCreatedOrder = 3;
    input.orderReservation.preconditionNextCreatedOrder = 3;
    input.orderReservation.eventCreatedOrders = proposals.map((_, index) => 3 + index);
    input.orderReservation.commitResultCreatedAtOrder = 3 + proposals.length;
    input.orderReservation.resultingNextCreatedOrder = 4 + proposals.length;
    input.orderReservation.priorEventCount = 1;
  }
  return input;
}

function commitStateFixture(preparationInput) {
  const snapshot = preparationInput.preparationSnapshot;
  const input = structuredClone(snapshot.originatingInputRecord);
  const rawLength = [...input.rawText].length;
  const accepted = {
    schemaVersion: 1,
    speechActId: "accepted-info-1",
    requestId: input.requestId,
    acceptedTurnId: input.turnId,
    acceptedStateVersion: input.capturedStateVersion,
    acceptedPhase: "player_question",
    inputRecordId: input.inputRecordId,
    actorId: "player",
    causationId: "player-cause-1",
    correlationId: input.correlationId,
    idempotencyKey: "player-idempotency-1",
    sourceSpan: { start: 0, end: rawLength },
    ...(snapshot.existingEvents.length
      ? { type: "accepted_question", targetId: "npc-aoi", topic: "role" }
      : { type: "accepted_information_request", topic: "rules" })
  };
  const displayPlan = {
    schemaVersion: 1,
    displayPlanId: "display-1",
    inputRecordId: input.inputRecordId,
    turnId: input.turnId,
    stateVersion: 2,
    segments: [{
      segmentId: "player-raw-1",
      type: "raw_input",
      inputRecordId: input.inputRecordId,
      sourceSpan: { start: 0, end: rawLength }
    }]
  };
  const playerPublication = {
    schemaVersion: 1,
    recordType: "player_utterance_published",
    publicationId: "publication-1",
    requestId: input.requestId,
    correlationId: input.correlationId,
    turnId: input.turnId,
    gameStateVersion: 2,
    occurredPhase: "player_question",
    actorId: "player",
    inputRecordId: input.inputRecordId,
    displayPlanId: displayPlan.displayPlanId,
    idempotencyKey: "player-publication-idempotency-1",
    publicationSlotOrder: 0,
    recordAppendOrder: 0
  };
  return {
    gameSessionId: "game-session-1",
    turnId: "turn-1",
    turnOrder: 1,
    phase: "player_question",
    stateVersion: 2,
    players: [
      { participantId: "player", participantClass: "player", alive: true, maySpeak: true },
      { participantId: "npc-aoi", participantClass: "npc", alive: true, maySpeak: true },
      { participantId: "npc-beni", participantClass: "npc", alive: true, maySpeak: true }
    ],
    conversation: {
      inputRecords: [input],
      acceptedSpeechActs: [accepted],
      claims: [],
      events: structuredClone(snapshot.existingEvents),
      displayPlans: [displayPlan],
      reactionPlans: [],
      publications: [playerPublication],
      commitResults: [structuredClone(snapshot.triggeringCommitResult)],
      npcReactionCommitIdempotencyRecords: [],
      nextCreatedOrder: snapshot.nextOrderEvidence.nextCreatedOrder,
      nextPublicationSlotOrder: 1,
      nextRecordAppendOrder: 1
    }
  };
}

function gameStateFixture(currentState) {
  return {
    gameSessionId: currentState.gameSessionId,
    turnId: currentState.turnId,
    turnOrder: currentState.turnOrder,
    stateVersion: currentState.stateVersion,
    day: 1,
    phase: currentState.phase,
    players: [
      storedPlayer("npc-aoi", "Aoi"),
      storedPlayer("npc-beni", "Beni")
    ],
    alivePlayers: ["npc-aoi", "npc-beni"],
    deadPlayers: [],
    publicInfo: [],
    voteHistory: [],
    winner: null,
    playerLog: [],
    developerLog: [],
    conversation: {
      inputRecords: structuredClone(currentState.conversation.inputRecords),
      acceptedSpeechActs: structuredClone(currentState.conversation.acceptedSpeechActs),
      claims: structuredClone(currentState.conversation.claims),
      events: structuredClone(currentState.conversation.events),
      displayPlans: structuredClone(currentState.conversation.displayPlans),
      reactionPlans: structuredClone(currentState.conversation.reactionPlans),
      publications: structuredClone(currentState.conversation.publications),
      playerLegacyDisplayCompatibilityRecords: [],
      commitResults: structuredClone(currentState.conversation.commitResults),
      idempotencyRecords: [],
      npcReactionCommitIdempotencyRecords: structuredClone(
        currentState.conversation.npcReactionCommitIdempotencyRecords
      ),
      nextCreatedOrder: currentState.conversation.nextCreatedOrder,
      nextPublicationSlotOrder: currentState.conversation.nextPublicationSlotOrder,
      nextRecordAppendOrder: currentState.conversation.nextRecordAppendOrder
    },
    rng: { state: 1 },
    config: {}
  };
}

function storedPlayer(id, name) {
  return {
    id,
    name,
    aliases: [],
    personality: "private-personality",
    speechStyle: "private-style",
    role: "citizen",
    team: "village",
    alive: true,
    knownInfo: [],
    hiddenInfo: [],
    suspicionScores: {},
    publicClaims: [],
    privateMemory: [],
    voteHistory: [],
    conversationPolicy: { private: true }
  };
}

function coordinatorFixture(preparationInput) {
  const binding = preparationInput.validatedCandidate.binding;
  const logical = {
    schemaVersion: 1,
    gameSessionId: binding.gameSessionId,
    reactionPlanId: binding.reactionPlanId,
    requestId: binding.requestId,
    requestFingerprint: binding.requestFingerprint,
    correlationId: binding.correlationId,
    causationId: binding.causationId,
    originatingInputRecordId: binding.originatingInputRecordId,
    turnId: binding.turnId,
    turnOrder: binding.turnOrder,
    preconditionPhase: binding.preconditionPhase,
    preconditionStateVersion: binding.preconditionStateVersion,
    npcId: binding.npcId,
    routeSnapshot: { schemaVersion: 1, route: "structured" },
    projectionFingerprint: PROJECTION_FP,
    status: "planned",
    attemptIds: [],
    createdAt: "2026-07-16T00:00:00Z",
    retryPolicy: {
      schemaVersion: 1,
      maxAttempts: 3,
      backoffDelaysMs: [1000, 2000],
      logicalDeadlineMs: 15000
    }
  };
  let root = createPlannedNpcReaction(createNpcReactionCoordinatorRoot(binding.gameSessionId), {
    gameSessionId: binding.gameSessionId,
    logicalReaction: logical
  }).root;
  root = createNpcReactionAttempt(root, {
    gameSessionId: binding.gameSessionId,
    attempt: {
      schemaVersion: 1,
      pendingType: "npc_reaction",
      gameSessionId: binding.gameSessionId,
      requestId: binding.requestId,
      requestFingerprint: binding.requestFingerprint,
      correlationId: binding.correlationId,
      causationId: binding.causationId,
      reactionPlanId: binding.reactionPlanId,
      reactionAttemptId: binding.reactionAttemptId,
      originatingInputRecordId: binding.originatingInputRecordId,
      turnId: binding.turnId,
      turnOrder: binding.turnOrder,
      preconditionStateVersion: binding.preconditionStateVersion,
      preconditionPhase: binding.preconditionPhase,
      targetNpcId: binding.npcId,
      operation: "generate_npc_reaction_candidate",
      status: "attempting",
      candidateFingerprint: null,
      startedAt: "2026-07-16T00:00:01Z"
    }
  }).root;
  root = receiveNpcReactionCandidate(root, {
    gameSessionId: binding.gameSessionId,
    reactionPlanId: binding.reactionPlanId,
    reactionAttemptId: binding.reactionAttemptId
  }).root;
  return observeNpcReactionCandidate(root, {
    gameSessionId: binding.gameSessionId,
    reactionPlanId: binding.reactionPlanId,
    reactionAttemptId: binding.reactionAttemptId,
    candidateFingerprint: preparationInput.validatedCandidate.candidateFingerprint
  }).root;
}

function liveFixture(preparationInput) {
  const snapshot = preparationInput.preparationSnapshot;
  return {
    schemaVersion: 1,
    contextType: "npc_reaction_commit_live",
    gameSessionId: snapshot.gameSessionId,
    turnId: snapshot.turnId,
    turnOrder: snapshot.turnOrder,
    currentPhase: snapshot.currentPhase,
    currentStateVersion: snapshot.currentStateVersion,
    actorApplicability: structuredClone(snapshot.actorApplicability),
    currentAuthorization: structuredClone(snapshot.currentAuthorization),
    currentTargetIds: structuredClone(snapshot.currentTargetIds)
  };
}

function questionEvent() {
  return {
    schemaVersion: 1,
    eventId: "question-event-1",
    requestId: "player-request-1",
    turnId: "turn-1",
    actorId: "player",
    causationId: "player-cause-1",
    correlationId: "player-correlation-1",
    idempotencyKey: "question-event-key-1",
    source: {
      sourceType: "player_accepted_act",
      acceptedSpeechActId: "accepted-info-1",
      inputRecordId: "input-1",
      requestId: "player-request-1"
    },
    stateVersion: 2,
    occurredPhase: "player_question",
    createdOrder: 1,
    eventType: "public_question_recorded",
    targetId: "npc-aoi",
    topic: "role"
  };
}
