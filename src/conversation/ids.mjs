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
    if (Object.getOwnPropertySymbols(current).length > 0) throw new TypeError("canonical JSON rejects symbol-keyed properties");
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
      throw new TypeError("canonical JSON accepts only arrays and plain objects");
    }
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) throw new TypeError("canonical JSON rejects sparse arrays");
      }
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
  return sha256CanonicalJson(parts);
}

export function sha256CanonicalJson(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
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
