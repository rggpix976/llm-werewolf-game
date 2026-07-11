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
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
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

export function createId(prefix, uuid = randomUUID) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(prefix)) throw new TypeError("invalid ID prefix");
  const id = `${prefix}-${uuid()}`;
  if (!isId(id)) throw new TypeError("generated ID exceeds the ID schema");
  return id;
}
