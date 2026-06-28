import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIResponseProvider, ERROR_TYPES } from "../src/openaiProvider.mjs";

const dummyRequest = {
  npc: { id: "npc1", name: "Aoi", personality: "P", speechStyle: "S", conversationPolicy: {} },
  playerInput: "Hello",
  context: {},
  policyDecision: { publicClaimAllowed: false },
  responsePlan: { baseText: "B", speechStyle: "S" },
  evidenceUsed: []
};

test("OpenAIResponseProvider - success case", async () => {
  const mockFetch = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, "none");
    assert.equal(options.headers["Authorization"], "Bearer sk-test");

    return {
      ok: true,
      headers: new Map([["x-request-id", "req-123"]]),
      json: async () => ({
        id: "resp-123",
        output: { output_text: "こんにちは", status: "completed" },
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      })
    };
  };

  const provider = new OpenAIResponseProvider({
    apiKey: "sk-test",
    fetch: mockFetch
  });

  const result = await provider.generateResponse(dummyRequest);
  assert.equal(result.text, "こんにちは");
  assert.equal(result.providerName, "openai");
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.equal(result.diagnostics.requestId, "req-123");
  assert.equal(result.diagnostics.responseId, "resp-123");
  assert.equal(result.diagnostics.fallbackUsed, false);
});

test("OpenAIResponseProvider - timeout and fallback", async () => {
  const mockFetch = async () => {
    const error = new Error("Abort");
    error.name = "AbortError";
    throw error;
  };

  const provider = new OpenAIResponseProvider({
    apiKey: "sk-test",
    fetch: mockFetch,
    fallbackToPseudo: true,
    maxRetries: 0
  });

  const result = await provider.generateResponse(dummyRequest);
  assert.equal(result.providerName, "pseudo");
  assert.equal(result.diagnostics.fallbackUsed, true);
  assert.equal(result.diagnostics.originalErrorType, ERROR_TYPES.TIMEOUT);
});

test("OpenAIResponseProvider - 401 Authentication Error (no fallback)", async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 401,
    headers: new Map([["x-request-id", "req-401"]]),
    json: async () => ({ error: { message: "Invalid API Key" } })
  });

  const provider = new OpenAIResponseProvider({
    apiKey: "sk-invalid",
    fetch: mockFetch,
    fallbackToPseudo: true
  });

  await assert.rejects(async () => {
    await provider.generateResponse(dummyRequest);
  }, (err) => {
    assert.equal(err.type, ERROR_TYPES.AUTHENTICATION_ERROR);
    assert.equal(err.status, 401);
    assert.equal(err.requestId, "req-401");
    assert.ok(!err.message.includes("sk-invalid"));
    return true;
  });
});

test("OpenAIResponseProvider - 429 Rate Limit and Retry", async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: false,
        status: 429,
        headers: new Map([["x-request-id", "req-429"], ["retry-after", "0"]]),
        json: async () => ({ error: { message: "Rate limit reached" } })
      };
    }
    return {
      ok: true,
      headers: new Map([["x-request-id", "req-success"]]),
      json: async () => ({
        id: "resp-retry",
        output: { output_text: "Success after retry", status: "completed" }
      })
    };
  };

  const provider = new OpenAIResponseProvider({
    apiKey: "sk-test",
    fetch: mockFetch,
    maxRetries: 1
  });

  const result = await provider.generateResponse(dummyRequest);
  assert.equal(callCount, 2);
  assert.equal(result.text, "Success after retry");
});

test("OpenAIResponseProvider - 500 Server Error and Retry failure then fallback", async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    return {
      ok: false,
      status: 500,
      headers: new Map([["x-request-id", "req-500"]]),
      json: async () => ({ error: { message: "Internal Server Error" } })
    };
  };

  const provider = new OpenAIResponseProvider({
    apiKey: "sk-test",
    fetch: mockFetch,
    maxRetries: 1,
    fallbackToPseudo: true
  });

  const result = await provider.generateResponse(dummyRequest);
  assert.equal(callCount, 2); // Original + 1 retry
  assert.equal(result.providerName, "pseudo");
  assert.equal(result.diagnostics.fallbackUsed, true);
  assert.equal(result.diagnostics.originalErrorType, ERROR_TYPES.PROVIDER_SERVER_ERROR);
  assert.equal(result.diagnostics.retryCount, 1);
});

test("OpenAIResponseProvider - invalid JSON from provider", async () => {
  const mockFetch = async () => ({
    ok: true,
    headers: new Map(),
    json: async () => ({ id: "resp-bad", output: { status: "failed" } })
  });

  const provider = new OpenAIResponseProvider({
    apiKey: "sk-test",
    fetch: mockFetch,
    fallbackToPseudo: false
  });

  await assert.rejects(async () => {
    await provider.generateResponse(dummyRequest);
  }, (err) => {
    assert.equal(err.type, ERROR_TYPES.INVALID_PROVIDER_RESPONSE);
    return true;
  });
});
