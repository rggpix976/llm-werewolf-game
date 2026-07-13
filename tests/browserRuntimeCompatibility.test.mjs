import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson, createId, sha256CanonicalJson } from "../src/conversation/ids.mjs";

const browserEntry = fileURLToPath(new URL("../public/browserApp.mjs", import.meta.url));

test("browser entry import graph contains no Node builtin modules", async () => {
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
