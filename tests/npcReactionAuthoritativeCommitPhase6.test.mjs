import test from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, sha256CanonicalJson } from "../src/conversation/ids.mjs";
import {
  NPC_REACTION_COMMIT_INVARIANT_CODES,
  NPC_REACTION_COMMIT_REJECTION_CODES,
  NpcReactionCommitInvariantError,
  commitNpcReactionAuthoritatively
} from "../src/npcReactionAuthoritativeCommit.mjs";
import {
  createNpcReactionAttempt,
  createNpcReactionCoordinatorRoot,
  createPlannedNpcReaction,
  observeNpcReactionCandidate,
  receiveNpcReactionCandidate
} from "../src/npcReactionCoordinator.mjs";
import { prepareNpcReaction } from "../src/npcReactionPreparation.mjs";

const REQUEST_FP = "a".repeat(64);
const PROJECTION_FP = "b".repeat(64);
const PLAYER_FP = "c".repeat(64);

test("non-routing authoritative commit atomically installs one complete canonical graph", () => {
  const input = commitInput();
  const before = canonicalJson(input.currentState);
  const result = commitNpcReactionAuthoritatively(input);
  assert.equal(result.status, "committed");
  assert.equal(canonicalJson(input.currentState), before);
  assert.equal(result.replacementState.stateVersion, 3);
  assert.equal(result.replacementState.phase, "player_question");
  assert.equal(result.replacementState.conversation.reactionPlans.length, 1);
  assert.equal(result.replacementState.conversation.claims.length, 0);
  assert.equal(result.replacementState.conversation.events.length, 1);
  assert.equal(result.replacementState.conversation.publications.length, 2);
  assert.equal(result.replacementState.conversation.commitResults.length, 2);
  assert.equal(result.replacementState.conversation.npcReactionCommitIdempotencyRecords.length, 1);
  assert.equal(result.replacementState.conversation.nextCreatedOrder, 4);
  assert.equal(result.replacementState.conversation.nextPublicationSlotOrder, 2);
  assert.equal(result.replacementState.conversation.nextRecordAppendOrder, 2);
  const record = result.replacementState.conversation.npcReactionCommitIdempotencyRecords[0];
  assert.equal(record.successfulAttemptId, "reaction-attempt-1");
  assert.equal(record.turnOrder, 1);
  assert.ok(!Object.hasOwn(result.result, "successfulAttemptId"));
  assert.ok(!Object.hasOwn(result.result, "turnOrder"));
  assert.ok(!Object.hasOwn(result.replacementState.conversation.reactionPlans[0], "turnOrder"));
  assert.deepEqual(result.coordinatorCleanupHandoff, {
    schemaVersion: 1,
    gameSessionId: "game-session-1",
    reactionPlanId: "reaction-plan-1",
    successfulAttemptId: "reaction-attempt-1",
    preparationFingerprint: input.preparedReaction.preparationFingerprint,
    npcPublicationId: "case-publication",
    commitResultRequestId: "reaction-request-1"
  });
});

test("replacement state is fully detached and deterministic", () => {
  const firstInput = commitInput();
  const secondInput = commitInput();
  const first = commitNpcReactionAuthoritatively(firstInput);
  const second = commitNpcReactionAuthoritatively(secondInput);
  assert.deepEqual(first, second);
  firstInput.currentState.players[0].alive = false;
  assert.equal(first.replacementState.players[0].alive, true);
  assert.notEqual(first.replacementState, firstInput.currentState);
  assert.notEqual(first.replacementState.conversation, firstInput.currentState.conversation);
  assert.notEqual(first.replacementState.conversation.events, firstInput.currentState.conversation.events);
});

test("exact retry returns stored result without a second mutation", () => {
  const first = commitNpcReactionAuthoritatively(commitInput());
  const retry = commitInput();
  retry.currentState = structuredClone(first.replacementState);
  retry.liveValidationContext.currentStateVersion = retry.currentState.stateVersion;
  const replay = commitNpcReactionAuthoritatively(retry);
  assert.equal(replay.status, "replayed");
  assert.deepEqual(replay.result, first.result);
  assert.ok(!Object.hasOwn(replay, "replacementState"));
  assert.equal(retry.currentState.conversation.reactionPlans.length, 1);
  assert.equal(retry.currentState.conversation.publications.length, 2);
});

test("conflicting retry evidence rejects before stale applicability", () => {
  const firstInput = commitInput();
  const first = commitNpcReactionAuthoritatively(firstInput);
  for (const change of [
    (input) => {
      input.preparedReaction.delta.candidateFingerprint = "d".repeat(64);
      refreshPrepared(input);
    },
    (input) => {
      const delta = input.preparedReaction.delta;
      delta.binding.requestFingerprint = "d".repeat(64);
      delta.requestFingerprint = "d".repeat(64);
      delta.expectedCommitResult.requestFingerprint = "d".repeat(64);
      delta.idempotencyReservation.requestFingerprint = "d".repeat(64);
      input.preCommitReferenceContext.validatedCandidateBinding.requestFingerprint = "d".repeat(64);
      refreshPrepared(input);
    }
  ]) {
    const retry = commitInput();
    retry.currentState = structuredClone(first.replacementState);
    change(retry);
    const result = commitNpcReactionAuthoritatively(retry);
    assert.equal(result.rejection.reasonCode, "idempotency_conflict");
    assert.equal(canonicalJson(retry.currentState), canonicalJson(first.replacementState));
  }
});

test("strict input and prepared fingerprint failures are invariant and mutation-free", () => {
  const vectors = [
    [mutate(commitInput(), (input) => { delete input.liveValidationContext; }), "invalid_commit_input"],
    [mutate(commitInput(), (input) => { input.unknown = true; }), "invalid_commit_input"],
    [mutate(commitInput(), (input) => { input.schemaVersion = 2; }), "unsupported_commit_schema"],
    [mutate(commitInput(), (input) => { input.preparedReaction.preparationFingerprint = "d".repeat(64); }), "preparation_fingerprint_mismatch"],
    [mutate(commitInput(), (input) => { input.preparedReaction.delta.plan.turnOrder = 1; }), "invalid_prepared_reaction"]
  ];
  for (const [input, code] of vectors) {
    const before = canonicalJson(input.currentState);
    assert.throws(() => commitNpcReactionAuthoritatively(input), invariant(code));
    assert.equal(canonicalJson(input.currentState), before);
  }
});

test("version contract accepts only exact N to N plus one", () => {
  for (const [change, code] of [
    [(input) => { input.currentState.stateVersion = 3; input.liveValidationContext.currentStateVersion = 3; }, "stale_state_version"],
    [(input) => { input.preparedReaction.delta.plan.preconditionStateVersion = 1; }, "invalid_prepared_reaction"],
    [(input) => { input.preparedReaction.delta.resultingStateVersion = 4; }, "invalid_commit_delta"],
    [(input) => { input.currentState.stateVersion = Number.MAX_SAFE_INTEGER; input.liveValidationContext.currentStateVersion = Number.MAX_SAFE_INTEGER; }, "stale_state_version"]
  ]) {
    const input = commitInput();
    change(input);
    const outcome = safeCommit(input);
    if (outcome instanceof NpcReactionCommitInvariantError) assert.equal(outcome.code, code);
    else assert.equal(outcome.rejection.reasonCode, code);
    assert.equal(input.currentState.conversation.reactionPlans.length, 0);
  }
  const exhausted = commitInput();
  advancePreparedVersion(exhausted, Number.MAX_SAFE_INTEGER);
  exhausted.currentState.stateVersion = Number.MAX_SAFE_INTEGER;
  exhausted.liveValidationContext.currentStateVersion = Number.MAX_SAFE_INTEGER;
  const result = safeCommit(exhausted);
  assert.ok(result instanceof NpcReactionCommitInvariantError
    || result.rejection.reasonCode === "state_version_exhausted");
});

test("successful-attempt ownership rejects unknown, stale, foreign, and wrong fingerprint evidence", () => {
  const vectors = [
    ["logical_reaction_mismatch", (input) => {
      input.coordinatorRoot = {
        schemaVersion: 1, gameSessionId: "game-session-1", nextTerminalOrder: 0,
        logicalReactions: {}, reactionAttempts: {},
        terminalSlotReservations: {}, reactionTombstones: {}
      };
    }],
    ["attempt_mismatch", (input) => {
      input.coordinatorRoot.reactionAttempts["reaction-attempt-1"].status = "rejected";
    }],
    ["attempt_mismatch", (input) => {
      const attempt = input.coordinatorRoot.reactionAttempts["reaction-attempt-1"];
      delete input.coordinatorRoot.reactionAttempts["reaction-attempt-1"];
      attempt.reactionAttemptId = "reaction-attempt-2";
      input.coordinatorRoot.reactionAttempts["reaction-attempt-2"] = attempt;
      input.coordinatorRoot.logicalReactions["reaction-plan-1"].attemptIds = ["reaction-attempt-2"];
    }],
    ["attempt_mismatch", (input) => {
      input.coordinatorRoot.reactionAttempts["reaction-attempt-1"].candidateFingerprint = "d".repeat(64);
    }]
  ];
  for (const [code, change] of vectors) {
    const input = commitInput();
    change(input);
    const result = safeCommit(input);
    assert.equal(result instanceof NpcReactionCommitInvariantError, false, result.code);
    assert.equal(result.rejection.reasonCode, code);
    assert.equal(input.currentState.stateVersion, 2);
  }
});

test("final live session, turn, phase, target, reference, policy and facts fail closed", () => {
  const vectors = [
    ["stale_session", (input) => { input.currentState.gameSessionId = "other-session"; }],
    ["stale_turn", (input) => { input.currentState.turnId = "other-turn"; }],
    ["stale_phase", (input) => { input.currentState.phase = "day_discussion"; }],
    ["target_ineligible", (input) => { input.currentState.players = input.currentState.players.filter((p) => p.participantId !== "npc-beni"); }],
    ["invalid_reference", (input) => {
      input.preparedReaction.delta.plan.causationEventIds = ["missing-event"];
      refreshPrepared(input);
    }],
    ["permission_denied", (input) => {
      const claim = claimCommitInput();
      Object.assign(input, claim);
      input.liveValidationContext.currentAuthorization.roleDisclosurePolicy = "avoid_unnecessary_claim";
    }],
    ["result_fact_mismatch", (input) => {
      const claim = claimCommitInput();
      Object.assign(input, claim);
      input.liveValidationContext.currentAuthorization.authorizedResultFacts = [
        { targetId: "npc-beni", result: "not_werewolf" }
      ];
    }]
  ];
  for (const [code, change] of vectors) {
    const input = commitInput();
    change(input);
    const result = safeCommit(input);
    assert.equal(result instanceof NpcReactionCommitInvariantError, false, `${code}:${result.code}`);
    assert.equal(result.status, "rejected");
    assert.equal(result.rejection.reasonCode, code);
    assert.equal(input.currentState.stateVersion, 2);
    assert.equal(input.currentState.conversation.npcReactionCommitIdempotencyRecords.length, 0);
  }
});

test("authoritative commit actor eligibility precedes policy and uses actor_ineligible", () => {
  const vectors = [
    (input) => {
      input.currentState.players = input.currentState.players.filter(
        (player) => player.participantId !== "npc-aoi"
      );
    },
    (input) => {
      input.currentState.players.find((player) => player.participantId === "npc-aoi").alive = false;
    },
    (input) => {
      input.currentState.players.find((player) => player.participantId === "npc-aoi").maySpeak = false;
    }
  ];
  for (const change of vectors) {
    const input = claimCommitInput();
    input.liveValidationContext.currentAuthorization.roleDisclosurePolicy = "avoid_unnecessary_claim";
    const beforeState = canonicalJson(input.currentState);
    change(input);
    const changedState = canonicalJson(input.currentState);
    const result = commitNpcReactionAuthoritatively(input);
    assert.equal(result.status, "rejected");
    assert.deepEqual(result.rejection, {
      stage: "authorization",
      reasonCode: "actor_ineligible",
      retryable: false,
      diagnostics: [{ code: "actor_ineligible", location: "actor" }]
    });
    assert.notEqual(changedState, beforeState);
    assert.equal(canonicalJson(input.currentState), changedState);
    assert.equal(input.currentState.conversation.npcReactionCommitIdempotencyRecords.length, 0);
  }
});

test("eligible actor policy and disclosure denials use permission_denied", () => {
  const policy = claimCommitInput();
  policy.liveValidationContext.currentAuthorization.roleDisclosurePolicy = "avoid_unnecessary_claim";
  const policyResult = commitNpcReactionAuthoritatively(policy);
  assert.equal(policyResult.rejection.reasonCode, "permission_denied");
  assert.equal(policyResult.rejection.stage, "authorization");
  assert.deepEqual(policyResult.rejection.diagnostics, [
    { code: "permission_denied", location: "policy" }
  ]);

  const disclosure = roleClaimCommitInput();
  disclosure.liveValidationContext.currentAuthorization.allowedClaimRoles = [];
  const disclosureResult = commitNpcReactionAuthoritatively(disclosure);
  assert.equal(disclosureResult.rejection.reasonCode, "permission_denied");
  assert.equal(disclosureResult.rejection.stage, "authorization");
  assert.deepEqual(disclosureResult.rejection.diagnostics, [
    { code: "permission_denied", location: "policy" }
  ]);
});

test("order mismatches, exhaustion, artifact collisions, and corrupt registries leave no partial effects", () => {
  const mismatch = commitInput();
  mismatch.currentState.conversation.nextCreatedOrder += 1;
  assert.equal(commitNpcReactionAuthoritatively(mismatch).rejection.reasonCode, "order_precondition_mismatch");
  const exhausted = commitInput();
  exhausted.currentState.conversation.nextCreatedOrder = Number.MAX_SAFE_INTEGER;
  exhausted.preparedReaction.delta.orderReservation.preconditionNextCreatedOrder = Number.MAX_SAFE_INTEGER;
  refreshPrepared(exhausted);
  assert.throws(() => commitNpcReactionAuthoritatively(exhausted), invariant("invalid_commit_delta"));
  const collision = commitInput();
  collision.currentState.players.push({
    participantId: collision.preparedReaction.delta.publication.publicationId,
    participantClass: "npc", alive: true, maySpeak: true
  });
  assert.equal(commitNpcReactionAuthoritatively(collision).rejection.reasonCode, "artifact_id_collision");
  const corrupt = commitInput();
  corrupt.currentState.conversation.nextRecordAppendOrder = 2;
  assert.throws(() => commitNpcReactionAuthoritatively(corrupt), invariant("invalid_canonical_publication_counter_state"));
});

test("committed graph validation requires no coordinator or tombstone after commit", () => {
  const result = commitNpcReactionAuthoritatively(commitInput());
  const state = structuredClone(result.replacementState);
  const retry = commitInput();
  retry.currentState = state;
  retry.coordinatorRoot = {
    schemaVersion: 1, gameSessionId: "game-session-1", nextTerminalOrder: 0,
    logicalReactions: {}, reactionAttempts: {}, terminalSlotReservations: {}, reactionTombstones: {}
  };
  retry.liveValidationContext.currentStateVersion = 999;
  assert.equal(commitNpcReactionAuthoritatively(retry).status, "replayed");
});

test("closed constants and browser-safe production isolation remain exact", async () => {
  assert.deepEqual(NPC_REACTION_COMMIT_REJECTION_CODES, [
    "idempotency_conflict", "identity_conflict", "stale_session", "stale_turn",
    "stale_phase", "stale_state_version", "logical_reaction_mismatch",
    "attempt_mismatch", "actor_ineligible", "target_ineligible",
    "invalid_reference", "permission_denied", "result_fact_mismatch",
    "artifact_id_collision", "order_precondition_mismatch",
    "state_version_exhausted", "order_exhausted"
  ]);
  assert.equal(NPC_REACTION_COMMIT_REJECTION_CODES.includes("authorization"), false);
  for (const candidateOnlyReserved of [
    "known_information_boundary_violation",
    "final_live_validation_failure",
    "role_disclosure_policy_unknown"
  ]) assert.equal(NPC_REACTION_COMMIT_REJECTION_CODES.includes(candidateOnlyReserved), false);
  assert.equal(new Set(NPC_REACTION_COMMIT_INVARIANT_CODES).size, 15);
  assert.ok(Object.isFrozen(NPC_REACTION_COMMIT_REJECTION_CODES));
  assert.ok(Object.isFrozen(NPC_REACTION_COMMIT_INVARIANT_CODES));
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/npcReactionAuthoritativeCommit.mjs", import.meta.url), "utf8"));
  for (const forbidden of [
    "node:", "process.", "Buffer", "Date.now", "Math.random", "setTimeout",
    "fetch(", "gameEngine", "browserApp", "webServer", "responseProvider"
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

function commitInput(proposals = [{ proposalType: "suspicion", targetId: "npc-beni" }]) {
  const preparationInput = preparationFixture(proposals);
  const preparedResult = prepareNpcReaction(preparationInput);
  assert.equal(preparedResult.status, "prepared");
  const preparedReaction = structuredClone(preparedResult.value);
  return {
    schemaVersion: 1,
    currentState: stateFixture(preparationInput),
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

function claimCommitInput() {
  return commitInput([{ proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" }]);
}

function roleClaimCommitInput() {
  return commitInput([{ proposalType: "role_claim", claimedRole: "seer" }]);
}

function preparationFixture(proposals) {
  const candidate = { schemaVersion: 1, proposals: structuredClone(proposals) };
  const playerResult = {
    schemaVersion: 1, requestId: "player-request-1", correlationId: "player-correlation-1",
    requestFingerprint: PLAYER_FP, commitType: "player_conversation",
    preconditionStateVersion: 1, resultingStateVersion: 2, inputRecordId: "input-1",
    displayPlanId: "display-1", playerPublicationId: "publication-1",
    createdEventIds: [], createdClaimIds: [], createdAtOrder: 1
  };
  const input = {
    schemaVersion: 1,
    validatedCandidate: {
      schemaVersion: 1,
      binding: {
        gameSessionId: "game-session-1", reactionPlanId: "reaction-plan-1",
        reactionAttemptId: "reaction-attempt-1", requestId: "reaction-request-1",
        requestFingerprint: REQUEST_FP, correlationId: "player-correlation-1",
        causationId: "player-request-1", originatingInputRecordId: "input-1",
        turnId: "turn-1", turnOrder: 1, preconditionPhase: "player_question",
        preconditionStateVersion: 2, npcId: "npc-aoi"
      },
      candidate,
      candidateFingerprint: sha256CanonicalJson(candidate),
      validationContext: {
        projectionFingerprint: PROJECTION_FP,
        roleDisclosurePolicy: proposals.some((p) => ["role_claim", "result_claim"].includes(p.proposalType))
          ? "claim_when_directly_asked_after_result" : "avoid_unnecessary_claim",
        permissionResult: "allowed",
        finalApplicabilityResult: "applicable"
      }
    },
    preparationSnapshot: {
      schemaVersion: 1, snapshotType: "npc_reaction_preparation",
      gameSessionId: "game-session-1", turnId: "turn-1", turnOrder: 1,
      currentPhase: "player_question", currentStateVersion: 2,
      logicalReaction: {
        schemaVersion: 1, gameSessionId: "game-session-1",
        reactionPlanId: "reaction-plan-1", requestId: "reaction-request-1",
        requestFingerprint: REQUEST_FP, correlationId: "player-correlation-1",
        causationId: "player-request-1", originatingInputRecordId: "input-1",
        turnId: "turn-1", turnOrder: 1, preconditionPhase: "player_question",
        preconditionStateVersion: 2, npcId: "npc-aoi", status: "active"
      },
      winningAttempt: {
        schemaVersion: 1, reactionPlanId: "reaction-plan-1",
        reactionAttemptId: "reaction-attempt-1", status: "validated"
      },
      triggeringCommitResult: playerResult,
      originatingInputRecord: {
        schemaVersion: 1, inputRecordId: "input-1", requestId: "player-request-1",
        correlationId: "player-correlation-1", turnId: "turn-1",
        capturedStateVersion: 1, actorId: "player", rawText: "Question?",
        locale: "ja-JP", createdOrder: 0
      },
      triggeringEvents: [],
      currentRoster: [
        { participantId: "npc-aoi", participantClass: "npc", publicStatus: "alive" },
        { participantId: "npc-beni", participantClass: "npc", publicStatus: "alive" },
        { participantId: "player", participantClass: "player", publicStatus: "alive" }
      ],
      actorApplicability: {
        schemaVersion: 1, presence: "present", actorId: "npc-aoi",
        alive: true, maySpeak: true
      },
      currentAuthorization: {
        schemaVersion: 1, availability: "available", actorId: "npc-aoi",
        roleDisclosurePolicy: "avoid_unnecessary_claim", allowedClaimRoles: [],
        authorizedResultFacts: []
      },
      currentTargetIds: ["npc-beni"],
      existingClaims: [], existingEvents: [],
      nextOrderEvidence: {
        nextCreatedOrder: 2, nextPublicationSlotOrder: 1, nextRecordAppendOrder: 1
      },
      occupiedArtifactIds: [
        "game-session-1", "input-1", "publication-1", "reaction-attempt-1",
        "reaction-plan-1", "reaction-request-1", "turn-1"
      ]
    },
    artifactAllocation: {
      schemaVersion: 1, allocationType: "npc_reaction_artifacts",
      descriptorIds: proposals.map((_, index) => `case-descriptor-${index + 1}`),
      claimAllocations: proposals.flatMap((proposal, index) =>
        ["role_claim", "result_claim"].includes(proposal.proposalType)
          ? [{ proposalIndex: index, claimId: `case-claim-${index + 1}` }] : []),
      eventIds: proposals.map((_, index) => `case-event-${index + 1}`),
      segmentIds: proposals.map((_, index) => `case-segment-${index + 1}`),
      publicationId: "case-publication"
    },
    orderReservation: {
      schemaVersion: 1, reservationType: "npc_reaction_orders",
      preconditionNextCreatedOrder: 2,
      eventCreatedOrders: proposals.map((_, index) => 2 + index),
      commitResultCreatedAtOrder: 2 + proposals.length,
      resultingNextCreatedOrder: 3 + proposals.length,
      preconditionNextPublicationSlotOrder: 1, publicationSlotOrder: 1,
      resultingNextPublicationSlotOrder: 2,
      preconditionNextRecordAppendOrder: 1, publicationRecordAppendOrder: 1,
      resultingNextRecordAppendOrder: 2, priorClaimCount: 0, priorEventCount: 0
    }
  };
  if (proposals.some((p) => ["role_claim", "result_claim"].includes(p.proposalType))) {
    input.validatedCandidate.validationContext.roleDisclosurePolicy = "claim_when_directly_asked_after_result";
    input.preparationSnapshot.currentAuthorization.roleDisclosurePolicy = "claim_when_directly_asked_after_result";
    input.preparationSnapshot.currentAuthorization.allowedClaimRoles = ["seer"];
    input.preparationSnapshot.currentAuthorization.authorizedResultFacts =
      proposals.filter((p) => p.proposalType === "result_claim")
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

function stateFixture(preparationInput) {
  const snapshot = preparationInput.preparationSnapshot;
  const input = structuredClone(snapshot.originatingInputRecord);
  const rawLength = [...input.rawText].length;
  const accepted = {
    schemaVersion: 1, speechActId: "accepted-info-1", requestId: input.requestId,
    acceptedTurnId: input.turnId, acceptedStateVersion: input.capturedStateVersion,
    acceptedPhase: "player_question", inputRecordId: input.inputRecordId,
    actorId: "player", causationId: "player-cause-1",
    correlationId: input.correlationId, idempotencyKey: "player-idempotency-1",
    sourceSpan: { start: 0, end: rawLength },
    ...(snapshot.existingEvents.length
      ? { type: "accepted_question", targetId: "npc-aoi", topic: "role" }
      : { type: "accepted_information_request", topic: "rules" })
  };
  const displayPlan = {
    schemaVersion: 1, displayPlanId: "display-1", inputRecordId: input.inputRecordId,
    turnId: input.turnId, stateVersion: 2,
    segments: [{
      segmentId: "player-raw-1", type: "raw_input",
      inputRecordId: input.inputRecordId, sourceSpan: { start: 0, end: rawLength }
    }]
  };
  const playerPublication = {
    schemaVersion: 1, recordType: "player_utterance_published",
    publicationId: "publication-1", requestId: input.requestId,
    correlationId: input.correlationId, turnId: input.turnId,
    gameStateVersion: 2, occurredPhase: "player_question", actorId: "player",
    inputRecordId: input.inputRecordId, displayPlanId: displayPlan.displayPlanId,
    idempotencyKey: "player-publication-idempotency-1",
    publicationSlotOrder: 0, recordAppendOrder: 0
  };
  return {
    gameSessionId: "game-session-1", turnId: "turn-1", turnOrder: 1,
    phase: "player_question", stateVersion: 2,
    players: [
      { participantId: "npc-aoi", participantClass: "npc", alive: true, maySpeak: true },
      { participantId: "npc-beni", participantClass: "npc", alive: true, maySpeak: true },
      { participantId: "player", participantClass: "player", alive: true, maySpeak: true }
    ],
    conversation: {
      inputRecords: [input], acceptedSpeechActs: [accepted], claims: [],
      events: structuredClone(snapshot.existingEvents), displayPlans: [displayPlan],
      reactionPlans: [], publications: [playerPublication],
      commitResults: [structuredClone(snapshot.triggeringCommitResult)],
      npcReactionCommitIdempotencyRecords: [],
      nextCreatedOrder: snapshot.nextOrderEvidence.nextCreatedOrder,
      nextPublicationSlotOrder: 1, nextRecordAppendOrder: 1
    },
    unrelated: { preserved: true }
  };
}

function coordinatorFixture(preparationInput) {
  const b = preparationInput.validatedCandidate.binding;
  const logical = {
    schemaVersion: 1, gameSessionId: b.gameSessionId, reactionPlanId: b.reactionPlanId,
    requestId: b.requestId, requestFingerprint: b.requestFingerprint,
    correlationId: b.correlationId, causationId: b.causationId,
    originatingInputRecordId: b.originatingInputRecordId, turnId: b.turnId,
    turnOrder: b.turnOrder, preconditionPhase: b.preconditionPhase,
    preconditionStateVersion: b.preconditionStateVersion, npcId: b.npcId,
    routeSnapshot: { schemaVersion: 1, route: "structured" },
    projectionFingerprint: PROJECTION_FP, status: "planned", attemptIds: [],
    createdAt: "2026-07-16T00:00:00Z",
    retryPolicy: {
      schemaVersion: 1, maxAttempts: 3, backoffDelaysMs: [1000, 2000],
      logicalDeadlineMs: 15000
    }
  };
  let root = createPlannedNpcReaction(createNpcReactionCoordinatorRoot(b.gameSessionId), {
    gameSessionId: b.gameSessionId, logicalReaction: logical
  }).root;
  root = createNpcReactionAttempt(root, {
    gameSessionId: b.gameSessionId,
    attempt: {
      schemaVersion: 1, pendingType: "npc_reaction", gameSessionId: b.gameSessionId,
      requestId: b.requestId, requestFingerprint: b.requestFingerprint,
      correlationId: b.correlationId, causationId: b.causationId,
      reactionPlanId: b.reactionPlanId, reactionAttemptId: b.reactionAttemptId,
      originatingInputRecordId: b.originatingInputRecordId, turnId: b.turnId,
      turnOrder: b.turnOrder, preconditionStateVersion: b.preconditionStateVersion,
      preconditionPhase: b.preconditionPhase, targetNpcId: b.npcId,
      operation: "generate_npc_reaction_candidate", status: "attempting",
      candidateFingerprint: null, startedAt: "2026-07-16T00:00:01Z"
    }
  }).root;
  root = receiveNpcReactionCandidate(root, {
    gameSessionId: b.gameSessionId, reactionPlanId: b.reactionPlanId,
    reactionAttemptId: b.reactionAttemptId
  }).root;
  return observeNpcReactionCandidate(root, {
    gameSessionId: b.gameSessionId, reactionPlanId: b.reactionPlanId,
    reactionAttemptId: b.reactionAttemptId,
    candidateFingerprint: preparationInput.validatedCandidate.candidateFingerprint
  }).root;
}

function liveFixture(preparationInput) {
  const snapshot = preparationInput.preparationSnapshot;
  return {
    schemaVersion: 1, contextType: "npc_reaction_commit_live",
    gameSessionId: snapshot.gameSessionId, turnId: snapshot.turnId,
    turnOrder: snapshot.turnOrder, currentPhase: snapshot.currentPhase,
    currentStateVersion: snapshot.currentStateVersion,
    actorApplicability: structuredClone(snapshot.actorApplicability),
    currentAuthorization: structuredClone(snapshot.currentAuthorization),
    currentTargetIds: structuredClone(snapshot.currentTargetIds)
  };
}

function questionEvent() {
  return {
    schemaVersion: 1, eventId: "question-event-1", requestId: "player-request-1",
    turnId: "turn-1", actorId: "player", causationId: "player-cause-1",
    correlationId: "player-correlation-1", idempotencyKey: "question-event-key-1",
    source: {
      sourceType: "player_accepted_act", acceptedSpeechActId: "accepted-info-1",
      inputRecordId: "input-1", requestId: "player-request-1"
    },
    stateVersion: 2, occurredPhase: "player_question", createdOrder: 1,
    eventType: "public_question_recorded", targetId: "npc-aoi", topic: "role"
  };
}

function mutate(input, change) {
  const copy = structuredClone(input);
  change(copy);
  return copy;
}

function safeCommit(input) {
  try { return commitNpcReactionAuthoritatively(input); }
  catch (error) { return error; }
}

function invariant(code) {
  return (error) => error instanceof NpcReactionCommitInvariantError
    && error.name === "NpcReactionCommitInvariantError"
    && error.message === "Invalid NPC reaction commit operation."
    && error.code === code
    && !Object.hasOwn(error, "cause");
}

function advancePreparedVersion(input, version) {
  input.currentState.stateVersion = version;
  input.liveValidationContext.currentStateVersion = version;
  const delta = input.preparedReaction.delta;
  delta.binding.preconditionStateVersion = version;
  delta.preconditionStateVersion = version;
  delta.resultingStateVersion = version + 1;
  delta.plan.preconditionStateVersion = version;
  delta.plan.resultingStateVersion = version + 1;
  delta.expectedCommitResult.preconditionStateVersion = version;
  delta.expectedCommitResult.resultingStateVersion = version + 1;
  delta.publication.reactionResultingStateVersion = version + 1;
  input.preCommitReferenceContext = {
    ...input.preCommitReferenceContext,
    preparationBinding: structuredClone(delta.binding),
    commitDelta: structuredClone(delta),
    validatedCandidateBinding: {
      ...input.preCommitReferenceContext.validatedCandidateBinding,
      preconditionStateVersion: version
    }
  };
}

function refreshPrepared(input) {
  const delta = input.preparedReaction.delta;
  delta.preparationFingerprint = "0".repeat(64);
  delta.idempotencyReservation.preparationFingerprint = "0".repeat(64);
  const fingerprint = sha256CanonicalJson(delta);
  delta.preparationFingerprint = fingerprint;
  delta.idempotencyReservation.preparationFingerprint = fingerprint;
  input.preparedReaction.preparationFingerprint = fingerprint;
  input.preCommitReferenceContext.preparationBinding = structuredClone(delta.binding);
  input.preCommitReferenceContext.commitDelta = structuredClone(delta);
}
