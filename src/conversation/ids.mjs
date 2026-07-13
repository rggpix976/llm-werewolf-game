import { ID_PATTERN } from "./domain.mjs";

const SHA256_INITIAL_STATE = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

const SHA256_ROUND_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

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
  return sha256Utf8(canonicalJson(value));
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

export function createId(prefix, uuid = secureRandomUuid) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(prefix)) throw new TypeError("invalid ID prefix");
  const id = `${prefix}-${uuid()}`;
  if (!isId(id)) throw new TypeError("generated ID exceeds the ID schema");
  return id;
}

function secureRandomUuid() {
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.randomUUID !== "function") {
    const error = new Error("secure_random_uuid_unavailable");
    error.name = "SecureIdentityError";
    error.code = "secure_random_uuid_unavailable";
    throw error;
  }
  return crypto.randomUUID();
}

function sha256Utf8(value) {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;

  const bitLength = BigInt(input.length) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffffffffn));
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn));

  const state = [...SHA256_INITIAL_STATE];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const prior15 = words[index - 15];
      const prior2 = words[index - 2];
      const sigma0 = rotateRight(prior15, 7) ^ rotateRight(prior15, 18) ^ (prior15 >>> 3);
      const sigma1 = rotateRight(prior2, 17) ^ rotateRight(prior2, 19) ^ (prior2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    for (let index = 0; index < state.length; index += 1) {
      state[index] = (state[index] + [a, b, c, d, e, f, g, h][index]) >>> 0;
    }
  }

  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value, count) {
  return (value >>> count) | (value << (32 - count));
}
