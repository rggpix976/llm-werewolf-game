import { createHash, randomUUID } from "node:crypto";
import { ID_PATTERN } from "./domain.mjs";

export function isId(value) { return typeof value === "string" && ID_PATTERN.test(value); }

export function assertUniqueIds(values, label = "ids") {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  const seen = new Set();
  for (const value of values) {
    if (!isId(value)) throw new TypeError(`${label} contains an invalid ID`);
    if (seen.has(value)) throw new TypeError(`${label} contains duplicate ID ${value}`);
    seen.add(value);
  }
  return values;
}

export function canonicalJson(value) {
  const stack = new Set();
  function serialize(current) {
    if (current === null || typeof current === "string" || typeof current === "boolean") return JSON.stringify(current);
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("canonical JSON rejects non-finite numbers");
      return JSON.stringify(current);
    }
    if (typeof current !== "object") throw new TypeError(`canonical JSON rejects ${typeof current}`);
    if (stack.has(current)) throw new TypeError("canonical JSON rejects cyclic values");
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
      throw new TypeError("canonical JSON accepts only arrays and plain objects");
    }
    stack.add(current);
    const result = Array.isArray(current)
      ? `[${current.map(serialize).join(",")}]`
      : `{${Object.keys(current).sort().map((key) => `${JSON.stringify(key)}:${serialize(current[key])}`).join(",")}}`;
    stack.delete(current);
    return result;
  }
  return serialize(value);
}

export function sha256Fingerprint(...parts) {
  return createHash("sha256").update(canonicalJson(parts)).digest("hex");
}

export function playerClaimIdempotencyKey({ requestId, acceptedSpeechActIds, actorId, claimKind }) {
  return sha256Fingerprint(requestId, [...acceptedSpeechActIds].sort(), actorId, claimKind);
}

export function npcClaimIdempotencyKey({ reactionCommitRequestId, reactionPlanId, descriptorId, actorId, claimKind }) {
  return sha256Fingerprint(reactionCommitRequestId, reactionPlanId, descriptorId, actorId, claimKind);
}

export function classifyIdempotentWrite(existingPayload, incomingPayload) {
  return canonicalJson(existingPayload) === canonicalJson(incomingPayload) ? "replay" : "idempotency_conflict";
}

export function createId(prefix, uuid = randomUUID) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(prefix)) throw new TypeError("invalid ID prefix");
  const id = `${prefix}-${uuid()}`;
  if (!isId(id)) throw new TypeError("generated ID exceeds the ID schema");
  return id;
}
