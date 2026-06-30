import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, HttpResponseProvider } from "../public/httpResponseProvider.mjs";

test("SessionManager - startNewGame aborts active controllers", () => {
  const sm = new SessionManager();
  const controller = new AbortController();
  let aborted = false;
  controller.signal.addEventListener("abort", () => { aborted = true; });

  sm.registerRequest(controller);
  sm.startNewGame();

  assert.equal(aborted, true);
  assert.equal(sm.currentGameId, 1);
});

test("HttpResponseProvider - aborted request settles promptly", async () => {
  const sm = new SessionManager();
  const provider = new HttpResponseProvider({ sessionManager: sm });

  // Mock fetch that hangs
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
        });
    });
  };

  try {
    const promise = provider.generateResponse({});
    sm.startNewGame(); // Abort the request

    await assert.rejects(promise, (err) => {
      assert.equal(err.name, "AbortError");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HttpResponseProvider - error propagation (502 invalid_provider_response)", async () => {
    const provider = new HttpResponseProvider();
    const originalFetch = globalThis.fetch;
    const diagnostics = { providerName: "openai", upstreamHttpStatus: 200 };

    globalThis.fetch = async () => ({
        ok: false,
        status: 502,
        json: async () => ({
            error: "The provider returned an invalid response.",
            type: "invalid_provider_response",
            diagnostics
        })
    });

    try {
        await assert.rejects(provider.generateResponse({}), (err) => {
            assert.equal(err.name, "ResponseProviderError");
            assert.equal(err.status, 502);
            assert.equal(err.type, "invalid_provider_response");
            assert.deepEqual(err.diagnostics, diagnostics);
            assert.equal(err.diagnostics.providerName, "openai");
            return true;
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});
