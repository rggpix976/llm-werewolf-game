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
  assert.equal(config.openai.fallbackToPseudo, false);
});

test("parseConfig - missing API key in openai mode throws", () => {
  assert.throws(() => parseConfig({ LLM_PROVIDER: "openai" }), /OPENAI_API_KEY is required/);
});

test("parseConfig - invalid LLM_PROVIDER throws", () => {
  assert.throws(() => parseConfig({ LLM_PROVIDER: "anthropic" }), /Invalid LLM_PROVIDER/);
});

test("parseConfig - invalid numeric values throw", () => {
  const base = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "key" };
  assert.throws(() => parseConfig({ ...base, OPENAI_TIMEOUT_MS: "abc" }), /OPENAI_TIMEOUT_MS must be a positive integer/);
  assert.throws(() => parseConfig({ ...base, OPENAI_TIMEOUT_MS: "-100" }), /OPENAI_TIMEOUT_MS must be a positive integer/);
  assert.throws(() => parseConfig({ ...base, OPENAI_MAX_RETRIES: "-1" }), /OPENAI_MAX_RETRIES must be a non-negative integer/);
});

test("parseConfig - invalid boolean throws", () => {
  const base = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "key" };
  assert.throws(() => parseConfig({ ...base, OPENAI_FALLBACK_TO_PSEUDO: "yes" }), /OPENAI_FALLBACK_TO_PSEUDO must be 'true' or 'false'/);
});

test("parseConfig - token range validation", () => {
  const base = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "key" };
  assert.throws(() => parseConfig({ ...base, OPENAI_MAX_OUTPUT_TOKENS: "5000" }), /OPENAI_MAX_OUTPUT_TOKENS must be between 1 and 4096/);
});

test("parseConfig - retry range validation", () => {
  const base = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "key" };
  assert.throws(() => parseConfig({ ...base, OPENAI_MAX_RETRIES: "10" }), /OPENAI_MAX_RETRIES is too high/);
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

  const json = JSON.stringify(runtime);
  assert.ok(!json.includes("sk-test-key"));
});
