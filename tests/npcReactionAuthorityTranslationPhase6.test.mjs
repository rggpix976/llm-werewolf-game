import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../src/conversation/ids.mjs";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { commitNpcReactionAuthoritatively } from "../src/npcReactionAuthoritativeCommit.mjs";
import {
  NPC_REACTION_AUTHORITY_TRANSLATION_INVARIANT_CODES,
  NpcReactionAuthorityTranslationInvariantError,
  buildNpcReactionCommitTransactionProjection,
  translateNpcReactionCommitReplacementToAuthorizedDelta,
  validateNpcReactionAuthorizedDelta,
  validateNpcReactionCommitTransactionProjection
} from "../src/npcReactionAuthorityTranslation.mjs";
import {
  commitInputFromProjection,
  createAuthorityTranslationFixture,
  refreshPreparedReaction
} from "./helpers/npcReactionAuthorityTranslationFixtures.mjs";

const PROJECTION_FIELDS = [
  "gameSessionId", "turnId", "turnOrder", "stateVersion", "phase", "players", "conversation"
];
const CONVERSATION_FIELDS = [
  "inputRecords", "acceptedSpeechActs", "claims", "events", "displayPlans", "reactionPlans",
  "publications", "commitResults", "npcReactionCommitIdempotencyRecords", "nextCreatedOrder",
  "nextPublicationSlotOrder", "nextRecordAppendOrder"
];
const APPEND_FIELDS = [
  "reactionPlans", "claims", "events", "publications",
  "npcReactionCommitIdempotencyRecords", "commitResults"
];

function ids(prefix = "translation") {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function game(options = {}) {
  return WerewolfGame.create({
    seed: 1,
    scenario: "sample",
    shuffleRoles: false,
    createId: ids(),
    ...options
  });
}

function assertInvariant(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof NpcReactionAuthorityTranslationInvariantError);
    assert.equal(error.name, "NpcReactionAuthorityTranslationInvariantError");
    assert.equal(error.message, "Invalid NPC reaction authority translation.");
    assert.equal(error.code, code);
    assert.equal(Object.hasOwn(error, "cause"), false);
    for (const forbidden of [
      "state", "gameState", "projection", "replacementProjection", "preparedReaction",
      "delta", "record", "candidate", "fingerprint", "path"
    ]) assert.equal(Object.hasOwn(error, forbidden), false);
    return true;
  });
}

function committedFixture(proposals) {
  const fixture = createAuthorityTranslationFixture(proposals);
  const current = buildNpcReactionCommitTransactionProjection(fixture.gameState);
  const commitResult = commitNpcReactionAuthoritatively(commitInputFromProjection(fixture, current));
  assert.equal(commitResult.status, "committed");
  return { fixture, current, replacement: commitResult.replacementState };
}

function translate(value) {
  return translateNpcReactionCommitReplacementToAuthorizedDelta({
    currentProjection: value.current,
    replacementProjection: value.replacement,
    preparedReaction: value.fixture.preparedReaction
  });
}

function cloneCommitted(proposals) {
  const value = committedFixture(proposals);
  return {
    fixture: structuredClone(value.fixture),
    current: structuredClone(value.current),
    replacement: structuredClone(value.replacement)
  };
}

function deepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) deepFrozen(child, seen);
  return true;
}

test("production module exposes exactly six closed browser-safe exports", async () => {
  const module = await import("../src/npcReactionAuthorityTranslation.mjs");
  assert.deepEqual(Object.keys(module).sort(), [
    "NPC_REACTION_AUTHORITY_TRANSLATION_INVARIANT_CODES",
    "NpcReactionAuthorityTranslationInvariantError",
    "buildNpcReactionCommitTransactionProjection",
    "translateNpcReactionCommitReplacementToAuthorizedDelta",
    "validateNpcReactionAuthorizedDelta",
    "validateNpcReactionCommitTransactionProjection"
  ].sort());
  assert.equal(Object.hasOwn(module, "default"), false);
  assert.equal(Object.isFrozen(NPC_REACTION_AUTHORITY_TRANSLATION_INVARIANT_CODES), true);
  assert.equal(NPC_REACTION_AUTHORITY_TRANSLATION_INVARIANT_CODES.length, 13);
  assert.equal(new Set(NPC_REACTION_AUTHORITY_TRANSLATION_INVARIANT_CODES).size, 13);
  for (const code of NPC_REACTION_AUTHORITY_TRANSLATION_INVARIANT_CODES) {
    const error = new NpcReactionAuthorityTranslationInvariantError(code);
    assert.equal(error.code, code);
    assert.equal(error.message, "Invalid NPC reaction authority translation.");
    assert.deepEqual(Object.keys(error), []);
  }
  assert.equal(new NpcReactionAuthorityTranslationInvariantError("unknown").code,
    "invalid_npc_reaction_authority_translation_input");
});

test("fresh WerewolfGame projects exact minimum Commit shape without mutation", () => {
  const instance = game();
  const before = structuredClone(instance.state);
  const projection = buildNpcReactionCommitTransactionProjection(instance.state);
  assert.deepEqual(Object.keys(projection), PROJECTION_FIELDS);
  assert.deepEqual(Object.keys(projection.conversation), CONVERSATION_FIELDS);
  assert.equal(validateNpcReactionCommitTransactionProjection(projection), undefined);
  assert.deepEqual(structuredClone(instance.state), before);
  assert.notEqual(projection, instance.state);
  assert.notEqual(projection.players, instance.state.players);
  assert.notEqual(projection.conversation, instance.state.conversation);
  for (const field of CONVERSATION_FIELDS.filter((field) => Array.isArray(projection.conversation[field]))) {
    assert.notEqual(projection.conversation[field], instance.state.conversation[field]);
  }
  deepFrozen(projection);
});

test("participant mapping is deterministic, ordered, winner-aware, and privacy-minimal", () => {
  const fixture = createAuthorityTranslationFixture();
  fixture.gameState.players[0].alive = false;
  const privateMarker = "private-role-team-known-memory-policy-marker";
  for (const field of [
    "name", "aliases", "personality", "speechStyle", "role", "team", "knownInfo",
    "hiddenInfo", "suspicionScores", "publicClaims", "privateMemory", "voteHistory",
    "conversationPolicy"
  ]) fixture.gameState.players[1][field] = Array.isArray(fixture.gameState.players[1][field])
    ? [privateMarker]
    : privateMarker;
  const active = buildNpcReactionCommitTransactionProjection(fixture.gameState);
  assert.deepEqual(active.players, [
    { participantId: "player", participantClass: "player", alive: true, maySpeak: true },
    { participantId: "npc-aoi", participantClass: "npc", alive: false, maySpeak: false },
    { participantId: "npc-beni", participantClass: "npc", alive: true, maySpeak: true }
  ]);
  assert.equal(JSON.stringify(active).includes(privateMarker), false);
  assert.equal(JSON.stringify(active).includes("role"), false);

  fixture.gameState.winner = "village";
  const finished = buildNpcReactionCommitTransactionProjection(fixture.gameState);
  assert.equal(finished.players.every((participant) => participant.maySpeak === false), true);
  assert.equal(finished.players[0].alive, true);
});

test("projection is detached from later source changes and recursively immutable", () => {
  const fixture = createAuthorityTranslationFixture();
  const projection = buildNpcReactionCommitTransactionProjection(fixture.gameState);
  const before = canonicalJson(projection);
  fixture.gameState.players[0].alive = false;
  fixture.gameState.conversation.inputRecords[0].rawText = "changed";
  assert.equal(canonicalJson(projection), before);
  assert.throws(() => { projection.players[1].alive = false; }, TypeError);
  assert.throws(() => { projection.conversation.inputRecords.push({}); }, TypeError);
  assert.equal(canonicalJson(projection), before);
});

test("participant input rejects missing, malformed, duplicate, reserved, accessor, symbol, and bounds", () => {
  const vectors = [
    (state) => { delete state.players; },
    (state) => { state.players = null; },
    (state) => { state.players.length = 3; },
    (state) => { state.players = []; },
    (state) => { state.players = Array.from({ length: 16 }, (_, index) => ({ id: `npc-${index}`, alive: true })); },
    (state) => { state.players[0] = "npc"; },
    (state) => { delete state.players[0].id; },
    (state) => { state.players[0].id = "bad id"; },
    (state) => { state.players[1].id = state.players[0].id; },
    (state) => { state.players[0].id = "player"; },
    (state) => { delete state.players[0].alive; },
    (state) => { state.players[0].alive = 1; },
    (state) => { Object.defineProperty(state.players[0], "id", { enumerable: true, get() { throw new Error("getter"); } }); },
    (state) => { Object.defineProperty(state.players[0], "alive", { enumerable: true, get() { throw new Error("getter"); } }); },
    (state) => { state.players[0][Symbol("private")] = true; },
    (state) => { Object.setPrototypeOf(state.players[0], { private: true }); },
    (state) => { state.winner = "unknown"; }
  ];
  for (const change of vectors) {
    const fixture = createAuthorityTranslationFixture();
    change(fixture.gameState);
    assertInvariant(
      () => buildNpcReactionCommitTransactionProjection(fixture.gameState),
      ["invalid_npc_reaction_game_state", "invalid_npc_reaction_participant_projection",
        "npc_reaction_projection_identity_conflict"].find((code) => {
        try { buildNpcReactionCommitTransactionProjection(fixture.gameState); } catch (error) { return error.code === code; }
        return false;
      })
    );
  }
});

test("game-state required properties reject accessors without invocation", () => {
  for (const field of ["gameSessionId", "turnId", "turnOrder", "stateVersion", "phase", "players", "winner", "conversation"]) {
    const fixture = createAuthorityTranslationFixture();
    let calls = 0;
    Object.defineProperty(fixture.gameState, field, {
      configurable: true,
      enumerable: true,
      get() { calls += 1; throw new Error("private getter"); }
    });
    assertInvariant(
      () => buildNpcReactionCommitTransactionProjection(fixture.gameState),
      "invalid_npc_reaction_game_state"
    );
    assert.equal(calls, 0);
  }
});

test("projection validator rejects exactness, sparse, counter, phase, and alias attacks", () => {
  const base = buildNpcReactionCommitTransactionProjection(createAuthorityTranslationFixture().gameState);
  const vectors = [
    ["invalid_npc_reaction_commit_projection", (value) => { value.extra = true; }],
    ["invalid_npc_reaction_commit_projection", (value) => { delete value.turnId; }],
    ["invalid_npc_reaction_commit_projection", (value) => { value[Symbol("private")] = true; }],
    ["invalid_npc_reaction_commit_projection", (value) => { Object.defineProperty(value, "phase", { enumerable: true, get() { throw new Error("getter"); } }); }],
    ["invalid_npc_reaction_commit_projection", (value) => { value.phase = "unknown"; }],
    ["invalid_npc_reaction_commit_projection", (value) => { value.conversation.legacy = []; }],
    ["invalid_npc_reaction_commit_projection", (value) => { delete value.conversation.events; }],
    ["invalid_npc_reaction_commit_projection", (value) => { value.conversation.events.length += 1; }],
    ["invalid_npc_reaction_commit_projection", (value) => { value.conversation.nextCreatedOrder = -1; }],
    ["npc_reaction_projection_alias_detected", (value) => { value.conversation.claims = value.conversation.events; }],
    ["npc_reaction_projection_alias_detected", (value) => { value.conversation.events = value.players; }]
  ];
  for (const [code, change] of vectors) {
    const value = structuredClone(base);
    change(value);
    assertInvariant(() => validateNpcReactionCommitTransactionProjection(value), code);
  }
});

test("translator accepts only exact wrapper and non-aliased projections", () => {
  const value = cloneCommitted();
  const valid = {
    currentProjection: value.current,
    replacementProjection: value.replacement,
    preparedReaction: value.fixture.preparedReaction
  };
  assertInvariant(
    () => translateNpcReactionCommitReplacementToAuthorizedDelta({ ...valid, extra: true }),
    "invalid_npc_reaction_authority_translation_input"
  );
  assertInvariant(
    () => translateNpcReactionCommitReplacementToAuthorizedDelta({
      ...valid,
      replacementProjection: valid.currentProjection
    }),
    "npc_reaction_projection_alias_detected"
  );
  const conversationAlias = cloneCommitted();
  conversationAlias.replacement.conversation = conversationAlias.current.conversation;
  assertInvariant(() => translate(conversationAlias), "npc_reaction_projection_alias_detected");
});

test("prepared fingerprint and strict shape fail closed for every fingerprint owner", () => {
  const vectors = [
    ["npc_reaction_projection_fingerprint_mismatch", (prepared) => { prepared.preparationFingerprint = "d".repeat(64); }],
    ["npc_reaction_projection_fingerprint_mismatch", (prepared) => { prepared.delta.preparationFingerprint = "d".repeat(64); }],
    ["npc_reaction_projection_fingerprint_mismatch", (prepared) => { prepared.delta.idempotencyReservation.preparationFingerprint = "d".repeat(64); }],
    ["invalid_npc_reaction_prepared_reaction", (prepared) => { prepared.extra = true; }],
    ["invalid_npc_reaction_prepared_reaction", (prepared) => { prepared[Symbol("private")] = true; }],
    ["invalid_npc_reaction_prepared_reaction", (prepared) => { Object.defineProperty(prepared, "delta", { enumerable: true, get() { throw new Error("getter"); } }); }],
    ["npc_reaction_projection_fingerprint_mismatch", (prepared) => { prepared.delta.plan.maxChars -= 1; }],
    ["npc_reaction_projection_fingerprint_mismatch", (prepared) => { prepared.delta.events[0].createdOrder += 1; }]
  ];
  for (const [code, change] of vectors) {
    const value = cloneCommitted();
    change(value.fixture.preparedReaction);
    assertInvariant(() => translate(value), code);
  }
});

test("self-consistent invalid artifact allocation remains invalid after fingerprint refresh", () => {
  const vectors = [
    [undefined, (delta) => { delta.artifactAllocation.schemaVersion = 2; }],
    [undefined, (delta) => { delta.artifactAllocation.allocationType = "forged"; }],
    [undefined, (delta) => { delta.artifactAllocation.descriptorIds[0] = "other-descriptor"; }],
    [undefined, (delta) => { delta.artifactAllocation.eventIds[0] = "other-event"; }],
    [undefined, (delta) => { delta.artifactAllocation.segmentIds[0] = "other-segment"; }],
    [undefined, (delta) => { delta.artifactAllocation.descriptorIds.pop(); }],
    [undefined, (delta) => { delta.artifactAllocation.eventIds.push("extra-event"); }],
    [undefined, (delta) => { delta.artifactAllocation.segmentIds.push("extra-segment"); }],
    [[{ proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" }],
      (delta) => { delta.artifactAllocation.claimAllocations[0].proposalIndex = 1; }],
    [[{ proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" }],
      (delta) => { delta.artifactAllocation.claimAllocations[0].claimId = "other-claim"; }],
    [[{ proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" }],
      (delta) => { delta.artifactAllocation.claimAllocations.pop(); }],
    [undefined, (delta) => {
      delta.artifactAllocation.eventIds[0] = delta.artifactAllocation.descriptorIds[0];
    }]
  ];
  for (const [proposals, change] of vectors) {
    const value = cloneCommitted(proposals);
    change(value.fixture.preparedReaction.delta);
    refreshPreparedReaction(value.fixture.preparedReaction);
    assertInvariant(() => translate(value), "invalid_npc_reaction_prepared_reaction");
  }
});

test("self-consistent invalid order and idempotency reservations remain invalid after fingerprint refresh", () => {
  const vectors = [
    (delta) => { delta.orderReservation.schemaVersion = 2; },
    (delta) => { delta.orderReservation.reservationType = "forged"; },
    (delta) => { delta.idempotencyReservation.schemaVersion = 2; },
    (delta) => { delta.orderReservation.eventCreatedOrders.pop(); },
    (delta) => { delta.orderReservation.eventCreatedOrders[0] += 1; },
    (delta) => { delta.orderReservation.commitResultCreatedAtOrder += 1; },
    (delta) => { delta.orderReservation.resultingNextCreatedOrder += 1; },
    (delta) => { delta.orderReservation.publicationSlotOrder += 1; },
    (delta) => { delta.orderReservation.resultingNextPublicationSlotOrder += 1; },
    (delta) => { delta.orderReservation.publicationRecordAppendOrder += 1; },
    (delta) => { delta.orderReservation.resultingNextRecordAppendOrder += 1; }
  ];
  for (const change of vectors) {
    const value = cloneCommitted();
    change(value.fixture.preparedReaction.delta);
    refreshPreparedReaction(value.fixture.preparedReaction);
    assertInvariant(() => translate(value), "invalid_npc_reaction_prepared_reaction");
  }
});

test("precondition, version, phase, participant and top-level changes are forbidden", () => {
  const vectors = [
    ["invalid_npc_reaction_prepared_reaction", (value) => { value.fixture.preparedReaction.delta.binding.gameSessionId = "other-session"; refreshPreparedReaction(value.fixture.preparedReaction); }],
    ["npc_reaction_projection_counter_mismatch", (value) => { value.replacement.stateVersion = value.current.stateVersion; }],
    ["npc_reaction_projection_counter_mismatch", (value) => { value.replacement.stateVersion += 1; }],
    ["npc_reaction_projection_forbidden_delta", (value) => { value.replacement.gameSessionId = "other-session"; }],
    ["npc_reaction_projection_forbidden_delta", (value) => { value.replacement.turnId = "other-turn"; }],
    ["npc_reaction_projection_forbidden_delta", (value) => { value.replacement.turnOrder += 1; }],
    ["npc_reaction_projection_forbidden_delta", (value) => { value.replacement.phase = "night"; }],
    ["invalid_npc_reaction_replacement_projection", (value) => { value.replacement.players.reverse(); }],
    ["npc_reaction_projection_forbidden_delta", (value) => { value.replacement.players[1].alive = false; }],
    ["npc_reaction_projection_forbidden_delta", (value) => { value.replacement.players[1].maySpeak = false; }],
    ["npc_reaction_projection_forbidden_delta", (value) => { value.replacement.players.push({ participantId: "npc-extra", participantClass: "npc", alive: true, maySpeak: true }); }]
  ];
  for (const [code, change] of vectors) {
    const value = cloneCommitted();
    change(value);
    assertInvariant(() => translate(value), code);
  }
});

test("non-delta conversation fields reject every appended value", () => {
  for (const field of ["inputRecords", "acceptedSpeechActs", "displayPlans"]) {
    const value = cloneCommitted();
    value.replacement.conversation[field].push({ forbidden: true });
    assertInvariant(() => translate(value), "npc_reaction_projection_forbidden_delta");
  }
});

test("each allowed registry enforces exact append count, value, order, and preserved prefix", () => {
  const fields = ["reactionPlans", "claims", "events", "publications", "npcReactionCommitIdempotencyRecords", "commitResults"];
  for (const field of fields) {
    for (const change of [
      (value, currentLength) => { value.splice(currentLength); },
      (value) => { value.push(structuredClone(value.at(-1))); },
      (value, currentLength) => { value[currentLength] = { ...value[currentLength], extra: true }; }
    ]) {
      const fixture = field === "claims"
        ? cloneCommitted([{ proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" }])
        : cloneCommitted();
      const array = fixture.replacement.conversation[field];
      change(array, fixture.current.conversation[field].length);
      assert.throws(() => translate(fixture), NpcReactionAuthorityTranslationInvariantError);
    }
  }
});

test("existing prefixes reject nested mutation, replacement, reorder, deletion, and middle insertion", () => {
  const first = committedFixture();
  const nextFixture = createAuthorityTranslationFixture();
  nextFixture.gameState.conversation = {
    ...nextFixture.gameState.conversation,
    reactionPlans: structuredClone(first.replacement.conversation.reactionPlans),
    claims: structuredClone(first.replacement.conversation.claims),
    events: structuredClone(first.replacement.conversation.events),
    publications: structuredClone(first.replacement.conversation.publications),
    commitResults: structuredClone(first.replacement.conversation.commitResults),
    npcReactionCommitIdempotencyRecords: structuredClone(first.replacement.conversation.npcReactionCommitIdempotencyRecords),
    nextCreatedOrder: first.replacement.conversation.nextCreatedOrder,
    nextPublicationSlotOrder: first.replacement.conversation.nextPublicationSlotOrder,
    nextRecordAppendOrder: first.replacement.conversation.nextRecordAppendOrder
  };
  // The reused logical identity is intentionally not committed again; this test only fixes prefix validation
  // using a synthetically appended replacement derived from a known valid transaction.
  for (const field of ["reactionPlans", "events", "publications", "commitResults", "npcReactionCommitIdempotencyRecords"]) {
    const value = cloneCommitted();
    const prefix = structuredClone(first.replacement.conversation[field]);
    value.current.conversation[field] = prefix;
    value.replacement.conversation[field] = [
      ...structuredClone(prefix),
      ...structuredClone(value.replacement.conversation[field])
    ];
    if (field === "publications") {
      value.current.conversation.nextPublicationSlotOrder = 2;
      value.current.conversation.nextRecordAppendOrder = 2;
    }
    value.current.conversation[field][0] = { ...value.current.conversation[field][0], extra: true };
    assert.throws(() => translate(value), NpcReactionAuthorityTranslationInvariantError);
  }
});

test("counter transitions reject wrong initial, resulting, dense publication, and unsafe values", () => {
  const vectors = [
    (value) => { value.replacement.conversation.nextCreatedOrder -= 1; },
    (value) => { value.replacement.conversation.nextPublicationSlotOrder -= 1; },
    (value) => { value.replacement.conversation.nextPublicationSlotOrder += 1; },
    (value) => { value.replacement.conversation.nextRecordAppendOrder -= 1; },
    (value) => { value.replacement.conversation.nextRecordAppendOrder += 1; },
    (value) => { value.replacement.conversation.nextCreatedOrder = -1; },
    (value) => { value.replacement.conversation.nextCreatedOrder = 0.5; },
    (value) => { value.replacement.conversation.nextCreatedOrder = Number.NaN; },
    (value) => { value.replacement.conversation.nextCreatedOrder = Number.POSITIVE_INFINITY; },
    (value) => { value.replacement.conversation.nextCreatedOrder = Number.MAX_SAFE_INTEGER + 1; },
    (value) => { value.replacement.conversation.publications.at(-1).recordAppendOrder += 1; }
  ];
  for (const change of vectors) {
    const value = cloneCommitted();
    change(value);
    assert.throws(() => translate(value), NpcReactionAuthorityTranslationInvariantError);
  }
});

test("idempotency record requires every exact deterministic field", () => {
  const valid = cloneCommitted();
  const record = valid.replacement.conversation.npcReactionCommitIdempotencyRecords[0];
  for (const field of Object.keys(record)) {
    const value = cloneCommitted();
    const changed = value.replacement.conversation.npcReactionCommitIdempotencyRecords[0];
    changed[field] = typeof changed[field] === "number" ? changed[field] + 1 : "changed";
    assert.throws(() => translate(value), NpcReactionAuthorityTranslationInvariantError, field);
  }
  for (const change of [
    (value) => { delete value.schemaVersion; },
    (value) => { value.extra = true; },
    (value) => { value[Symbol("private")] = true; },
    (value) => { Object.defineProperty(value, "requestId", { enumerable: true, get() { throw new Error("getter"); } }); }
  ]) {
    const value = cloneCommitted();
    change(value.replacement.conversation.npcReactionCommitIdempotencyRecords[0]);
    assert.throws(() => translate(value), NpcReactionAuthorityTranslationInvariantError);
  }
});

test("authorized delta validator accepts exact output and rejects shape, counts, aliases, and identity links", () => {
  const delta = translate(cloneCommitted());
  assert.equal(delta.precondition.phase, "player_question");
  assert.equal(delta.resultingPhase, "day_discussion");
  assert.equal(validateNpcReactionAuthorizedDelta(delta), undefined);
  const vectors = [
    (value) => { delete value.precondition; },
    (value) => { value.extra = true; },
    (value) => { value[Symbol("private")] = true; },
    (value) => { Object.defineProperty(value, "appends", { enumerable: true, get() { throw new Error("getter"); } }); },
    (value) => { value.schemaVersion = 2; },
    (value) => { value.deltaType = "other"; },
    (value) => { value.resultingPhase = "player_question"; },
    (value) => { value.resultingStateVersion += 1; },
    (value) => { value.appends.reactionPlans = []; },
    (value) => { value.appends.events.length += 1; },
    (value) => { value.appends.claims = value.appends.events; },
    (value) => { value.counters.nextCreatedOrder = -1; },
    (value) => { value.appends.npcReactionCommitIdempotencyRecords[0].reactionPlanId = "other-plan"; }
  ];
  for (const change of vectors) {
    const value = structuredClone(delta);
    change(value);
    assert.throws(() => validateNpcReactionAuthorizedDelta(value), NpcReactionAuthorityTranslationInvariantError);
  }
});

test("authorized delta validator rejects valid-shaped cross-record graph mismatches", () => {
  const ordinary = translate(cloneCommitted());
  const claimProducing = translate(cloneCommitted([
    { proposalType: "result_claim", targetId: "npc-beni", result: "werewolf" }
  ]));
  const vectors = [
    [ordinary, (value) => { value.appends.events[0].eventId = "other-event"; }],
    [ordinary, (value) => { value.appends.commitResults[0].createdEventIds[0] = "other-event"; }],
    [ordinary, (value) => { value.appends.reactionPlans[0].canonicalSegments[0].suspicionEventId = "other-event"; }],
    [claimProducing, (value) => { value.appends.claims[0].claimId = "other-claim"; }],
    [claimProducing, (value) => { value.appends.commitResults[0].createdClaimIds[0] = "other-claim"; }],
    [claimProducing, (value) => { value.appends.reactionPlans[0].canonicalSegments[0].claimId = "other-claim"; }],
    [ordinary, (value) => { value.counters.nextCreatedOrder += 1; }],
    [ordinary, (value) => { value.counters.nextPublicationSlotOrder += 1; }],
    [ordinary, (value) => { value.counters.nextRecordAppendOrder += 1; }]
  ];
  for (const [source, change] of vectors) {
    const value = structuredClone(source);
    change(value);
    assertInvariant(() => validateNpcReactionAuthorizedDelta(value),
      "invalid_npc_reaction_authorized_delta");
  }
});

test("translator returns no input aliases and leaves all sources byte-equivalent", () => {
  const value = cloneCommitted();
  const before = {
    current: canonicalJson(value.current),
    replacement: canonicalJson(value.replacement),
    prepared: canonicalJson(value.fixture.preparedReaction)
  };
  const delta = translate(value);
  assert.equal(canonicalJson(value.current), before.current);
  assert.equal(canonicalJson(value.replacement), before.replacement);
  assert.equal(canonicalJson(value.fixture.preparedReaction), before.prepared);
  for (const field of APPEND_FIELDS) {
    assert.notEqual(delta.appends[field], value.replacement.conversation[field]);
    delta.appends[field].forEach((item) => {
      assert.equal(value.replacement.conversation[field].includes(item), false);
      assert.equal(value.fixture.preparedReaction.delta[field]?.includes?.(item) ?? false, false);
    });
  }
  deepFrozen(delta);
});

test("cycles, custom prototypes, non-enumerable and nested alias inputs fail closed", () => {
  const cycle = cloneCommitted();
  cycle.fixture.preparedReaction.delta.effects.self = cycle.fixture.preparedReaction.delta.effects;
  assert.throws(() => translate(cycle), NpcReactionAuthorityTranslationInvariantError);

  const custom = cloneCommitted();
  Object.setPrototypeOf(custom.current.players[1], { private: true });
  assertInvariant(() => translate(custom), "invalid_npc_reaction_commit_projection");

  const hidden = cloneCommitted();
  Object.defineProperty(hidden.fixture.preparedReaction, "hidden", { value: true, enumerable: false });
  assertInvariant(() => translate(hidden), "invalid_npc_reaction_prepared_reaction");

  const alias = structuredClone(translate(cloneCommitted()));
  alias.appends.events[0].source = alias.appends.reactionPlans[0].policies;
  assertInvariant(() => validateNpcReactionAuthorizedDelta(alias), "npc_reaction_projection_alias_detected");
});
