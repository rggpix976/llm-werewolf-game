import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSmokeTest, EXIT_CODES, createOneCallFetch } from "../scripts/smoke-openai-live.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, "../scripts/smoke-openai-live.mjs");

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
    OPENAI_API_KEY: "<test-api-key>",
    OPENAI_MODEL: "gpt-smoke-test"
};

const silentLogger = { log: () => {}, error: () => {} };

function runScript(env = {}) {
    return spawnSync("node", [scriptPath], {
        env: {
            ...process.env,
            ...env
        },
        encoding: "utf-8"
    });
}

// 1. CLI Process Tests
test("CLI - refuses without credentials with clear explanation (Exit Code 1)", () => {
    const result = runScript({
        OPENAI_LIVE_SMOKE_TEST: "",
        LLM_PROVIDER: "openai",
        OPENAI_API_KEY: "<test-api-key>"
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing or invalid OPENAI_LIVE_SMOKE_TEST/);
    assert.ok(!result.stdout.includes("Local server listening"), "Should not start server");
});

test("CLI - invalid config (timeout) prints safe error (Exit Code 1)", () => {
    const result = runScript({
        ...validEnv,
        OPENAI_TIMEOUT_MS: "999999"
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OPENAI_TIMEOUT_MS must be between/);
});

// 2. Unit Test: Shared One-Call Guard
test("createOneCallFetch - block second outbound request locally", async () => {
    let originalFetchCount = 0;
    const mockOriginalFetch = async (url) => {
        originalFetchCount++;
        return { ok: true, status: 200, url };
    };

    const guard = createOneCallFetch(mockOriginalFetch);
    assert.equal(guard.getCallCount(), 0);

    const res1 = await guard.fetch("http://api.openai.com/v1/test", {});
    assert.equal(res1.status, 200);
    assert.equal(guard.getCallCount(), 1);
    assert.equal(originalFetchCount, 1);

    await assert.rejects(guard.fetch("http://api.openai.com/v1/second", {}), (err) => {
        assert.match(err.message, /Blocked second outbound OpenAI request/);
        return true;
    });

    assert.equal(guard.getCallCount(), 1, "Call count should not increment on blocked attempt");
    assert.equal(originalFetchCount, 1, "Original fetch should not be called a second time");
});

// 3. Logic & In-Process Tests (Safety Gates)
test("Smoke test logic - safety gate: missing opt-in (Exit 1)", async () => {
    await assert.rejects(runSmokeTest({ env: { ...validEnv, OPENAI_LIVE_SMOKE_TEST: "" }, logger: silentLogger }), (err) => {
        assert.equal(err.exitCode, EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE);
        assert.match(err.message, /Missing or invalid OPENAI_LIVE_SMOKE_TEST/);
        return true;
    });
});

test("Smoke test logic - safety gate: incorrect opt-in value (Exit 1)", async () => {
    await assert.rejects(runSmokeTest({ env: { ...validEnv, OPENAI_LIVE_SMOKE_TEST: "true" }, logger: silentLogger }), (err) => {
        assert.equal(err.exitCode, EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE);
        return true;
    });
});

test("Smoke test logic - safety gate: LLM_PROVIDER other than openai (Exit 1)", async () => {
    await assert.rejects(runSmokeTest({ env: { ...validEnv, LLM_PROVIDER: "pseudo" }, logger: silentLogger }), (err) => {
        assert.equal(err.exitCode, EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE);
        return true;
    });
});

test("Smoke test logic - safety gate: missing API key (Exit 1)", async () => {
    await assert.rejects(runSmokeTest({ env: { ...validEnv, OPENAI_API_KEY: "" }, logger: silentLogger }), (err) => {
        assert.equal(err.exitCode, EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE);
        return true;
    });
});

test("Smoke test logic - safety gate: whitespace API key (Exit 1)", async () => {
    await assert.rejects(runSmokeTest({ env: { ...validEnv, OPENAI_API_KEY: "   " }, logger: silentLogger }), (err) => {
        assert.equal(err.exitCode, EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE);
        return true;
    });
});

test("Smoke test logic - safety gate: no outbound fetch occurs on failure", async () => {
    let fetchCalled = false;
    const mockFetch = async () => { fetchCalled = true; return { ok: true }; };
    try {
        await runSmokeTest({ env: { ...validEnv, OPENAI_API_KEY: "" }, fetch: mockFetch, logger: silentLogger });
    } catch (e) {
        // Expected
    }
    assert.equal(fetchCalled, false, "Fetch should not be called if safety gate fails");
});

// 4. Success Case & Invariants
test("Smoke test logic - successful mocked response, cost controls, and secret protection", async () => {
    let capturedRequest;
    let logBuffer = "";
    const mockFetch = async (url, options) => {
        if (url.includes("api.openai.com")) {
            capturedRequest = { url, options, body: JSON.parse(options.body) };
            return {
                ok: true, status: 200, headers: new Map([["x-request-id", "req_success"]]),
                json: async () => officialSuccessResponse
            };
        }
        return globalThis.fetch(url, options);
    };

    const logger = {
        log: (m) => { logBuffer += m + "\n"; },
        error: (m) => { logBuffer += m + "\n"; }
    };

    const result = await runSmokeTest({ env: validEnv, fetch: mockFetch, logger });

    assert.equal(result.pass, true);
    assert.equal(result.networkCallCount, 1);
    assert.equal(capturedRequest.options.headers["Authorization"], "Bearer <test-api-key>");

    // Cost control: max output tokens <= 120, store: false, no tools
    assert.ok(capturedRequest.body.max_output_tokens <= 120);
    assert.equal(capturedRequest.body.store, false);
    assert.ok(!capturedRequest.body.tools);

    // Secret protection
    const bodyStr = JSON.stringify(capturedRequest.body);
    assert.ok(!bodyStr.includes("<test-api-key>"), "Key leaked in request body");
    assert.ok(!logBuffer.includes("<test-api-key>"), "Key leaked in console output");
    assert.ok(!JSON.stringify(result.body).includes("<test-api-key>"), "Key leaked in result");

    // Redaction of private evidence
    const inputText = JSON.parse(capturedRequest.body.input[0].content[0].text);
    assert.equal(inputText.context.privateStanceEvidence, undefined, "Private evidence leaked in input");

    assert.match(logBuffer, /Local server closed\./);
});

// 5. Provider & Communication Failures
test("Smoke test logic - upstream OpenAI 400 maps to EXIT 3", async () => {
    const mockFetch = async (url) => {
        if (url.includes("api.openai.com")) {
            return {
                ok: false, status: 400, headers: new Map(),
                json: async () => ({ error: { message: "Bad request" } })
            };
        }
        return globalThis.fetch(url);
    };

    await assert.rejects(runSmokeTest({ env: validEnv, fetch: mockFetch, logger: silentLogger }), (err) => {
        assert.equal(err.exitCode, 3);
        assert.equal(err.diagnostics.providerName, "openai");
        return true;
    });
});

test("Smoke test logic - authentication failure performs exactly one outbound call (Exit 3)", async () => {
    let fetchCount = 0;
    const mockFetch = async (url) => {
        if (url.includes("api.openai.com")) {
            fetchCount++;
            return { ok: false, status: 401, headers: new Map(), json: async () => ({}) };
        }
        return globalThis.fetch(url);
    };
    await assert.rejects(runSmokeTest({ env: validEnv, fetch: mockFetch, logger: silentLogger }), { exitCode: 3 });
    assert.equal(fetchCount, 1);
});

test("Smoke test logic - rate limit failure performs exactly one outbound call (Exit 3)", async () => {
    let fetchCount = 0;
    const mockFetch = async (url) => {
        if (url.includes("api.openai.com")) {
            fetchCount++;
            return { ok: false, status: 429, headers: new Map(), json: async () => ({}) };
        }
        return globalThis.fetch(url);
    };
    await assert.rejects(runSmokeTest({ env: validEnv, fetch: mockFetch, logger: silentLogger }), { exitCode: 3 });
    assert.equal(fetchCount, 1);
});

test("Smoke test logic - timeout performs exactly one outbound call (Exit 3)", async () => {
    let fetchCount = 0;
    const mockFetch = async (url) => {
        if (url.includes("api.openai.com")) {
            fetchCount++;
            const e = new Error("timeout"); e.name = "AbortError"; throw e;
        }
        return globalThis.fetch(url);
    };
    await assert.rejects(runSmokeTest({ env: validEnv, fetch: mockFetch, logger: silentLogger }), { exitCode: 3 });
    assert.equal(fetchCount, 1);
});

test("Smoke test logic - invalid provider response performs exactly one outbound call (Exit 3)", async () => {
    let fetchCount = 0;
    const mockFetch = async (url) => {
        if (url.includes("api.openai.com")) {
            fetchCount++;
            return { ok: true, status: 200, headers: new Map(), json: async () => ({ status: "incomplete" }) };
        }
        return globalThis.fetch(url);
    };
    await assert.rejects(runSmokeTest({ env: validEnv, fetch: mockFetch, logger: silentLogger }), { exitCode: 3 });
    assert.equal(fetchCount, 1);
});

// 6. Local Validation Failure
test("Smoke test logic - local request validation failure maps to EXIT 2", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (typeof url === "string" && url.includes("/api/npc-response")) {
            return {
                ok: false, status: 400,
                json: async () => ({ error: "Local validation failed", type: "bad_request", diagnostics: { providerName: "unknown" } })
            };
        }
        return originalFetch(url);
    };

    try {
        await assert.rejects(runSmokeTest({ env: validEnv, logger: silentLogger }), (err) => {
            assert.equal(err.exitCode, 2);
            return true;
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// 7. Smoke Assertion Failures & Cleanup
test("Smoke test logic - pseudo/fallback results cannot PASS (Exit 4)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (typeof url === "string" && url.includes("/api/npc-response")) {
            return {
                ok: true, status: 200,
                json: async () => ({
                    text: "FALLBACK", providerName: "pseudo",
                    diagnostics: { fallbackUsed: true, providerStatus: "completed" },
                    model: "m"
                })
            };
        }
        return originalFetch(url);
    };

    try {
        await assert.rejects(runSmokeTest({ env: validEnv, logger: silentLogger }), (err) => {
            assert.equal(err.exitCode, 4);
            assert.match(err.message, /Pseudo fallback was used/);
            return true;
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("Smoke test logic - server cleanup after success", async () => {
    let logBuffer = "";
    const logger = { log: (m) => { logBuffer += m + "\n"; }, error: () => {} };
    const mockFetch = async (url) => {
        if (url.includes("api.openai.com")) {
            return { ok: true, status: 200, headers: new Map(), json: async () => officialSuccessResponse };
        }
        return globalThis.fetch(url);
    };
    await runSmokeTest({ env: validEnv, fetch: mockFetch, logger });
    assert.match(logBuffer, /Local server closed\./);
});

test("Smoke test logic - server cleanup after assertion failure (Exit 4)", async () => {
    let logBuffer = "";
    const logger = { log: (m) => { logBuffer += m + "\n"; }, error: () => {} };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (typeof url === "string" && url.includes("/api/npc-response")) {
            return {
                ok: true, status: 200,
                json: async () => ({
                    text: "Fail", providerName: "pseudo",
                    model: "m", diagnostics: { providerStatus: "completed" }
                })
            };
        }
        return originalFetch(url);
    };

    try {
        await assert.rejects(runSmokeTest({ env: validEnv, logger }), { exitCode: 4 });
        assert.match(logBuffer, /Local server closed\./);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// 8. Miscellaneous
test("Smoke test logic - does not create any files", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "smoke-test-check-"));
    const cwd = process.cwd();

    try {
        process.chdir(tmpDir);
        const before = await fs.readdir(".");

        const mockFetch = async (url) => {
            if (url.includes("api.openai.com")) {
                return {
                    ok: true, status: 200, headers: new Map(),
                    json: async () => officialSuccessResponse
                };
            }
            const fullUrl = url.startsWith("http") ? url : `http://127.0.0.1${url}`;
            return globalThis.fetch(fullUrl);
        };

        await runSmokeTest({ env: validEnv, fetch: mockFetch, logger: silentLogger });

        const after = await fs.readdir(".");
        assert.deepEqual(before, after, "No files should be created by the smoke test");
    } finally {
        process.chdir(cwd);
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
});

test("Smoke test logic - SIGINT handling (Exit Code 130)", async () => {
    const controller = new AbortController();
    let logBuffer = "";
    const logger = { log: (m) => { logBuffer += m + "\n"; }, error: () => {} };

    const promise = runSmokeTest({ env: validEnv, signal: controller.signal, logger });
    controller.abort();

    await assert.rejects(promise, (err) => {
        assert.equal(err.exitCode, 130);
        return true;
    });
    assert.match(logBuffer, /Local server closed\./);
});
