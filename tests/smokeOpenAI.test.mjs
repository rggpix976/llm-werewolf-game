import assert from "node:assert/strict";
import test from "node:test";
import { runSmokeTest, EXIT_CODES } from "../scripts/smoke-openai-live.mjs";
import { ERROR_TYPES } from "../src/openaiProvider.mjs";

const officialSuccessResponse = {
  id: "resp_smoke_test",
  status: "completed",
  output: [
    {
      id: "msg_smoke",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Chikaさんは怪しいと思います。"
        }
      ]
    }
  ],
  usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
};

const validEnv = {
    OPENAI_LIVE_SMOKE_TEST: "I_ACCEPT_API_CHARGES",
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "sk-test-key",
    OPENAI_MODEL: "gpt-smoke-test"
};

test("Smoke test logic - safety gate: missing opt-in", async () => {
    await assert.rejects(runSmokeTest({ env: { ...validEnv, OPENAI_LIVE_SMOKE_TEST: "" }, silent: true }), (err) => {
        assert.equal(err.code, EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE);
        assert.match(err.message, /Missing or invalid OPENAI_LIVE_SMOKE_TEST/);
        return true;
    });
});

test("Smoke test logic - safety gate: incorrect opt-in value", async () => {
    await assert.rejects(runSmokeTest({ env: { ...validEnv, OPENAI_LIVE_SMOKE_TEST: "true" }, silent: true }), (err) => {
        assert.equal(err.code, EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE);
        return true;
    });
});

test("Smoke test logic - safety gate: missing API key", async () => {
    await assert.rejects(runSmokeTest({ env: { ...validEnv, OPENAI_API_KEY: "" }, silent: true }), (err) => {
        assert.equal(err.code, EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE);
        assert.match(err.message, /OPENAI_API_KEY is missing/);
        return true;
    });
});

test("Smoke test logic - safety gate: whitespace API key", async () => {
    await assert.rejects(runSmokeTest({ env: { ...validEnv, OPENAI_API_KEY: "   " }, silent: true }), (err) => {
        assert.equal(err.code, EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE);
        return true;
    });
});

test("Smoke test logic - safety gate: LLM_PROVIDER other than openai", async () => {
    await assert.rejects(runSmokeTest({ env: { ...validEnv, LLM_PROVIDER: "pseudo" }, silent: true }), (err) => {
        assert.equal(err.code, EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE);
        assert.match(err.message, /LLM_PROVIDER must be 'openai'/);
        return true;
    });
});

test("Smoke test logic - successful mocked response", async () => {
    let capturedFetchOptions;
    const mockFetch = async (url, options) => {
        capturedFetchOptions = options;
        return {
            ok: true,
            status: 200,
            headers: new Map([["x-request-id", "req_smoke_success"]]),
            json: async () => officialSuccessResponse
        };
    };

    const result = await runSmokeTest({ env: validEnv, fetch: mockFetch, silent: true });
    assert.equal(result.pass, true);
    assert.equal(result.body.text, "Chikaさんは怪しいと思います。");
    assert.equal(result.body.providerName, "openai");
    assert.equal(result.body.model, "gpt-smoke-test");

    // Check request content
    const body = JSON.parse(capturedFetchOptions.body);
    assert.equal(body.max_output_tokens, 120, "Output tokens must be capped at 120");
    assert.equal(body.store, false, "store must be false");
    assert.ok(!body.tools, "tools must not be configured");
});

test("Smoke test logic - fallback results in failure", async () => {
    const mockFetch = async () => ({
        ok: false,
        status: 429,
        headers: new Map(),
        json: async () => ({})
    });

    // The script disables fallback anyway, but if it somehow happened, it must not PASS.
    await assert.rejects(runSmokeTest({ env: validEnv, fetch: mockFetch, silent: true }), (err) => {
        assert.equal(err.code, EXIT_CODES.PROVIDER_API_FAILURE);
        return true;
    });
});

test("Smoke test logic - exactly one fetch occurs (no retries)", async () => {
    let fetchCount = 0;
    const mockFetch = async () => {
        fetchCount++;
        return { ok: false, status: 500, headers: new Map(), json: async () => ({}) };
    };

    await assert.rejects(runSmokeTest({ env: validEnv, fetch: mockFetch, silent: true }));
    assert.equal(fetchCount, 1, "Should only perform one fetch");
});

test("Smoke test logic - authentication failure", async () => {
    const mockFetch = async () => ({
        ok: false,
        status: 401,
        headers: new Map(),
        json: async () => ({ error: { message: "Invalid API key" } })
    });

    await assert.rejects(runSmokeTest({ env: validEnv, fetch: mockFetch, silent: true }), (err) => {
        assert.equal(err.code, EXIT_CODES.PROVIDER_API_FAILURE);
        assert.equal(err.status, 502); // Web server maps 401 to 502
        return true;
    });
});

test("Smoke test logic - API key protection", async () => {
    const mockFetch = async () => ({
        ok: false,
        status: 401,
        headers: new Map(),
        json: async () => ({ error: { message: "Auth failed for " + validEnv.OPENAI_API_KEY } })
    });

    try {
        await runSmokeTest({ env: validEnv, fetch: mockFetch, silent: true });
    } catch (err) {
        assert.ok(!JSON.stringify(err).includes(validEnv.OPENAI_API_KEY), "API key should not be in error diagnostics");
        assert.ok(!err.message.includes(validEnv.OPENAI_API_KEY), "API key should not be in error message");
    }
});

test("Smoke test logic - production request usage", async () => {
    let capturedProductionRequest;
    // We can't easily capture the post to local server without mocking fetch globally or within the script.
    // But since we injected fetch into OpenAIResponseProvider, we can see what it receives.
    let capturedOpenAIInput;
    const mockFetch = async (url, options) => {
        const body = JSON.parse(options.body);
        capturedOpenAIInput = JSON.parse(body.input[0].content[0].text);
        return { ok: true, status: 200, headers: new Map(), json: async () => officialSuccessResponse };
    };

    await runSmokeTest({ env: validEnv, fetch: mockFetch, silent: true });

    assert.equal(capturedOpenAIInput.npc.name, "Aoi");
    assert.match(capturedOpenAIInput.playerInput, /Chika/);
    assert.ok(capturedOpenAIInput.context.publicEvidence.length > 0, "Should contain production public evidence");
    assert.equal(capturedOpenAIInput.context.privateStanceEvidence, undefined, "Private evidence must be redacted");
});

test("Smoke test logic - rate limit failure", async () => {
    let fetchCount = 0;
    const mockFetch = async () => {
        fetchCount++;
        return { ok: false, status: 429, headers: new Map(), json: async () => ({}) };
    };

    await assert.rejects(runSmokeTest({ env: validEnv, fetch: mockFetch, silent: true }), (err) => {
        assert.equal(err.code, EXIT_CODES.PROVIDER_API_FAILURE);
        return true;
    });
    assert.equal(fetchCount, 1);
});

test("Smoke test logic - timeout failure", async () => {
    let fetchCount = 0;
    const mockFetch = async () => {
        fetchCount++;
        const err = new Error("timeout");
        err.name = "AbortError";
        throw err;
    };

    await assert.rejects(runSmokeTest({ env: validEnv, fetch: mockFetch, silent: true }), (err) => {
        assert.equal(err.code, EXIT_CODES.PROVIDER_API_FAILURE);
        return true;
    });
    assert.equal(fetchCount, 1);
});

test("Smoke test logic - invalid provider response failure", async () => {
    let fetchCount = 0;
    const mockFetch = async () => {
        fetchCount++;
        return { ok: true, status: 200, headers: new Map(), json: async () => ({ status: "incomplete" }) };
    };

    await assert.rejects(runSmokeTest({ env: validEnv, fetch: mockFetch, silent: true }), (err) => {
        assert.equal(err.code, EXIT_CODES.PROVIDER_API_FAILURE);
        return true;
    });
    assert.equal(fetchCount, 1);
});
