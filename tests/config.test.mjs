import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig, getRuntimeConfig } from "../src/config.mjs";

test("parseConfig - default values in pseudo mode", () => {
  const config = parseConfig({});
  assert.equal(config.provider, "pseudo");
  assert.equal(config.openai, null);
});

test("parseConfig - valid openai mode", () => {
  const env = {
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-test-key",
    OPENAI_MODEL: "gpt-4o",
    OPENAI_TIMEOUT_MS: "5000",
    OPENAI_MAX_RETRIES: "2",
    OPENAI_MAX_OUTPUT_TOKENS: "100",
    OPENAI_MAX_REQUESTS_PER_MINUTE: "20",
    OPENAI_MAX_CONCURRENT_REQUESTS: "4",
    OPENAI_FALLBACK_TO_PSEUDO: "false"
  };
  const config = parseConfig(env);
  assert.equal(config.provider, "openai");
  assert.equal(config.openai.apiKey, "sk-test-key");
  assert.equal(config.openai.model, "gpt-4o");
  assert.equal(config.openai.timeoutMs, 5000);
  assert.equal(config.openai.maxRetries, 2);
  assert.equal(config.openai.maxOutputTokens, 100);
  assert.equal(config.openai.maxRequestsPerMinute, 20);
  assert.equal(config.openai.maxConcurrentRequests, 4);
  assert.equal(config.openai.fallbackToPseudo, false);
});

test("parseConfig - missing or whitespace API key in openai mode throws", () => {
  assert.throws(() => parseConfig({ LLM_PROVIDER: "openai" }), /OPENAI_API_KEY is required/);
  assert.throws(() => parseConfig({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "   " }), /OPENAI_API_KEY is required/);
});

test("parseConfig - invalid LLM_PROVIDER throws", () => {
  assert.throws(() => parseConfig({ LLM_PROVIDER: "anthropic" }), /Invalid LLM_PROVIDER/);
});

test("parseConfig - invalid numeric values throw (strict parsing)", () => {
  const base = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "key" };
  assert.throws(() => parseConfig({ ...base, OPENAI_TIMEOUT_MS: "abc" }), /must be a positive integer/);
  assert.throws(() => parseConfig({ ...base, OPENAI_TIMEOUT_MS: "15000ms" }), /must be a positive integer/);
  assert.throws(() => parseConfig({ ...base, OPENAI_TIMEOUT_MS: "1.5" }), /must be a positive integer/);
  assert.throws(() => parseConfig({ ...base, OPENAI_TIMEOUT_MS: "  15000" }), /must be a positive integer/);
  assert.throws(() => parseConfig({ ...base, OPENAI_MAX_RETRIES: "-1" }), /must be a positive integer/);
});

test("parseConfig - range validation", () => {
  const base = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "key" };
  assert.throws(() => parseConfig({ ...base, OPENAI_MAX_OUTPUT_TOKENS: "5000" }), /must be between 1 and 4096/);
  assert.throws(() => parseConfig({ ...base, OPENAI_TIMEOUT_MS: "0" }), /must be between 1 and 60000/);
  assert.throws(() => parseConfig({ ...base, OPENAI_MAX_RETRIES: "6" }), /must be between 0 and 5/);
  assert.throws(() => parseConfig({ ...base, OPENAI_MAX_REQUESTS_PER_MINUTE: "100" }), /must be between 1 and 60/);
  assert.throws(() => parseConfig({ ...base, OPENAI_MAX_CONCURRENT_REQUESTS: "9" }), /must be between 1 and 8/);
});

test("parseConfig - NPC candidate cost-control defaults and strict concurrency syntax", () => {
  const base = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "unit-test-credential" };
  const config = parseConfig(base);
  assert.equal(config.openai.maxOutputTokens, 220);
  assert.equal(config.openai.maxRequestsPerMinute, 10);
  assert.equal(config.openai.maxConcurrentRequests, 1);

  for (const [name, maximum] of [
    ["OPENAI_MAX_OUTPUT_TOKENS", 4096],
    ["OPENAI_MAX_REQUESTS_PER_MINUTE", 60],
    ["OPENAI_MAX_CONCURRENT_REQUESTS", 8]
  ]) {
    for (const value of ["0", "-1", "1.5", "1e1", " 1", "1 ", String(maximum + 1), "9007199254740992"]) {
      assert.throws(() => parseConfig({ ...base, [name]: value }), new RegExp(name));
    }
    assert.equal(parseConfig({ ...base, [name]: "1" }).openai[{
      OPENAI_MAX_OUTPUT_TOKENS: "maxOutputTokens",
      OPENAI_MAX_REQUESTS_PER_MINUTE: "maxRequestsPerMinute",
      OPENAI_MAX_CONCURRENT_REQUESTS: "maxConcurrentRequests"
    }[name]], 1);
  }
  assert.equal(parseConfig({ ...base, OPENAI_MAX_OUTPUT_TOKENS: "4096" }).openai.maxOutputTokens, 4096);
  assert.equal(parseConfig({ ...base, OPENAI_MAX_REQUESTS_PER_MINUTE: "60" }).openai.maxRequestsPerMinute, 60);
  assert.equal(parseConfig({ ...base, OPENAI_MAX_CONCURRENT_REQUESTS: "8" }).openai.maxConcurrentRequests, 8);
});

test("getRuntimeConfig - hides sensitive info", () => {
  const env = {
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-test-key",
    OPENAI_MODEL: "gpt-4o"
  };
  const config = parseConfig(env);
  const runtime = getRuntimeConfig(config);

  assert.equal(runtime.provider, "openai");
  assert.equal(runtime.model, "gpt-4o");
  assert.equal(runtime.fallbackEnabled, true);
  assert.equal(runtime.apiKey, undefined);
  assert.equal(runtime.maxOutputTokens, undefined);
  assert.equal(runtime.maxRequestsPerMinute, undefined);
  assert.equal(runtime.maxConcurrentRequests, undefined);
});
