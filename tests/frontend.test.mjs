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
