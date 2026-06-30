import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIResponseProvider, ERROR_TYPES } from "../src/openaiProvider.mjs";

const dummyRequest = {
  npc: { id: "npc1", name: "Aoi", personality: "P", speechStyle: "S", conversationPolicy: { truthfulness: "t", roleClaim: "r", allowedTactics: [], forbidden: [] } },
  playerInput: "Hello",
  context: { day: 1, phase: "day", publicEvidence: [], shareableKnownEvidence: [], privateStanceEvidence: [], publicClaims: [], intent: { asksWerewolfIdentity: false, asksRoleOrClaim: false, asksVoteReason: false }, topSuspect: null },
  policyDecision: { publicClaimAllowed: false, publicClaim: null, disclosedHiddenInfo: false },
  responsePlan: { baseText: "B", speechStyle: "S" },
  evidenceUsed: []
};

const officialSuccessResponse = {
  id: "resp_123",
  status: "completed",
  output: [
    {
      id: "msg_123",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "こんにちは"
        }
      ]
    }
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
};

test("OpenAIResponseProvider - success case (official raw shape and contract)", async () => {
  let fetchOptions;
  const mockFetch = async (url, options) => {
    fetchOptions = options;
    return {
      ok: true,
      status: 200,
      headers: new Map([["x-request-id", "req_abc"]]),
      json: async () => officialSuccessResponse
    };
  };
  const provider = new OpenAIResponseProvider({ apiKey: "test-key", fetch: mockFetch });
  const result = await provider.generateResponse(dummyRequest);

  assert.equal(result.text, "こんにちは");
  assert.equal(result.providerName, "openai");
  assert.equal(result.diagnostics.requestId, "req_abc");
  assert.equal(result.diagnostics.responseId, "resp_123");

  const body = JSON.parse(fetchOptions.body);
  assert.equal(body.store, false);
  assert.equal(body.reasoning.effort, "none");
  assert.equal(body.max_output_tokens, 220);
  assert.ok(!body.tools);
  assert.equal(fetchOptions.headers["Authorization"], "Bearer test-key");

  const inputItem = body.input[0].content[0];
  assert.equal(inputItem.type, "input_text");
  const input = JSON.parse(inputItem.text);
  assert.equal(input.npc.name, "Aoi");
});

test("OpenAIResponseProvider - abort during concurrency wait", async () => {
    const provider = new OpenAIResponseProvider({ apiKey: "key", maxConcurrent: 1 });
    const controller = new AbortController();
    provider.activeRequests = 1;

    const promise = provider.generateResponse(dummyRequest, { signal: controller.signal });
    controller.abort();

    await assert.rejects(promise, { name: "AbortError" });
    assert.equal(provider.waiters.length, 0, "Waiter should be removed");
});

test("OpenAIResponseProvider - error classification: 401, 403, 429, 400, 500", async () => {
    const cases = [
        { status: 401, expected: ERROR_TYPES.AUTHENTICATION_ERROR },
        { status: 403, expected: ERROR_TYPES.PERMISSION_ERROR },
        { status: 429, expected: ERROR_TYPES.RATE_LIMIT },
        { status: 400, expected: ERROR_TYPES.BAD_REQUEST },
        { status: 500, expected: ERROR_TYPES.PROVIDER_SERVER_ERROR }
    ];

    for (const { status, expected } of cases) {
        const mockFetch = async () => ({
            ok: false,
            status,
            headers: new Map(),
            json: async () => ({ error: { message: "Error", code: "err_code" } })
        });
        const provider = new OpenAIResponseProvider({ apiKey: "key", fetch: mockFetch, maxRetries: 0, fallbackToPseudo: false });
        await assert.rejects(provider.generateResponse(dummyRequest), (err) => {
            assert.equal(err.type, expected, `Status ${status} should map to ${expected}`);
            assert.ok(!err.message.includes("key"), "Error message should not contain API key");
            assert.equal(err.status, status);
            return true;
        });
    }
});

test("OpenAIResponseProvider - retry logic (429 and 500)", async () => {
    for (const status of [429, 500]) {
        let calls = 0;
        let sleepCalled = 0;
        const mockFetch = async () => {
            calls++;
            if (calls === 1) return { ok: false, status, headers: new Map(), json: async () => ({}) };
            return { ok: true, status: 200, headers: new Map(), json: async () => officialSuccessResponse };
        };
        const provider = new OpenAIResponseProvider({
            apiKey: "key",
            fetch: mockFetch,
            sleep: async () => { sleepCalled++; },
            maxRetries: 1
        });
        const result = await provider.generateResponse(dummyRequest);
        assert.equal(result.text, "こんにちは");
        assert.equal(calls, 2);
        assert.equal(sleepCalled, 1, `Sleep should be called once for status ${status}`);
        assert.equal(result.diagnostics.retryCount, 1);
    }
});

test("OpenAIResponseProvider - no retry for 400, 401", async () => {
    for (const status of [400, 401]) {
        let calls = 0;
        const mockFetch = async () => {
            calls++;
            return { ok: false, status, headers: new Map(), json: async () => ({}) };
        };
        const provider = new OpenAIResponseProvider({ apiKey: "key", fetch: mockFetch, sleep: async () => {}, maxRetries: 1, fallbackToPseudo: false });
        await assert.rejects(provider.generateResponse(dummyRequest));
        assert.equal(calls, 1, `Status ${status} should not be retried`);
    }
});

test("OpenAIResponseProvider - fallback on timeout and 429", async () => {
    const mockTimeoutFetch = async () => {
        const err = new Error("Fetch timeout");
        err.name = "AbortError";
        throw err;
    };
    const providerTimeout = new OpenAIResponseProvider({ apiKey: "key", fetch: mockTimeoutFetch, sleep: async () => {}, maxRetries: 0, fallbackToPseudo: true });
    const resTimeout = await providerTimeout.generateResponse(dummyRequest);
    assert.equal(resTimeout.providerName, "pseudo");
    assert.equal(resTimeout.diagnostics.fallbackUsed, true);
    assert.equal(resTimeout.diagnostics.originalErrorType, ERROR_TYPES.TIMEOUT);

    const mock429Fetch = async () => ({ ok: false, status: 429, headers: new Map(), json: async () => ({}) });
    const provider429 = new OpenAIResponseProvider({ apiKey: "key", fetch: mock429Fetch, sleep: async () => {}, maxRetries: 0, fallbackToPseudo: true });
    const res429 = await provider429.generateResponse(dummyRequest);
    assert.equal(res429.providerName, "pseudo");
    assert.equal(res429.diagnostics.originalErrorType, ERROR_TYPES.RATE_LIMIT);
});

test("OpenAIResponseProvider - no fallback on 401", async () => {
    const mockFetch = async () => ({ ok: false, status: 401, headers: new Map(), json: async () => ({}) });
    const provider = new OpenAIResponseProvider({ apiKey: "key", fetch: mockFetch, sleep: async () => {}, maxRetries: 0, fallbackToPseudo: true });
    await assert.rejects(provider.generateResponse(dummyRequest), (err) => {
        assert.equal(err.type, ERROR_TYPES.AUTHENTICATION_ERROR);
        assert.equal(err.diagnostics.fallbackUsed, undefined);
        return true;
    });
});

test("OpenAIResponseProvider - non-completed HTTP 200 responses are not retried", async () => {
    const statuses = ["incomplete", "queued", "in_progress", "failed", "cancelled"];
    for (const status of statuses) {
        let calls = 0;
        let sleepCalled = 0;
        const body = { id: "res_1", status, output: [] };
        const mockFetch = async () => {
            calls++;
            return { ok: true, status: 200, headers: new Map(), json: async () => body };
        };
        const provider = new OpenAIResponseProvider({
            apiKey: "key",
            fetch: mockFetch,
            sleep: async () => { sleepCalled++; },
            maxRetries: 1,
            fallbackToPseudo: false
        });
        await assert.rejects(provider.generateResponse(dummyRequest), (err) => {
            const expectedType = (status === "failed" || status === "cancelled")
              ? ERROR_TYPES.PROVIDER_SERVER_ERROR
              : ERROR_TYPES.INVALID_PROVIDER_RESPONSE;
            assert.equal(err.type, expectedType);
            assert.ok(err.message.includes(status));
            return true;
        });
        assert.equal(calls, 1, `Status ${status} should perform exactly one fetch`);
        assert.equal(sleepCalled, 0, `Sleep should not be called for status ${status}`);
    }
});

test("OpenAIResponseProvider - edge case: refusal, failed/cancelled status", async () => {
    const cases = [
        { body: { status: "failed", output: [] }, type: ERROR_TYPES.PROVIDER_SERVER_ERROR },
        { body: { status: "cancelled", output: [] }, type: ERROR_TYPES.PROVIDER_SERVER_ERROR },
        { body: { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "I cannot" }] }] }, type: ERROR_TYPES.INVALID_PROVIDER_RESPONSE }
    ];

    for (const { body, type } of cases) {
        const mockFetch = async () => ({ ok: true, status: 200, headers: new Map(), json: async () => body });
        const provider = new OpenAIResponseProvider({ apiKey: "key", fetch: mockFetch, fallbackToPseudo: false });
        await assert.rejects(provider.generateResponse(dummyRequest), (err) => {
            assert.equal(err.type, type);
            return true;
        });
    }
});

test("OpenAIResponseProvider - edge cases: empty, whitespace, code fences, too long", async () => {
    const cases = [
        { text: "", label: "empty" },
        { text: "   ", label: "whitespace" },
        { text: "```js\nconsole.log()```", label: "code fences" },
        { text: "a".repeat(2001), label: "too long" }
    ];

    for (const { text, label } of cases) {
        const response = JSON.parse(JSON.stringify(officialSuccessResponse));
        response.output[0].content[0].text = text;
        const mockFetch = async () => ({ ok: true, status: 200, headers: new Map(), json: async () => response });
        const provider = new OpenAIResponseProvider({ apiKey: "key", fetch: mockFetch, fallbackToPseudo: false });
        await assert.rejects(provider.generateResponse(dummyRequest), (err) => {
            assert.equal(err.type, ERROR_TYPES.INVALID_PROVIDER_RESPONSE, `Should reject ${label}`);
            return true;
        });
    }
});

test("OpenAIResponseProvider - invalid JSON response body", async () => {
    const mockFetch = async () => ({
        ok: true, status: 200, headers: new Map(),
        json: async () => { throw new Error("Parse error"); }
    });
    const provider = new OpenAIResponseProvider({ apiKey: "key", fetch: mockFetch, fallbackToPseudo: false });
    await assert.rejects(provider.generateResponse(dummyRequest), (err) => {
        assert.equal(err.type, ERROR_TYPES.INVALID_PROVIDER_RESPONSE);
        return true;
    });
});

test("OpenAIResponseProvider - cancellation during retry backoff", async () => {
    let calls = 0;
    const mockFetch = async () => {
        calls++;
        return { ok: false, status: 500, headers: new Map(), json: async () => ({}) };
    };

    const controller = new AbortController();
    const mockSleep = async (ms, signal) => {
        controller.abort();
        return new Promise((_, reject) => {
            if (signal.aborted) return reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    };

    const provider = new OpenAIResponseProvider({
        apiKey: "key",
        fetch: mockFetch,
        sleep: mockSleep,
        maxRetries: 1,
        fallbackToPseudo: false
    });

    await assert.rejects(provider.generateResponse(dummyRequest, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls, 1, "Should not start second request after abort");
});

test("OpenAIResponseProvider - timeout during body reading", async () => {
    const mockFetch = async (url, options) => {
        return {
            ok: true,
            status: 200,
            headers: new Map(),
            json: async () => {
                await new Promise((resolve, reject) => {
                    if (options.signal.aborted) return reject(options.signal.reason);
                    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
                });
            }
        };
    };
    const provider = new OpenAIResponseProvider({ apiKey: "key", fetch: mockFetch, timeoutMs: 10, fallbackToPseudo: false });
    await assert.rejects(provider.generateResponse(dummyRequest), (err) => {
        // Body reading timeout can either be TIMEOUT or INVALID_PROVIDER_RESPONSE
        // depending on whether the AbortError from fetch signal or our catch block wins.
        // In our current implementation, fetch throws AbortError which we map to TIMEOUT.
        // Wait, if json() throws AbortError, it's caught in _fetchOpenAI.
        return err.type === ERROR_TYPES.TIMEOUT || err.type === ERROR_TYPES.INVALID_PROVIDER_RESPONSE;
    });
});

test("OpenAIResponseProvider - slot release after various outcomes", async () => {
    const provider = new OpenAIResponseProvider({ apiKey: "key", maxConcurrent: 1 });

    // Success
    const mockSuccess = async () => ({ ok: true, status: 200, headers: new Map(), json: async () => officialSuccessResponse });
    provider.fetch = mockSuccess;
    await provider.generateResponse(dummyRequest);
    assert.equal(provider.activeRequests, 0, "Slot released after success");

    // Failure
    const mockFail = async () => ({ ok: false, status: 401, headers: new Map(), json: async () => ({}) });
    provider.fetch = mockFail;
    provider.fallbackToPseudo = false;
    await assert.rejects(provider.generateResponse(dummyRequest));
    assert.equal(provider.activeRequests, 0, "Slot released after failure");

    // Timeout
    const mockTimeout = async () => { const err = new Error(); err.name = "AbortError"; throw err; };
    provider.fetch = mockTimeout;
    await assert.rejects(provider.generateResponse(dummyRequest));
    assert.equal(provider.activeRequests, 0, "Slot released after timeout");
});
