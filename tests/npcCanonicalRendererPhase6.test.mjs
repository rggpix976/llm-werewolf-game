import test from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, sha256CanonicalJson } from "../src/conversation/ids.mjs";
import {
  NpcPublicationDeliveryInvariantError,
  createNpcCanonicalRendererForTesting,
  resolveNpcCanonicalDeliveryPayload
} from "../src/npcCanonicalRenderer.mjs";

const REQUEST_FINGERPRINT = "a".repeat(64);
const PREPARATION_FINGERPRINT = "b".repeat(64);

function fixture(locale = "en", proposals = [{ kind: "role", claimedRole: "seer" }]) {
  const intendedSpeechActs = [];
  const canonicalSegments = [];
  const claims = [];
  const events = [];
  proposals.forEach((proposal, index) => {
    const number = index + 1;
    const descriptorId = `descriptor-${number}`;
    const source = {
      sourceType: "npc_reaction",
      reactionPlanId: "reaction-plan-1",
      descriptorId,
      originatingInputRecordId: "input-record-1",
      reactionCommitRequestId: "reaction-request-1"
    };
    if (proposal.kind === "role" || proposal.kind === "result") {
      const claimId = `claim-${number}`;
      const descriptor = proposal.kind === "role"
        ? { descriptorId, descriptorType: "role_claim", claimedRole: proposal.claimedRole }
        : { descriptorId, descriptorType: "result_claim", targetId: proposal.targetId, result: proposal.result };
      const claim = {
        schemaVersion: 1,
        claimId,
        claimRevision: 1,
        actorId: "npc-1",
        source,
        idempotencyKey: sha256CanonicalJson({ claimId }),
        createdTurnId: "turn-1",
        createdStateVersion: 2,
        repeatsClaimId: null,
        contradictsClaimIds: [],
        status: "asserted",
        type: proposal.kind === "role" ? "role_claim" : "result_claim",
        ...(proposal.kind === "role"
          ? { claimedRole: proposal.claimedRole }
          : { targetId: proposal.targetId, result: proposal.result })
      };
      const event = baseEvent(number, source, proposal.kind === "role" ? "role_claim_recorded" : "result_claim_recorded", { claimId });
      intendedSpeechActs.push(descriptor);
      canonicalSegments.push({ segmentId: `segment-${number}`, descriptorId, type: "canonical_claim", claimId });
      claims.push(claim);
      events.push(event);
      return;
    }
    const descriptorType = proposal.kind === "vote" ? "vote_declaration" : "suspicion";
    const eventType = proposal.kind === "vote" ? "vote_declared" : "suspicion_expressed";
    const event = baseEvent(number, source, eventType, { targetId: proposal.targetId });
    intendedSpeechActs.push({ descriptorId, descriptorType, targetId: proposal.targetId });
    canonicalSegments.push(proposal.kind === "vote"
      ? { segmentId: `segment-${number}`, descriptorId, type: "canonical_vote", voteEventId: event.eventId }
      : { segmentId: `segment-${number}`, descriptorId, type: "canonical_suspicion", suspicionEventId: event.eventId });
    events.push(event);
  });

  const descriptorTypes = new Set(intendedSpeechActs.map((descriptor) => descriptor.descriptorType));
  const reactionPlan = {
    schemaVersion: 1,
    requestId: "reaction-request-1",
    correlationId: "correlation-1",
    causationId: "causation-1",
    originatingInputRecordId: "input-record-1",
    locale,
    causationEventIds: [],
    reactionPlanId: "reaction-plan-1",
    successfulAttemptId: "reaction-attempt-1",
    turnId: "turn-1",
    preconditionStateVersion: 1,
    resultingStateVersion: 2,
    npcId: "npc-1",
    renderMode: "canonical_only",
    intendedSpeechActs,
    policies: {
      policyType: "reaction_policies",
      allowStateChanges: true,
      allowClaims: descriptorTypes.has("role_claim") || descriptorTypes.has("result_claim"),
      allowVoteDeclaration: descriptorTypes.has("vote_declaration"),
      allowSuspicionUpdate: descriptorTypes.has("suspicion"),
      allowMemoryUpdate: false
    },
    maxChars: 1000,
    canonicalSegments
  };
  const publication = {
    schemaVersion: 1,
    recordType: "npc_canonical_published",
    publicationId: "npc-publication-1",
    reactionPlanId: reactionPlan.reactionPlanId,
    reactionCommitRequestId: reactionPlan.requestId,
    originatingInputRecordId: reactionPlan.originatingInputRecordId,
    correlationId: reactionPlan.correlationId,
    turnId: reactionPlan.turnId,
    reactionResultingStateVersion: reactionPlan.resultingStateVersion,
    actorId: reactionPlan.npcId,
    locale,
    canonicalRendererVersion: 1,
    canonicalSegmentIds: canonicalSegments.map((segment) => segment.segmentId),
    publicationSlotOrder: 0,
    recordAppendOrder: 0
  };
  const commitResult = {
    schemaVersion: 1,
    requestId: reactionPlan.requestId,
    correlationId: reactionPlan.correlationId,
    requestFingerprint: REQUEST_FINGERPRINT,
    commitType: "npc_reaction",
    preconditionStateVersion: 1,
    resultingStateVersion: 2,
    reactionPlanId: reactionPlan.reactionPlanId,
    npcPublicationId: publication.publicationId,
    createdEventIds: events.map((event) => event.eventId),
    createdClaimIds: claims.map((claim) => claim.claimId),
    createdAtOrder: events.length,
    resultMode: "canonical_only"
  };
  const idempotencyRecord = {
    schemaVersion: 1,
    recordType: "npc_reaction_commit_idempotency",
    gameSessionId: "game-session-1",
    reactionPlanId: reactionPlan.reactionPlanId,
    requestId: reactionPlan.requestId,
    requestFingerprint: REQUEST_FINGERPRINT,
    preparationFingerprint: PREPARATION_FINGERPRINT,
    successfulAttemptId: reactionPlan.successfulAttemptId,
    correlationId: reactionPlan.correlationId,
    causationId: reactionPlan.causationId,
    originatingInputRecordId: reactionPlan.originatingInputRecordId,
    turnId: reactionPlan.turnId,
    turnOrder: 1,
    npcId: reactionPlan.npcId,
    preconditionStateVersion: 1,
    resultingStateVersion: 2,
    npcPublicationId: publication.publicationId,
    commitResultRequestId: commitResult.requestId
  };
  return {
    schemaVersion: 1,
    committedGraph: {
      schemaVersion: 1,
      contextType: "committed_graph",
      reactionPlan,
      idempotencyRecord,
      commitResult,
      publication,
      claims,
      events,
      segments: canonicalSegments
    },
    renderingContext: {
      locale,
      publicParticipantsById: {
        "npc-1": { participantId: "npc-1", displayName: "Actor" },
        "target-1": { participantId: "target-1", displayName: "Target" }
      }
    }
  };
}

function baseEvent(number, source, eventType, fields) {
  return {
    schemaVersion: 1,
    eventId: `event-${number}`,
    requestId: "reaction-request-1",
    turnId: "turn-1",
    actorId: "npc-1",
    causationId: "causation-1",
    correlationId: "correlation-1",
    idempotencyKey: `event-idempotency-${number}`,
    source,
    stateVersion: 2,
    occurredPhase: "player_question",
    createdOrder: number - 1,
    eventType,
    ...fields
  };
}

function expectInvariant(input) {
  assert.throws(() => resolveNpcCanonicalDeliveryPayload(input), (error) => {
    assert.ok(error instanceof NpcPublicationDeliveryInvariantError);
    assert.equal(error.name, "NpcPublicationDeliveryInvariantError");
    assert.equal(error.code, "invalid_npc_delivery_publication_graph");
    assert.equal(error.message, "NPC publication delivery invariant failed");
    assert.deepEqual(Object.keys(error), []);
    assert.ok(!Object.hasOwn(error, "cause"));
    return true;
  });
}

test("renderer version 1 emits the exact locale tables and plan-order join", () => {
  const proposals = [
    { kind: "role", claimedRole: "seer" },
    { kind: "result", targetId: "target-1", result: "werewolf" },
    { kind: "vote", targetId: "target-1" },
    { kind: "suspicion", targetId: "target-1" }
  ];
  const expected = {
    ja: "私は占い師です。Targetは人狼です。Targetに投票します。Targetを疑っています。",
    "ja-JP": "私は占い師です。Targetは人狼です。Targetに投票します。Targetを疑っています。",
    en: "I am the seer. Target is a werewolf. I will vote for Target. I suspect Target.",
    "en-US": "I am the seer. Target is a werewolf. I will vote for Target. I suspect Target."
  };
  for (const locale of Object.keys(expected)) {
    const input = fixture(locale, proposals);
    const before = canonicalJson(input);
    const payload = resolveNpcCanonicalDeliveryPayload(input);
    assert.equal(payload.displayText, expected[locale]);
    assert.equal(payload.locale, locale);
    assert.deepEqual(payload.canonicalSegmentIds, ["segment-1", "segment-2", "segment-3", "segment-4"]);
    assert.equal(payload.payloadFingerprint, sha256CanonicalJson(Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "payloadFingerprint"))));
    assert.ok(Object.isFrozen(payload));
    assert.ok(Object.isFrozen(payload.canonicalSegmentIds));
    assert.equal(canonicalJson(input), before);
  }
});

test("all closed role and result values use their exact table strings", () => {
  const vectors = [
    [{ kind: "role", claimedRole: "werewolf" }, "I am a werewolf."],
    [{ kind: "role", claimedRole: "citizen" }, "I am a citizen."],
    [{ kind: "result", targetId: "target-1", result: "not_werewolf" }, "Target is not a werewolf."]
  ];
  for (const [proposal, expected] of vectors) {
    assert.equal(resolveNpcCanonicalDeliveryPayload(fixture("en", [proposal])).displayText, expected);
  }
});

test("display-name code points are preserved without trim, collapse, normalization, or escaping", () => {
  for (const [name, expected] of [
    [" Target", "I suspect  Target."],
    ["Target ", "I suspect Target ."],
    ["E\u0301clair", "I suspect E\u0301clair."],
    ["<Target & friend>", "I suspect <Target & friend>."],
    ["😀", "I suspect 😀."]
  ]) {
    const input = fixture("en", [{ kind: "suspicion", targetId: "target-1" }]);
    input.renderingContext.publicParticipantsById["target-1"].displayName = name;
    assert.equal(resolveNpcCanonicalDeliveryPayload(input).displayText, expected);
  }
});

test("strict graph and rendering-context contradictions throw the redacted invariant", () => {
  const vectors = [
    mutate(fixture(), (input) => { input.unknown = true; }),
    mutate(fixture(), (input) => { input.committedGraph.unknown = true; }),
    mutate(fixture(), (input) => { input.committedGraph.publication.actorId = "npc-2"; }),
    mutate(fixture(), (input) => { input.committedGraph.publication.canonicalSegmentIds = ["other-segment"]; }),
    mutate(fixture(), (input) => { input.committedGraph.claims[0].source.descriptorId = "other-descriptor"; }),
    mutate(fixture(), (input) => { input.committedGraph.claims.push(structuredClone(input.committedGraph.claims[0])); }),
    mutate(fixture(), (input) => { input.renderingContext.locale = "ja"; }),
    mutate(fixture(), (input) => { input.renderingContext.publicParticipantsById = new Map(); }),
    mutate(fixture(), (input) => { input.renderingContext.publicParticipantsById["npc-1"].role = "werewolf"; }),
    mutate(fixture("en", [{ kind: "vote", targetId: "target-1" }]), (input) => { delete input.renderingContext.publicParticipantsById["target-1"]; }),
    mutate(fixture(), (input) => { input.committedGraph.reactionPlan.maxChars = 0; })
  ];
  for (const input of vectors) expectInvariant(input);
});

test("every committed-graph member is required, non-null, and strict", () => {
  const fields = ["reactionPlan", "idempotencyRecord", "commitResult", "publication", "claims", "events", "segments"];
  for (const field of fields) {
    expectInvariant(mutate(fixture(), (input) => { delete input.committedGraph[field]; }));
    expectInvariant(mutate(fixture(), (input) => { input.committedGraph[field] = null; }));
  }
  for (const field of ["reactionPlan", "idempotencyRecord", "commitResult", "publication"]) {
    expectInvariant(mutate(fixture(), (input) => { input.committedGraph[field].unknown = true; }));
  }
  expectInvariant(mutate(fixture(), (input) => { input.committedGraph.contextType = "pre_commit"; }));
});

test("identity, version, descriptor, claim, and event graph mismatches are invariant", () => {
  const roleVectors = [
    (input) => { input.committedGraph.reactionPlan.reactionPlanId = "other-plan"; },
    (input) => { input.committedGraph.idempotencyRecord.reactionPlanId = "other-plan"; },
    (input) => { input.committedGraph.commitResult.reactionPlanId = "other-plan"; },
    (input) => { input.committedGraph.publication.reactionPlanId = "other-plan"; },
    (input) => { input.committedGraph.idempotencyRecord.requestId = "other-request"; },
    (input) => { input.committedGraph.commitResult.requestFingerprint = "c".repeat(64); },
    (input) => { input.committedGraph.publication.correlationId = "other-correlation"; },
    (input) => { input.committedGraph.idempotencyRecord.causationId = "other-causation"; },
    (input) => { input.committedGraph.publication.originatingInputRecordId = "other-input"; },
    (input) => { input.committedGraph.publication.turnId = "other-turn"; },
    (input) => { input.committedGraph.publication.actorId = "other-actor"; },
    (input) => { input.committedGraph.idempotencyRecord.successfulAttemptId = "other-attempt"; },
    (input) => { input.committedGraph.commitResult.preconditionStateVersion = 0; },
    (input) => { input.committedGraph.commitResult.resultingStateVersion = 3; },
    (input) => { input.committedGraph.reactionPlan.resultingStateVersion = 3; },
    (input) => { input.committedGraph.publication.reactionResultingStateVersion = 3; },
    (input) => { input.committedGraph.publication.canonicalSegmentIds = []; },
    (input) => { input.committedGraph.publication.canonicalSegmentIds.push("segment-extra"); },
    (input) => { input.committedGraph.reactionPlan.canonicalSegments[0].descriptorId = "other-descriptor"; },
    (input) => { input.committedGraph.reactionPlan.intendedSpeechActs.push(structuredClone(input.committedGraph.reactionPlan.intendedSpeechActs[0])); },
    (input) => { input.committedGraph.claims = []; },
    (input) => { input.committedGraph.claims[0].type = "result_claim"; },
    (input) => { input.committedGraph.claims[0].actorId = "other-actor"; },
    (input) => { input.committedGraph.claims[0].source.reactionPlanId = "other-plan"; },
    (input) => { input.committedGraph.claims[0].source.descriptorId = "other-descriptor"; },
    (input) => { input.committedGraph.claims[0].source.originatingInputRecordId = "other-input"; },
    (input) => { input.committedGraph.claims[0].claimedRole = "citizen"; }
  ];
  for (const change of roleVectors) expectInvariant(mutate(fixture(), change));

  const eventVectors = [
    ["vote", (input) => { input.committedGraph.events = []; }],
    ["vote", (input) => { input.committedGraph.events[0].eventType = "suspicion_expressed"; }],
    ["vote", (input) => { input.committedGraph.events[0].targetId = "other-target"; }],
    ["vote", (input) => { input.committedGraph.events[0].source.descriptorId = "other-descriptor"; }],
    ["suspicion", (input) => { input.committedGraph.events = []; }],
    ["suspicion", (input) => { input.committedGraph.events[0].eventType = "vote_declared"; }],
    ["suspicion", (input) => { input.committedGraph.events[0].targetId = "other-target"; }],
    ["suspicion", (input) => { input.committedGraph.events[0].source.reactionPlanId = "other-plan"; }]
  ];
  for (const [kind, change] of eventVectors) {
    expectInvariant(mutate(fixture("en", [{ kind, targetId: "target-1" }]), change));
  }
  expectInvariant(mutate(fixture(), (input) => {
    input.committedGraph.reactionPlan.renderMode = "controlled_commentary";
  }));
});

test("rendering context enforces exact public projection shape", () => {
  const vectors = [
    (input) => { input.renderingContext.unknown = true; },
    (input) => { delete input.renderingContext.locale; },
    (input) => { input.renderingContext.locale = null; },
    (input) => { input.renderingContext.locale = "EN"; },
    (input) => { input.renderingContext.publicParticipantsById = null; },
    (input) => { input.renderingContext.publicParticipantsById.other = { participantId: "mismatch", displayName: "Other" }; },
    (input) => { input.renderingContext.publicParticipantsById["npc-1"].participantId = "bad id"; },
    (input) => { delete input.renderingContext.publicParticipantsById["npc-1"].displayName; },
    (input) => { input.renderingContext.publicParticipantsById["npc-1"].displayName = null; },
    (input) => { input.renderingContext.publicParticipantsById["npc-1"].displayName = ""; },
    (input) => { input.renderingContext.publicParticipantsById["npc-1"].displayName = "x".repeat(81); },
    (input) => { input.renderingContext.publicParticipantsById["npc-1"].team = "werewolf"; },
    (input) => { input.renderingContext.publicParticipantsById["npc-1"].memory = []; }
  ];
  for (const change of vectors) expectInvariant(mutate(fixture(), change));
});

test("renderer and hash primitive faults return exact frozen terminal failures", () => {
  const input = fixture();
  const baseRegistry = { 1: { en: { join: "", roles: { seer: "ok" }, results: {}, vote: "", suspicion: "" } } };
  const vectors = [
    createNpcCanonicalRendererForTesting({ rendererRegistry: {}, hashCanonicalJson: sha256CanonicalJson }),
    createNpcCanonicalRendererForTesting({ rendererRegistry: { 1: {} }, hashCanonicalJson: sha256CanonicalJson }),
    createNpcCanonicalRendererForTesting({ rendererRegistry: { 1: { en: { ...baseRegistry[1].en, roles: { seer: () => { throw new Error("private"); } } } } }, hashCanonicalJson: sha256CanonicalJson }),
    createNpcCanonicalRendererForTesting({ rendererRegistry: { 1: { en: { ...baseRegistry[1].en, roles: { seer: () => 7 } } } }, hashCanonicalJson: sha256CanonicalJson }),
    createNpcCanonicalRendererForTesting({ rendererRegistry: baseRegistry, hashCanonicalJson: () => { throw new Error("private"); } }),
    createNpcCanonicalRendererForTesting({ rendererRegistry: baseRegistry, hashCanonicalJson: () => "A".repeat(64) }),
    createNpcCanonicalRendererForTesting({ rendererRegistry: baseRegistry, hashCanonicalJson: () => "a".repeat(63) }),
    createNpcCanonicalRendererForTesting({ rendererRegistry: baseRegistry, hashCanonicalJson: () => "g".repeat(64) })
  ];
  for (const resolve of vectors) {
    const result = resolve(input);
    assert.deepEqual(result, { schemaVersion: 1, failureType: "npc_delivery_resolution", code: "canonical_render_failed", disposition: "terminal" });
    assert.ok(Object.isFrozen(result));
  }
});

test("stored renderer version absence is a production resolution failure", () => {
  const input = fixture();
  input.committedGraph.publication.canonicalRendererVersion = 2;
  const before = canonicalJson(input);
  const result = resolveNpcCanonicalDeliveryPayload(input);
  assert.equal(result.code, "canonical_render_failed");
  assert.equal(canonicalJson(input), before);
});

test("Unicode code-point limits run before one exact fingerprint operation", () => {
  const input = fixture();
  for (const [length, expectedCode] of [[1000, null], [1001, "canonical_render_limit_exceeded"]]) {
    let hashCalls = 0;
    const resolve = createNpcCanonicalRendererForTesting({
      rendererRegistry: { 1: { en: { join: "", roles: { seer: () => "😀".repeat(length) }, results: {}, vote: "", suspicion: "" } } },
      hashCanonicalJson: (value) => { hashCalls += 1; return sha256CanonicalJson(value); }
    });
    const result = resolve(input);
    if (expectedCode === null) assert.equal(Array.from(result.displayText).length, 1000);
    else assert.equal(result.code, expectedCode);
    assert.equal(hashCalls, expectedCode === null ? 1 : 0);
  }
  const combining = createNpcCanonicalRendererForTesting({
    rendererRegistry: { 1: { en: { join: "", roles: { seer: () => "E\u0301".repeat(500) }, results: {}, vote: "", suspicion: "" } } },
    hashCanonicalJson: sha256CanonicalJson
  })(input);
  assert.equal(Array.from(combining.displayText).length, 1000);

  const exact = fixture();
  exact.committedGraph.reactionPlan.maxChars = 5;
  const exactResolver = createNpcCanonicalRendererForTesting({
    rendererRegistry: { 1: { en: { join: "", roles: { seer: "12345" }, results: {}, vote: "", suspicion: "" } } },
    hashCanonicalJson: sha256CanonicalJson
  });
  assert.equal(exactResolver(exact).displayText, "12345");
  const short = fixture();
  short.committedGraph.reactionPlan.maxChars = 4;
  const result = createNpcCanonicalRendererForTesting({
    rendererRegistry: { 1: { en: { join: "", roles: { seer: "12345" }, results: {}, vote: "", suspicion: "" } } },
    hashCanonicalJson: sha256CanonicalJson
  })(short);
  assert.equal(result.code, "canonical_render_limit_exceeded");
});

test("test registry is detached and production output is deterministic", () => {
  const registry = { 1: { en: { join: "", roles: { seer: "first" }, results: {}, vote: "", suspicion: "" } } };
  const resolve = createNpcCanonicalRendererForTesting({ rendererRegistry: registry, hashCanonicalJson: sha256CanonicalJson });
  registry[1].en.roles.seer = "mutated";
  assert.equal(resolve(fixture()).displayText, "first");
  assert.deepEqual(resolveNpcCanonicalDeliveryPayload(fixture()), resolveNpcCanonicalDeliveryPayload(structuredClone(fixture())));
});

function mutate(value, change) {
  change(value);
  return value;
}
