export const NPC_AUTHORITATIVE_STATE_FOUNDATION_INVARIANT_CODES = Object.freeze([
  "invalid_npc_authoritative_state_foundation",
  "invalid_npc_authoritative_conversation_foundation",
  "invalid_npc_reaction_plans_registry",
  "invalid_npc_commit_idempotency_registry",
  "aliased_npc_authoritative_registry"
]);

const DEFAULT_INVARIANT_CODE = "invalid_npc_authoritative_state_foundation";
const ERROR_MESSAGE = "Invalid NPC authoritative state foundation.";
const ARRAY_FIELDS = Object.freeze([
  "inputRecords",
  "acceptedSpeechActs",
  "claims",
  "events",
  "displayPlans",
  "reactionPlans",
  "publications",
  "playerLegacyDisplayCompatibilityRecords",
  "commitResults",
  "idempotencyRecords",
  "npcReactionCommitIdempotencyRecords"
]);
const COUNTER_FIELDS = Object.freeze([
  "nextCreatedOrder",
  "nextPublicationSlotOrder",
  "nextRecordAppendOrder"
]);
const CONVERSATION_FIELDS = Object.freeze([...ARRAY_FIELDS, ...COUNTER_FIELDS]);

export class NpcAuthoritativeStateFoundationInvariantError extends Error {
  constructor(code = DEFAULT_INVARIANT_CODE) {
    super(ERROR_MESSAGE);
    const closedCode = NPC_AUTHORITATIVE_STATE_FOUNDATION_INVARIANT_CODES.includes(code)
      ? code
      : DEFAULT_INVARIANT_CODE;
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "NpcAuthoritativeStateFoundationInvariantError",
      writable: true
    });
    Object.defineProperty(this, "code", {
      configurable: false,
      enumerable: false,
      value: closedCode,
      writable: false
    });
  }
}

export function createNpcAuthoritativeConversationRegistries() {
  return {
    reactionPlans: [],
    npcReactionCommitIdempotencyRecords: []
  };
}

export function validateNpcAuthoritativeStateFoundation(state) {
  if (!isObject(state)) throw invariant(DEFAULT_INVARIANT_CODE);
  const conversationDescriptor = Object.getOwnPropertyDescriptor(state, "conversation");
  if (!isDataDescriptor(conversationDescriptor) || !isObject(conversationDescriptor.value) || Array.isArray(conversationDescriptor.value)) {
    throw invariant(DEFAULT_INVARIANT_CODE);
  }

  const conversation = conversationDescriptor.value;
  assertRegistry(
    Object.getOwnPropertyDescriptor(conversation, "reactionPlans"),
    "invalid_npc_reaction_plans_registry"
  );
  assertRegistry(
    Object.getOwnPropertyDescriptor(conversation, "npcReactionCommitIdempotencyRecords"),
    "invalid_npc_commit_idempotency_registry"
  );
  const keys = Reflect.ownKeys(conversation);
  if (
    keys.length !== CONVERSATION_FIELDS.length
    || keys.some((key) => typeof key !== "string" || !CONVERSATION_FIELDS.includes(key))
  ) {
    throw invariant("invalid_npc_authoritative_conversation_foundation");
  }

  const arrays = [];
  for (const field of ARRAY_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(conversation, field);
    if (!isEnumerableDataDescriptor(descriptor) || !isDenseArray(descriptor.value)) {
      throw invariant("invalid_npc_authoritative_conversation_foundation");
    }
    arrays.push(descriptor.value);
  }

  if (new Set(arrays).size !== arrays.length) throw invariant("aliased_npc_authoritative_registry");

  for (const field of COUNTER_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(conversation, field);
    if (!isEnumerableDataDescriptor(descriptor) || !isNonNegativeSafeInteger(descriptor.value)) {
      throw invariant("invalid_npc_authoritative_conversation_foundation");
    }
  }
}

function invariant(code) {
  return new NpcAuthoritativeStateFoundationInvariantError(code);
}

function assertRegistry(descriptor, code) {
  if (!isEnumerableDataDescriptor(descriptor) || !isDenseArray(descriptor.value)) throw invariant(code);
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function isDataDescriptor(descriptor) {
  return descriptor !== undefined && Object.hasOwn(descriptor, "value");
}

function isEnumerableDataDescriptor(descriptor) {
  return isDataDescriptor(descriptor) && descriptor.enumerable === true;
}

function isDenseArray(value) {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
