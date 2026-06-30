import assert from "node:assert/strict";
import test from "node:test";
import { createWebServer } from "../src/webServer.mjs";

async function startTestServer(options) {
  const server = createWebServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { server, port, close };
}

test("GET /api/runtime-config returns config without secrets", async () => {
  const { port, close } = await startTestServer({
    config: {
        provider: "openai",
        openai: { apiKey: "secret-key", model: "gpt-o1", fallbackToPseudo: true }
    }
  });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/runtime-config`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const data = await res.json();
    assert.equal(data.provider, "openai");
    assert.equal(data.model, "gpt-o1");
    assert.equal(data.fallbackEnabled, true);
    assert.ok(!JSON.stringify(data).includes("secret-key"));
  } finally {
    await close();
  }
});

test("POST /api/npc-response success", async () => {
  const mockProvider = {
    name: "mock",
    generateResponse: async () => ({ text: "Mock Response", providerName: "mock" })
  };
  const { port, close } = await startTestServer({ provider: mockProvider });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/npc-response`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
          npc: { id: "n1", name: "n1", personality: "p", speechStyle: "s", conversationPolicy: { truthfulness: "t", roleClaim: "r", allowedTactics: [], forbidden: [] } },
          playerInput: "h",
          context: { day: 1, phase: "p", publicEvidence: [], shareableKnownEvidence: [], privateStanceEvidence: [], publicClaims: [], intent: { asksWerewolfIdentity: false, asksRoleOrClaim: false, asksVoteReason: false }, topSuspect: null },
          policyDecision: { publicClaimAllowed: false, publicClaim: null, disclosedHiddenInfo: false },
          responsePlan: { baseText: "b", speechStyle: "s" },
          evidenceUsed: []
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.text, "Mock Response");
  } finally {
    await close();
  }
});

test("POST /api/npc-response rate limit", async () => {
    const rateLimiter = { allow: () => false };
    const { port, close } = await startTestServer({ rateLimiter });
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/npc-response`, { method: "POST" });
        assert.equal(res.status, 429);
        const data = await res.json();
        assert.equal(data.type, "rate_limit");
    } finally {
        await close();
    }
});

test("POST /api/npc-response content-type handling", async () => {
    const { port, close } = await startTestServer({});
    try {
        const cases = [
            { ct: "application/json", expected: 400 },
            { ct: "APPLICATION/JSON", expected: 400 },
            { ct: "application/json; charset=utf-8", expected: 400 },
            { ct: "text/plain", expected: 415 },
            { ct: "application/json-evil", expected: 415 }
        ];
        for (const { ct, expected } of cases) {
            const res = await fetch(`http://127.0.0.1:${port}/api/npc-response`, {
                method: "POST",
                headers: { "Content-Type": ct }
            });
            assert.equal(res.status, expected, `Content-Type ${ct} should result in ${expected}`);
        }
    } finally {
        await close();
    }
});

test("POST /api/npc-response too large body (bytes)", async () => {
    const { port, close } = await startTestServer({});
    try {
        const bigBody = JSON.stringify({ data: "a".repeat(70000) });
        const res = await fetch(`http://127.0.0.1:${port}/api/npc-response`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: bigBody
        });
        assert.equal(res.status, 413);
    } finally {
        await close();
    }
});

test("Static file delivery - index.html", async () => {
  const { port, close } = await startTestServer({});
  try {
    const res = await fetch(`http://127.0.0.1:${port}/index.html`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.toLowerCase().includes("<!doctype html>"));
  } finally {
    await close();
  }
});

test("POST /api/npc-response sanitized error", async () => {
    const mockProvider = {
        name: "mock",
        generateResponse: async () => {
            const err = new Error("Evil stack trace");
            err.upstreamStatus = 500;
            err.type = "provider_server_error";
            throw err;
        }
    };
    const { port, close } = await startTestServer({ provider: mockProvider });
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/npc-response`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                npc: { id: "n1", name: "n1", personality: "p", speechStyle: "s", conversationPolicy: { truthfulness: "t", roleClaim: "r", allowedTactics: [], forbidden: [] } },
                playerInput: "h",
                context: { day: 1, phase: "p", publicEvidence: [], shareableKnownEvidence: [], privateStanceEvidence: [], publicClaims: [], intent: { asksWerewolfIdentity: false, asksRoleOrClaim: false, asksVoteReason: false }, topSuspect: null },
                policyDecision: { publicClaimAllowed: false, publicClaim: null, disclosedHiddenInfo: false },
                responsePlan: { baseText: "b", speechStyle: "s" },
                evidenceUsed: []
            })
        });
        assert.equal(res.status, 502);
        const data = await res.json();
        assert.ok(!JSON.stringify(data).includes("Evil stack trace"));
        assert.ok(data.error);
        assert.equal(data.type, "provider_server_error");
    } finally {
        await close();
    }
});
