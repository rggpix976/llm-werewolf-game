import { ID_PATTERN, SHA256_PATTERN, enums } from "./conversation/domain.mjs";
import { sha256CanonicalJson } from "./conversation/ids.mjs";
import { validateReactionPlanReferences } from "./conversation/references.mjs";

const INPUT_FIELDS = ["schemaVersion", "committedGraph", "renderingContext"];
const CONTEXT_FIELDS = ["locale", "publicParticipantsById"];
const PARTICIPANT_FIELDS = ["participantId", "displayName"];
const SUPPORTED_LOCALES = new Set(enums.supportedLocale);

function deepFreeze(value) {
  if (value && (typeof value === "object" || typeof value === "function") && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function cloneRegistry(value, seen = new Map()) {
  if (typeof value === "function") return (...args) => value(...args);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (!isPlainObject(value)) throw new TypeError("renderer registry must contain plain objects");
  const copy = Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const [key, child] of Object.entries(value)) copy[key] = cloneRegistry(child, seen);
  return deepFreeze(copy);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  const ownKeys = isPlainObject(value) ? Reflect.ownKeys(value) : [];
  return isPlainObject(value)
    && ownKeys.length === fields.length
    && ownKeys.every((key) => typeof key === "string")
    && fields.every((field) => Object.hasOwn(value, field));
}

function invariant() {
  throw new NpcPublicationDeliveryInvariantError();
}

export class NpcPublicationDeliveryInvariantError extends Error {
  constructor() {
    super("NPC publication delivery invariant failed");
    Object.defineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "NpcPublicationDeliveryInvariantError",
      writable: true
    });
    Object.defineProperty(this, "code", {
      configurable: false,
      enumerable: false,
      value: "invalid_npc_delivery_publication_graph",
      writable: false
    });
  }
}

function resolutionFailure(code) {
  return deepFreeze({
    schemaVersion: 1,
    failureType: "npc_delivery_resolution",
    code,
    disposition: "terminal"
  });
}

const JAPANESE_TABLE = {
  join: "",
  roles: { seer: "私は占い師です。", werewolf: "私は人狼です。", citizen: "私は市民です。" },
  results: { werewolf: "{targetDisplayName}は人狼です。", not_werewolf: "{targetDisplayName}は人狼ではありません。" },
  vote: "{targetDisplayName}に投票します。",
  suspicion: "{targetDisplayName}を疑っています。"
};

const ENGLISH_TABLE = {
  join: " ",
  roles: { seer: "I am the seer.", werewolf: "I am a werewolf.", citizen: "I am a citizen." },
  results: { werewolf: "{targetDisplayName} is a werewolf.", not_werewolf: "{targetDisplayName} is not a werewolf." },
  vote: "I will vote for {targetDisplayName}.",
  suspicion: "I suspect {targetDisplayName}."
};

const PRODUCTION_RENDERER_REGISTRY = cloneRegistry({
  1: {
    ja: JAPANESE_TABLE,
    "ja-JP": JAPANESE_TABLE,
    en: ENGLISH_TABLE,
    "en-US": ENGLISH_TABLE
  }
});

function validateOuterInput(input) {
  if (!hasExactFields(input, INPUT_FIELDS) || input.schemaVersion !== 1) invariant();
}

function validateCommittedGraph(graph) {
  if (!isPlainObject(graph) || !isPlainObject(graph.reactionPlan)) invariant();
  try {
    validateReactionPlanReferences(graph.reactionPlan, graph);
  } catch {
    invariant();
  }
  const { reactionPlan: plan, publication } = graph;
  if (plan.renderMode !== "canonical_only" || publication.recordType !== "npc_canonical_published") invariant();
  if (publication.locale !== plan.locale
    || publication.actorId !== plan.npcId
    || publication.reactionPlanId !== plan.reactionPlanId
    || publication.reactionCommitRequestId !== plan.requestId
    || publication.turnId !== plan.turnId
    || publication.reactionResultingStateVersion !== plan.resultingStateVersion) invariant();
  if (publication.canonicalSegmentIds.length !== plan.canonicalSegments.length
    || publication.canonicalSegmentIds.some((id, index) => id !== plan.canonicalSegments[index].segmentId)) invariant();

  const claimsById = uniqueIndex(graph.claims, "claimId");
  const eventsById = uniqueIndex(graph.events, "eventId");
  return plan.canonicalSegments.map((segment, index) => {
    const descriptor = plan.intendedSpeechActs[index];
    if (!descriptor || descriptor.descriptorId !== segment.descriptorId) invariant();
    if (segment.type === "canonical_claim") {
      const claim = claimsById.get(segment.claimId);
      if (!claim) invariant();
      validateArtifactIdentity(claim, descriptor, plan, publication, true);
      if (descriptor.descriptorType === "role_claim") {
        if (claim.type !== "role_claim" || claim.claimedRole !== descriptor.claimedRole) invariant();
        return { kind: "role", value: claim.claimedRole, targetId: null };
      }
      if (descriptor.descriptorType === "result_claim") {
        if (claim.type !== "result_claim" || claim.targetId !== descriptor.targetId || claim.result !== descriptor.result) invariant();
        return { kind: "result", value: claim.result, targetId: claim.targetId };
      }
      invariant();
    }
    const eventId = segment.type === "canonical_vote" ? segment.voteEventId
      : segment.type === "canonical_suspicion" ? segment.suspicionEventId : null;
    const event = eventId === null ? null : eventsById.get(eventId);
    if (!event) invariant();
    validateArtifactIdentity(event, descriptor, plan, publication, false);
    if (segment.type === "canonical_vote") {
      if (descriptor.descriptorType !== "vote_declaration" || event.eventType !== "vote_declared" || event.targetId !== descriptor.targetId) invariant();
      return { kind: "vote", value: null, targetId: event.targetId };
    }
    if (descriptor.descriptorType !== "suspicion" || event.eventType !== "suspicion_expressed" || event.targetId !== descriptor.targetId) invariant();
    return { kind: "suspicion", value: null, targetId: event.targetId };
  });
}

function uniqueIndex(values, field) {
  if (!Array.isArray(values)) invariant();
  const index = new Map();
  for (const value of values) {
    if (!isPlainObject(value) || index.has(value[field])) invariant();
    index.set(value[field], value);
  }
  return index;
}

function validateArtifactIdentity(artifact, descriptor, plan, publication, isClaim) {
  if (artifact.actorId !== plan.npcId || artifact.actorId !== publication.actorId) invariant();
  if (!isPlainObject(artifact.source)
    || artifact.source.sourceType !== "npc_reaction"
    || artifact.source.reactionPlanId !== plan.reactionPlanId
    || artifact.source.descriptorId !== descriptor.descriptorId
    || artifact.source.originatingInputRecordId !== plan.originatingInputRecordId
    || artifact.source.reactionCommitRequestId !== plan.requestId) invariant();
  if (isClaim) {
    if (artifact.createdTurnId !== plan.turnId || artifact.createdStateVersion !== plan.resultingStateVersion) invariant();
  } else if (artifact.requestId !== plan.requestId
    || artifact.turnId !== plan.turnId
    || artifact.correlationId !== plan.correlationId
    || artifact.causationId !== plan.causationId
    || artifact.stateVersion !== plan.resultingStateVersion) invariant();
}

function validateRenderingContext(context, locale) {
  if (!hasExactFields(context, CONTEXT_FIELDS)
    || !SUPPORTED_LOCALES.has(context.locale)
    || context.locale !== locale
    || !isPlainObject(context.publicParticipantsById)) invariant();
  const participantKeys = Reflect.ownKeys(context.publicParticipantsById);
  if (participantKeys.some((key) => typeof key !== "string")) invariant();
  const participants = new Map();
  for (const key of participantKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(context.publicParticipantsById, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invariant();
    const participant = descriptor.value;
    if (!hasExactFields(participant, PARTICIPANT_FIELDS)
      || participant.participantId !== key
      || !ID_PATTERN.test(participant.participantId)
      || typeof participant.displayName !== "string") invariant();
    const length = Array.from(participant.displayName).length;
    if (length < 1 || length > 80 || participants.has(participant.participantId)) invariant();
    participants.set(participant.participantId, participant.displayName);
  }
  return participants;
}

function renderSegment(segment, table, participants) {
  const targetDisplayName = segment.targetId === null ? null : participants.get(segment.targetId);
  if (segment.targetId !== null && targetDisplayName === undefined) invariant();
  let primitive;
  if (segment.kind === "role") primitive = table.roles?.[segment.value];
  else if (segment.kind === "result") primitive = table.results?.[segment.value];
  else primitive = table[segment.kind];
  const rendered = typeof primitive === "function"
    ? primitive(targetDisplayName)
    : typeof primitive === "string"
      ? primitive.replaceAll("{targetDisplayName}", () => targetDisplayName ?? "")
      : primitive;
  if (typeof rendered !== "string") throw new TypeError("renderer primitive did not return a string");
  return rendered;
}

function createResolver(rendererRegistry, hashCanonicalJson) {
  const registry = cloneRegistry(rendererRegistry);
  if (typeof hashCanonicalJson !== "function") throw new TypeError("hashCanonicalJson must be a function");
  return function resolve(input) {
    validateOuterInput(input);
    const segments = validateCommittedGraph(input.committedGraph);
    const { reactionPlan: plan, publication } = input.committedGraph;
    const participants = validateRenderingContext(input.renderingContext, publication.locale);
    for (const segment of segments) if (segment.targetId !== null && !participants.has(segment.targetId)) invariant();

    const renderer = registry[publication.canonicalRendererVersion];
    if (!isPlainObject(renderer)) return resolutionFailure("canonical_render_failed");
    const table = renderer[publication.locale];
    if (!isPlainObject(table)) return resolutionFailure("canonical_render_failed");

    let displayText;
    try {
      if (typeof table.join !== "string") throw new TypeError("invalid join primitive");
      displayText = segments.map((segment) => renderSegment(segment, table, participants)).join(table.join);
    } catch {
      return resolutionFailure("canonical_render_failed");
    }
    const displayLength = Array.from(displayText).length;
    if (displayLength < 1 || displayLength > plan.maxChars || displayLength > 1000) {
      return resolutionFailure("canonical_render_limit_exceeded");
    }

    const payloadWithoutFingerprint = {
      schemaVersion: 1,
      payloadType: "npc_canonical_utterance",
      publicationId: publication.publicationId,
      reactionPlanId: plan.reactionPlanId,
      reactionCommitRequestId: publication.reactionCommitRequestId,
      turnId: publication.turnId,
      reactionResultingStateVersion: publication.reactionResultingStateVersion,
      actorId: publication.actorId,
      locale: publication.locale,
      canonicalRendererVersion: publication.canonicalRendererVersion,
      canonicalSegmentIds: [...publication.canonicalSegmentIds],
      displayText
    };
    let payloadFingerprint;
    try {
      payloadFingerprint = hashCanonicalJson(payloadWithoutFingerprint);
    } catch {
      return resolutionFailure("canonical_render_failed");
    }
    if (typeof payloadFingerprint !== "string" || !SHA256_PATTERN.test(payloadFingerprint)) {
      return resolutionFailure("canonical_render_failed");
    }
    return deepFreeze({ ...payloadWithoutFingerprint, payloadFingerprint });
  };
}

export function createNpcCanonicalRendererForTesting({ rendererRegistry, hashCanonicalJson }) {
  return createResolver(rendererRegistry, hashCanonicalJson);
}

export const resolveNpcCanonicalDeliveryPayload = createResolver(
  PRODUCTION_RENDERER_REGISTRY,
  sha256CanonicalJson
);
