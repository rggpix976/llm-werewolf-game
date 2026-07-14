import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson, createId, sha256CanonicalJson } from "../src/conversation/ids.mjs";

const browserEntry = fileURLToPath(new URL("../public/browserApp.mjs", import.meta.url));

test("browser entry import graph contains no node: module specifiers", async () => {
  const { visited, builtinImports } = await traceBrowserImports(browserEntry);

  assert.deepEqual(builtinImports, []);
  for (const requiredModule of [
    "public/browserApp.mjs",
    "src/gameEngine.mjs",
    "src/conversation/ids.mjs",
    "src/npcReactionFoundation.mjs"
  ]) {
    assert.equal([...visited].some((file) => normalize(file).endsWith(requiredModule)), true, `${requiredModule} must be browser-reachable`);
  }
});

test("platform-neutral SHA-256 preserves the canonical fingerprint contract", () => {
  for (const value of [
    null,
    {},
    { b: 2, a: 1 },
    { text: "日本語😀é\n", nested: [true, false, 0, -1, 1.5] }
  ]) {
    const expected = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
    assert.equal(sha256CanonicalJson(value), expected);
  }

  const paddingBoundaryByteLengths = [55, 56, 63, 64, 65, 127, 128, 129];
  for (const expectedByteLength of paddingBoundaryByteLengths) {
    assertCanonicalSha256Parity(
      asciiStringWithCanonicalByteLength(expectedByteLength),
      expectedByteLength,
      `padding boundary at ${expectedByteLength} UTF-8 bytes`
    );
  }

  assertCanonicalSha256Parity(
    asciiStringWithCanonicalByteLength(1024),
    1024,
    "long multi-block ASCII input"
  );

  const blockBoundary = 64;
  const multibyteCharacter = "\u65E5";
  const asciiPrefix = "a".repeat(blockBoundary - 2);
  const multibyteValue = `${asciiPrefix}${multibyteCharacter}`;
  const multibyteCanonical = canonicalJson(multibyteValue);
  const encoder = new TextEncoder();
  const multibyteCanonicalBytes = encoder.encode(multibyteCanonical);
  const multibyteStart = encoder.encode(`"${asciiPrefix}`).byteLength;
  const multibyteBytes = encoder.encode(multibyteCharacter);

  assert.equal(multibyteStart, blockBoundary - 1);
  assert.equal(multibyteStart < blockBoundary, true);
  assert.equal(multibyteStart + multibyteBytes.byteLength > blockBoundary, true);
  assert.deepEqual(
    multibyteCanonicalBytes.slice(multibyteStart, multibyteStart + multibyteBytes.byteLength),
    multibyteBytes
  );
  assertCanonicalSha256Parity(multibyteValue, 67, "UTF-8 multibyte sequence crossing a 64-byte block boundary");
});

test("default identity generation uses secure Web Crypto UUIDs and produces unique IDs", () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const originalRandom = Math.random;
  let calls = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID() {
        calls += 1;
        return `00000000-0000-4000-8000-${String(calls).padStart(12, "0")}`;
      }
    }
  });
  Math.random = () => { throw new Error("Math.random must not be used for identities"); };

  try {
    const first = createId("engine");
    const second = createId("engine");
    assert.match(first, /^engine-[0-9a-f-]+$/);
    assert.match(second, /^engine-[0-9a-f-]+$/);
    assert.notEqual(first, second);
    assert.equal(calls, 2);
  } finally {
    Math.random = originalRandom;
    restoreGlobalCrypto(originalCrypto);
  }
});

test("identity generation fails closed when secure Web Crypto UUIDs are unavailable", () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const originalRandom = Math.random;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  Math.random = () => { throw new Error("weak random fallback attempted"); };

  try {
    assert.throws(
      () => createId("engine"),
      (error) => error?.name === "SecureIdentityError" && error?.code === "secure_random_uuid_unavailable"
    );
  } finally {
    Math.random = originalRandom;
    restoreGlobalCrypto(originalCrypto);
  }
});

async function traceBrowserImports(entry) {
  const queue = [path.resolve(entry)];
  const visited = new Set();
  const builtinImports = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, "utf8");
    for (const specifier of staticImportSpecifiers(source)) {
      if (specifier.startsWith("node:")) {
        builtinImports.push({ importer: normalize(file), specifier });
      } else if (specifier.startsWith(".")) {
        queue.push(fileURLToPath(new URL(specifier, pathToFileURL(file))));
      }
    }
  }
  return { visited, builtinImports };
}

function staticImportSpecifiers(source) {
  const specifiers = [];
  const declarations = /(?:^|\n)\s*(?:import|export)\s+(?:[^"']*?\s+from\s*)?["']([^"']+)["']/g;
  const literalDynamicImports = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [declarations, literalDynamicImports]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function restoreGlobalCrypto(descriptor) {
  if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
  else delete globalThis.crypto;
}

function normalize(file) {
  return file.replaceAll("\\", "/");
}

function asciiStringWithCanonicalByteLength(expectedByteLength) {
  const jsonStringDelimiterBytes = 2;
  assert.equal(Number.isSafeInteger(expectedByteLength) && expectedByteLength >= jsonStringDelimiterBytes, true);
  return "a".repeat(expectedByteLength - jsonStringDelimiterBytes);
}

function assertCanonicalSha256Parity(value, expectedByteLength, label) {
  const canonical = canonicalJson(value);
  assert.equal(new TextEncoder().encode(canonical).byteLength, expectedByteLength, `${label}: UTF-8 byte length`);
  const expected = createHash("sha256").update(canonical, "utf8").digest("hex");
  assert.equal(sha256CanonicalJson(value), expected, `${label}: Node SHA-256 parity`);
}
