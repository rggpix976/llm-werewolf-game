import assert from "node:assert/strict";
import test from "node:test";

import { validateCommittedConversationGraph } from "../src/conversation/references.mjs";
import { WerewolfGame } from "../src/gameEngine.mjs";
import {
  NPC_AUTHORITATIVE_STATE_FOUNDATION_INVARIANT_CODES,
  NpcAuthoritativeStateFoundationInvariantError,
  createNpcAuthoritativeConversationRegistries,
  validateNpcAuthoritativeStateFoundation
} from "../src/npcAuthoritativeStateFoundation.mjs";

const CONVERSATION_FIELDS = [
  "inputRecords", "acceptedSpeechActs", "claims", "events", "displayPlans",
  "reactionPlans", "publications", "playerLegacyDisplayCompatibilityRecords",
  "commitResults", "idempotencyRecords", "npcReactionCommitIdempotencyRecords",
  "nextCreatedOrder", "nextPublicationSlotOrder", "nextRecordAppendOrder"
];
const ARRAY_FIELDS = CONVERSATION_FIELDS.slice(0, 11);
const COUNTER_FIELDS = CONVERSATION_FIELDS.slice(11);

function ids(prefix = "foundation") {
  let order = 0;
  return () => `${prefix}-${++order}`;
}

function createGame(options = {}) {
  return WerewolfGame.create({
    seed: 1,
    scenario: "sample",
    shuffleRoles: false,
    createId: ids(),
    ...options
  });
}

function detachedState(game = createGame()) {
  const { rng, ...plain } = game.state;
  return { ...structuredClone(plain), rng };
}

function assertFoundationError(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof NpcAuthoritativeStateFoundationInvariantError);
    assert.equal(error.code, code);
    assert.equal(error.message, "Invalid NPC authoritative state foundation.");
    assert.deepEqual(Object.keys(error), []);
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  });
}

function assertFreshFoundation(conversation) {
  assert.deepEqual(Object.keys(conversation), CONVERSATION_FIELDS);
  assert.deepEqual(conversation.reactionPlans, []);
  assert.deepEqual(conversation.npcReactionCommitIdempotencyRecords, []);
  assert.equal(new Set(ARRAY_FIELDS.map((field) => conversation[field])).size, ARRAY_FIELDS.length);
  assert.deepEqual(COUNTER_FIELDS.map((field) => conversation[field]), [0, 0, 0]);
}

test("foundation module exposes exactly four browser-safe production exports", async () => {
  const module = await import("../src/npcAuthoritativeStateFoundation.mjs");
  assert.deepEqual(Object.keys(module).sort(), [
    "NPC_AUTHORITATIVE_STATE_FOUNDATION_INVARIANT_CODES",
    "NpcAuthoritativeStateFoundationInvariantError",
    "createNpcAuthoritativeConversationRegistries",
    "validateNpcAuthoritativeStateFoundation"
  ]);
  assert.equal(Object.hasOwn(module, "default"), false);
  assert.equal(Object.isFrozen(NPC_AUTHORITATIVE_STATE_FOUNDATION_INVARIANT_CODES), true);
  assert.deepEqual(NPC_AUTHORITATIVE_STATE_FOUNDATION_INVARIANT_CODES, [
    "invalid_npc_authoritative_state_foundation",
    "invalid_npc_authoritative_conversation_foundation",
    "invalid_npc_reaction_plans_registry",
    "invalid_npc_commit_idempotency_registry",
    "aliased_npc_authoritative_registry"
  ]);
  const error = new NpcAuthoritativeStateFoundationInvariantError("unknown");
  assert.equal(error.name, "NpcAuthoritativeStateFoundationInvariantError");
  assert.equal(error.code, "invalid_npc_authoritative_state_foundation");
  assert.equal(error.message, "Invalid NPC authoritative state foundation.");
  assert.deepEqual(Object.keys(error), []);
  assert.equal(Object.hasOwn(error, "cause"), false);
});

test("registry factory creates exact mutable non-aliased containers on every call", () => {
  const first = createNpcAuthoritativeConversationRegistries();
  const second = createNpcAuthoritativeConversationRegistries();
  assert.deepEqual(Reflect.ownKeys(first), ["reactionPlans", "npcReactionCommitIdempotencyRecords"]);
  assert.deepEqual(first, { reactionPlans: [], npcReactionCommitIdempotencyRecords: [] });
  assert.notEqual(first, second);
  assert.notEqual(first.reactionPlans, first.npcReactionCommitIdempotencyRecords);
  assert.notEqual(first.reactionPlans, second.reactionPlans);
  assert.notEqual(first.npcReactionCommitIdempotencyRecords, second.npcReactionCommitIdempotencyRecords);
  first.reactionPlans.push({ test: true });
  first.npcReactionCommitIdempotencyRecords.push({ test: true });
  assert.equal(first.reactionPlans.length, 1);
  assert.equal(first.npcReactionCommitIdempotencyRecords.length, 1);
  for (const field of Reflect.ownKeys(first)) {
    const descriptor = Object.getOwnPropertyDescriptor(first, field);
    assert.equal(descriptor.enumerable, true);
    assert.equal(Object.hasOwn(descriptor, "value"), true);
  }
});

test("every new game option mode receives the same exact empty canonical foundation", () => {
  const modes = [
    {},
    { seed: 77 },
    { scenario: "sample" },
    { playerConversationCommitEnabled: false },
    { interpreterValidationEnabled: true, playerConversationCommitEnabled: true },
    { npcStructuredReactionEnabled: false },
    {
      interpreterValidationEnabled: true,
      playerConversationCommitEnabled: true,
      npcStructuredReactionEnabled: true
    }
  ];
  for (const options of modes) {
    const game = createGame(options);
    assertFreshFoundation(game.state.conversation);
    assert.equal(game.state.stateVersion, 0);
    assert.equal(validateNpcAuthoritativeStateFoundation(game.state), undefined);
  }
});

test("new sessions never reuse canonical registry arrays", () => {
  const first = createGame();
  const second = createGame({ createId: ids("second") });
  assert.notEqual(first.state.conversation.reactionPlans, second.state.conversation.reactionPlans);
  assert.notEqual(
    first.state.conversation.npcReactionCommitIdempotencyRecords,
    second.state.conversation.npcReactionCommitIdempotencyRecords
  );
  assert.notEqual(first.state.gameSessionId, second.state.gameSessionId);
});

test("validator accepts fresh, working-copy, cloned, dense, and maximum-safe-counter foundations without mutation", () => {
  const game = createGame();
  const before = structuredClone(game.state.conversation);
  assert.equal(validateNpcAuthoritativeStateFoundation(game.state), undefined);
  assert.deepEqual(game.state.conversation, before);

  const working = game._workingCopy();
  assert.equal(validateNpcAuthoritativeStateFoundation(working.state), undefined);
  assert.equal(working.state.stateVersion, game.state.stateVersion);
  assert.equal(working.state.turnId, game.state.turnId);
  assert.equal(working.state.gameSessionId, game.state.gameSessionId);

  const clone = detachedState(game);
  for (const field of COUNTER_FIELDS) clone.conversation[field] = Number.MAX_SAFE_INTEGER;
  assert.equal(validateNpcAuthoritativeStateFoundation(clone), undefined);
});

test("invalid state and conversation boundaries fail closed without mutation", () => {
  const validConversation = detachedState().conversation;
  const inherited = Object.create({ conversation: validConversation });
  const cases = [
    [null, "invalid_npc_authoritative_state_foundation"],
    [[], "invalid_npc_authoritative_state_foundation"],
    [{}, "invalid_npc_authoritative_state_foundation"],
    [inherited, "invalid_npc_authoritative_state_foundation"],
    [{ conversation: null }, "invalid_npc_authoritative_state_foundation"],
    [{ conversation: [] }, "invalid_npc_authoritative_state_foundation"]
  ];
  for (const [state, code] of cases) assertFoundationError(() => validateNpcAuthoritativeStateFoundation(state), code);
});

test("missing and malformed reaction plan registries use the closed registry error", () => {
  const values = [undefined, null, {}, "bad", new Uint8Array(), (() => { const value = []; value.length = 1; return value; })()];
  for (const value of values) {
    const state = detachedState();
    if (value === undefined) delete state.conversation.reactionPlans;
    else state.conversation.reactionPlans = value;
    const beforeKeys = Reflect.ownKeys(state.conversation);
    assertFoundationError(
      () => validateNpcAuthoritativeStateFoundation(state),
      "invalid_npc_reaction_plans_registry"
    );
    assert.deepEqual(Reflect.ownKeys(state.conversation), beforeKeys);
    if (value === undefined) assert.equal(Object.hasOwn(state.conversation, "reactionPlans"), false);
  }
});

test("missing and malformed NPC idempotency registries use the closed registry error", () => {
  const values = [undefined, null, {}, "bad", new Uint8Array(), (() => { const value = []; value.length = 1; return value; })()];
  for (const value of values) {
    const state = detachedState();
    if (value === undefined) delete state.conversation.npcReactionCommitIdempotencyRecords;
    else state.conversation.npcReactionCommitIdempotencyRecords = value;
    assertFoundationError(
      () => validateNpcAuthoritativeStateFoundation(state),
      "invalid_npc_commit_idempotency_registry"
    );
    if (value === undefined) assert.equal(Object.hasOwn(state.conversation, "npcReactionCommitIdempotencyRecords"), false);
  }
});

test("conversation exact field and property attacks fail closed without invoking accessors", () => {
  const conversationGetterState = {};
  let conversationReads = 0;
  Object.defineProperty(conversationGetterState, "conversation", {
    enumerable: true,
    get() { conversationReads += 1; return detachedState().conversation; }
  });
  assertFoundationError(
    () => validateNpcAuthoritativeStateFoundation(conversationGetterState),
    "invalid_npc_authoritative_state_foundation"
  );
  assert.equal(conversationReads, 0);

  const registryAccessor = detachedState();
  let registryReads = 0;
  Object.defineProperty(registryAccessor.conversation, "reactionPlans", {
    configurable: true,
    enumerable: true,
    get() { registryReads += 1; return []; }
  });
  assertFoundationError(
    () => validateNpcAuthoritativeStateFoundation(registryAccessor),
    "invalid_npc_reaction_plans_registry"
  );
  assert.equal(registryReads, 0);

  const symbolState = detachedState();
  symbolState.conversation[Symbol("private")] = [];
  assertFoundationError(
    () => validateNpcAuthoritativeStateFoundation(symbolState),
    "invalid_npc_authoritative_conversation_foundation"
  );

  const unknownState = detachedState();
  unknownState.conversation.unknown = [];
  assertFoundationError(
    () => validateNpcAuthoritativeStateFoundation(unknownState),
    "invalid_npc_authoritative_conversation_foundation"
  );

  const nonEnumerable = detachedState();
  Object.defineProperty(nonEnumerable.conversation, "npcReactionCommitIdempotencyRecords", {
    configurable: true,
    enumerable: false,
    value: [],
    writable: true
  });
  assertFoundationError(
    () => validateNpcAuthoritativeStateFoundation(nonEnumerable),
    "invalid_npc_commit_idempotency_registry"
  );

  const inheritedField = detachedState();
  const inheritedClaims = inheritedField.conversation.claims;
  delete inheritedField.conversation.claims;
  Object.setPrototypeOf(inheritedField.conversation, { claims: inheritedClaims });
  assertFoundationError(
    () => validateNpcAuthoritativeStateFoundation(inheritedField),
    "invalid_npc_authoritative_conversation_foundation"
  );
});

test("all canonical conversation arrays must be dense and pairwise non-aliased", () => {
  for (const field of ARRAY_FIELDS.filter((field) => !["reactionPlans", "npcReactionCommitIdempotencyRecords"].includes(field))) {
    const sparse = detachedState();
    sparse.conversation[field].length = 1;
    assertFoundationError(
      () => validateNpcAuthoritativeStateFoundation(sparse),
      "invalid_npc_authoritative_conversation_foundation"
    );
  }
  for (let index = 1; index < ARRAY_FIELDS.length; index += 1) {
    const state = detachedState();
    state.conversation[ARRAY_FIELDS[index]] = state.conversation[ARRAY_FIELDS[0]];
    assertFoundationError(
      () => validateNpcAuthoritativeStateFoundation(state),
      "aliased_npc_authoritative_registry"
    );
  }
  for (const [left, right] of [
    ["reactionPlans", "npcReactionCommitIdempotencyRecords"],
    ["reactionPlans", "claims"],
    ["reactionPlans", "events"],
    ["reactionPlans", "publications"],
    ["reactionPlans", "idempotencyRecords"],
    ["npcReactionCommitIdempotencyRecords", "claims"],
    ["npcReactionCommitIdempotencyRecords", "events"],
    ["npcReactionCommitIdempotencyRecords", "publications"],
    ["npcReactionCommitIdempotencyRecords", "idempotencyRecords"]
  ]) {
    const state = detachedState();
    state.conversation[right] = state.conversation[left];
    assertFoundationError(
      () => validateNpcAuthoritativeStateFoundation(state),
      "aliased_npc_authoritative_registry"
    );
  }
});

test("all canonical counters enforce the existing non-negative safe-integer boundary", () => {
  const invalidValues = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "0", null];
  for (const field of COUNTER_FIELDS) {
    for (const value of invalidValues) {
      const state = detachedState();
      state.conversation[field] = value;
      assertFoundationError(
        () => validateNpcAuthoritativeStateFoundation(state),
        "invalid_npc_authoritative_conversation_foundation"
      );
      assert.equal(state.conversation[field], value);
    }
  }
});

test("constructor rejects old-shape state before publication and never lazily inserts registries", () => {
  for (const field of ["reactionPlans", "npcReactionCommitIdempotencyRecords"]) {
    const state = detachedState();
    delete state.conversation[field];
    const before = structuredClone(state.conversation);
    let createIdCalls = 0;
    let observerCalls = 0;
    assertFoundationError(
      () => new WerewolfGame(state, {}, {
        createId() { createIdCalls += 1; return "unexpected-id"; },
        playerStructuredConsumerObserver() { observerCalls += 1; }
      }),
      field === "reactionPlans"
        ? "invalid_npc_reaction_plans_registry"
        : "invalid_npc_commit_idempotency_registry"
    );
    assert.deepEqual(state.conversation, before);
    assert.equal(Object.hasOwn(state.conversation, field), false);
    assert.equal(createIdCalls, 0);
    assert.equal(observerCalls, 0);
    assert.equal(state.stateVersion, 0);
  }
});

test("working copies validate, preserve, and deeply detach the canonical registries", () => {
  const game = createGame();
  game.state.conversation.reactionPlans.push({ nested: { value: 1 } });
  game.state.conversation.npcReactionCommitIdempotencyRecords.push({ nested: { value: 2 } });
  const sourceBefore = structuredClone(game.state.conversation);
  const working = game._workingCopy();
  assert.deepEqual(working.state.conversation, game.state.conversation);
  assert.notEqual(working.state.conversation.reactionPlans, game.state.conversation.reactionPlans);
  assert.notEqual(
    working.state.conversation.npcReactionCommitIdempotencyRecords,
    game.state.conversation.npcReactionCommitIdempotencyRecords
  );
  assert.notEqual(
    working.state.conversation.reactionPlans[0].nested,
    game.state.conversation.reactionPlans[0].nested
  );
  assert.deepEqual(game.state.conversation, sourceBefore);
});

test("working-copy source validation rejects old shape before cloning without mutation", () => {
  const game = createGame();
  delete game.state.conversation.reactionPlans;
  const before = structuredClone(game.state.conversation);
  assertFoundationError(
    () => game._workingCopy(),
    "invalid_npc_reaction_plans_registry"
  );
  assert.deepEqual(game.state.conversation, before);
  assert.equal(Object.hasOwn(game.state.conversation, "reactionPlans"), false);
});

test("compatibility transactions preserve empty registries and baseline version semantics", async () => {
  const game = createGame();
  const version = game.state.stateVersion;
  const result = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc2", input: "hello" });
  assert.equal(result.ok, true);
  assert.equal(game.state.stateVersion, version + 1);
  assertFreshFoundation(game.state.conversation);
});

test("get_state, snapshots, and validation leave authoritative state unchanged and private registries absent", async () => {
  const game = createGame();
  const before = structuredClone(game.state);
  const action = await game.dispatchPlayerAction({ type: "get_state" });
  const publicSnapshot = game.getPublicSnapshot();
  const developerSnapshot = game.getDeveloperSnapshot();
  assert.deepEqual(structuredClone(game.state), before);
  assert.deepEqual(Object.keys(publicSnapshot), [
    "day", "phase", "alivePlayers", "deadPlayers", "winner", "players",
    "publicInfo", "voteHistory", "playerLog"
  ]);
  assert.deepEqual(Object.keys(developerSnapshot), [
    "day", "phase", "alivePlayers", "deadPlayers", "winner", "players"
  ]);
  for (const value of [action.publicSnapshot, publicSnapshot, developerSnapshot]) {
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes("reactionPlans"), false);
    assert.equal(serialized.includes("npcReactionCommitIdempotencyRecords"), false);
    assert.equal(Object.hasOwn(value, "conversation"), false);
  }
});

test("destroy preserves the old authoritative state while a new game receives fresh registries", () => {
  const first = createGame();
  const firstConversation = structuredClone(first.state.conversation);
  const firstReactionPlans = first.state.conversation.reactionPlans;
  const firstIdempotency = first.state.conversation.npcReactionCommitIdempotencyRecords;
  first.destroy();
  first.destroy();
  assert.deepEqual(first.state.conversation, firstConversation);
  assert.equal(first.state.stateVersion, 0);

  const second = createGame({ createId: ids("new-game") });
  assertFreshFoundation(second.state.conversation);
  assert.notEqual(second.state.conversation.reactionPlans, firstReactionPlans);
  assert.notEqual(second.state.conversation.npcReactionCommitIdempotencyRecords, firstIdempotency);
});

test("foundation errors remain fixed and redacted for secret-like invalid input", () => {
  const state = detachedState();
  const secret = "private-role-werewolf-secret";
  state.conversation.reactionPlans = { secret };
  assert.throws(() => validateNpcAuthoritativeStateFoundation(state), (error) => {
    assert.equal(error.message, "Invalid NPC authoritative state foundation.");
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(Object.values(error).some((value) => String(value).includes(secret)), false);
    assert.equal(Object.hasOwn(error, "state"), false);
    assert.equal(Object.hasOwn(error, "conversation"), false);
    assert.equal(Object.hasOwn(error, "record"), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  });
});

test("existing empty Player conversation graph validation remains compatible", () => {
  const game = createGame();
  const graph = {
    ...structuredClone(game.state.conversation),
    gameSessionId: game.state.gameSessionId,
    legacyPlayerLog: structuredClone(game.state.playerLog)
  };
  assert.equal(validateCommittedConversationGraph(graph), true);
  assert.deepEqual(game.state.conversation.reactionPlans, []);
  assert.deepEqual(game.state.conversation.npcReactionCommitIdempotencyRecords, []);
});
