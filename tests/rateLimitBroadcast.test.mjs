import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config.mjs";
import { createWebServer } from "../src/webServer.mjs";

// Regression coverage for the 2026-11-11 playtests: broadcast questions
// (ask_all) send up to nine /api/npc-response calls in a burst, and the
// server's own rate limiter (then defaulting to 10 requests/minute)
// rejected most of them with 429 "Too many requests", which surfaced in
// the game as NPCs failing to answer. The default limit must fit a
// broadcast plus follow-up questions, while the limiter itself keeps
// guarding against runaway use.

const REQUEST_BODY = JSON.stringify({
  npc: { id: "npc1", name: "Aoi", personality: "P", speechStyle: "S", conversationPolicy: { truthfulness: "t", roleClaim: "r", allowedTactics: [], forbidden: [] } },
  playerInput: "Hello",
  context: { day: 1, phase: "day", publicEvidence: [], shareableKnownEvidence: [], privateStanceEvidence: [], publicClaims: [], intent: { asksWerewolfIdentity: false, asksRoleOrClaim: false, asksVoteReason: false }, topSuspect: null },
  policyDecision: { publicClaimAllowed: false, publicClaim: null, disclosedHiddenInfo: false },
  responsePlan: { baseText: "B", speechStyle: "S" },
  evidenceUsed: []
});

const mockProvider = {
  name: "mock",
  generateResponse: async () => ({ text: "ok", providerName: "mock" })
};

async function startTestServer(options) {
  const server = createWebServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { port, close };
}

async function postNpcResponse(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/npc-response`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: REQUEST_BODY
  });
  await res.text();
  return res.status;
}

test("default rate limit fits a nine-NPC broadcast plus follow-ups", async () => {
  const config = parseConfig({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "unit-test-credential" });
  assert.equal(config.openai.maxRequestsPerMinute, 30);
  const { port, close } = await startTestServer({ config, provider: mockProvider });
  try {
    const statuses = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push(await postNpcResponse(port));
    }
    assert.deepEqual(statuses, Array(12).fill(200));
  } finally {
    await close();
  }
});

test("the rate limiter still rejects bursts above an explicit small limit", async () => {
  const config = parseConfig({
    LLM_PROVIDER: "openai",
    OPENAI_API_KEY: "unit-test-credential",
    OPENAI_MAX_REQUESTS_PER_MINUTE: "3"
  });
  const { port, close } = await startTestServer({ config, provider: mockProvider });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push(await postNpcResponse(port));
    }
    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
    assert.deepEqual(statuses.slice(3), [429, 429]);
  } finally {
    await close();
  }
});
