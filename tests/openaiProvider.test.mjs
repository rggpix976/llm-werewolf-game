import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIResponseProvider, ERROR_TYPES } from "../src/openaiProvider.mjs";

const dummyRequest = {
  npc: { id: "npc1", name: "Aoi", personality: "P", speechStyle: "S", conversationPolicy: {} },
  playerInput: "Hello",
  context: { day: 1, phase: "day", publicEvidence: [], shareableKnownEvidence: [], privateStanceEvidence: [], publicClaims: [], intent: null, topSuspect: null },
  policyDecision: { publicClaimAllowed: false, publicClaim: null, disclosedHiddenInfo: false },
  responsePlan: { baseText: "B", speechStyle: "S" },
  evidenceUsed: []
};

const officialSuccessResponse = {
  id: "resp-123",
  status: "completed",
  output: [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "output_text",
            output_text: "こんにちは"
          }
        ]
      }
    }
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
};

test("OpenAIResponseProvider - success case (official shape)", async () => {
  const mockFetch = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, "none");
    assert.equal(body.max_output_tokens, 220);
    assert.ok(Array.isArray(body.input));
    assert.equal(body.input[0].role, "user");
    assert.ok(!("tools" in body));

    return {
      ok: true,
      status: 200,
      headers: new Map([["x-request-id", "req-123"]]),
      json: async () => officialSuccessResponse
    };
  };

  const provider = new OpenAIResponseProvider({
    apiKey: "sk-test",
    fetch: mockFetch
  });

  const result = await provider.generateResponse(dummyRequest);
  assert.equal(result.text, "こんにちは");
  assert.equal(result.providerName, "openai");
  assert.equal(result.diagnostics.httpStatus, 200);
  assert.equal(result.diagnostics.providerStatus, "completed");
  assert.equal(result.diagnostics.requestId, "req-123");
});

test("OpenAIResponseProvider - incomplete response", async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map([["x-request-id", "req-inc"]]),
    json: async () => ({
      id: "resp-inc",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          type: "message",
          message: {
            content: [{ type: "output_text", output_text: "少しだけ..." }]
          }
        }
      ]
    })
  });

  const provider = new OpenAIResponseProvider({ apiKey: "key", fetch: mockFetch });
  const result = await provider.generateResponse(dummyRequest);
  assert.equal(result.text, "少しだけ...");
  assert.equal(result.diagnostics.providerStatus, "incomplete");
  assert.equal(result.diagnostics.incompleteReason, "max_output_tokens");
});

test("OpenAIResponseProvider - refusal", async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => ({
      id: "resp-ref",
      status: "completed",
      output: [{ type: "refusal", refusal: "I cannot answer." }]
    })
  });

  const provider = new OpenAIResponseProvider({ apiKey: "key", fetch: mockFetch, fallbackToPseudo: false });
  await assert.rejects(async () => {
    await provider.generateResponse(dummyRequest);
  }, (err) => {
    assert.equal(err.type, ERROR_TYPES.INVALID_PROVIDER_RESPONSE);
    assert.ok(err.message.includes("refused"));
    return true;
  });
});

test("OpenAIResponseProvider - concurrency limit", async () => {
  let active = 0;
  let maxActive = 0;
  const mockFetch = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 50));
    active--;
    return { ok: true, status: 200, headers: new Map(), json: async () => officialSuccessResponse };
  };

  const provider = new OpenAIResponseProvider({
    apiKey: "key",
    fetch: mockFetch,
    maxConcurrent: 1
  });

  await Promise.all([
    provider.generateResponse(dummyRequest),
    provider.generateResponse(dummyRequest)
  ]);

  assert.equal(maxActive, 1);
});

test("OpenAIResponseProvider - retry on 429", async () => {
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, headers: new Map([["retry-after", "0"]]), json: async () => ({}) };
    return { ok: true, status: 200, headers: new Map(), json: async () => officialSuccessResponse };
  };

  const provider = new OpenAIResponseProvider({
    apiKey: "key",
    fetch: mockFetch,
    sleep: async () => {},
    maxRetries: 1
  });

  const result = await provider.generateResponse(dummyRequest);
  assert.equal(calls, 2);
  assert.equal(result.diagnostics.retryCount, 1);
});

test("OpenAIResponseProvider - no retry on 401", async () => {
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    return { ok: false, status: 401, headers: new Map(), json: async () => ({}) };
  };

  const provider = new OpenAIResponseProvider({
    apiKey: "key",
    fetch: mockFetch,
    maxRetries: 1,
    fallbackToPseudo: false
  });

  await assert.rejects(provider.generateResponse(dummyRequest), (err) => {
    assert.equal(err.type, ERROR_TYPES.AUTHENTICATION_ERROR);
    assert.equal(calls, 1);
    return true;
  });
});

test("OpenAIResponseProvider - fallback on network error", async () => {
  const mockFetch = async () => { throw new Error("Network fail"); };
  const provider = new OpenAIResponseProvider({
    apiKey: "key",
    fetch: mockFetch,
    fallbackToPseudo: true,
    maxRetries: 0
  });

  const result = await provider.generateResponse(dummyRequest);
  assert.equal(result.providerName, "pseudo");
  assert.equal(result.diagnostics.fallbackUsed, true);
  assert.equal(result.diagnostics.originalErrorType, ERROR_TYPES.NETWORK_ERROR);
});

test("OpenAIResponseProvider - invalid JSON response", async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => { throw new Error("SyntaxError"); }
  });

  const provider = new OpenAIResponseProvider({ apiKey: "key", fetch: mockFetch, fallbackToPseudo: false });
  await assert.rejects(provider.generateResponse(dummyRequest), (err) => {
    assert.equal(err.type, ERROR_TYPES.INVALID_PROVIDER_RESPONSE);
    assert.ok(err.message.includes("JSON"));
    return true;
  });
});
