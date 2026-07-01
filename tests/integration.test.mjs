import assert from "node:assert/strict";
import test from "node:test";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { createWebServer } from "../src/webServer.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";
import { buildNpcResponseRequest } from "../src/responseGenerator.mjs";
import http from "node:http";

async function startTestServer(options) {
    const server = createWebServer(options);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const close = () => new Promise((resolve) => server.close(resolve));
    return { server, port, close };
}

test("Integration: Client disconnect propagates abort to provider", async () => {
    let providerSignal;
    let resolveAborted;
    const providerAbortedPromise = new Promise((resolve) => {
        resolveAborted = resolve;
    });

    const mockProvider = {
        name: "mock",
        generateResponse: async (request, options) => {
            providerSignal = options.signal;
            if (options.signal.aborted) {
                resolveAborted(true);
            } else {
                options.signal.addEventListener("abort", () => resolveAborted(true), { once: true });
            }
            await providerAbortedPromise;
            return { text: "aborted", providerName: "mock" };
        }
    };

    const { port, close } = await startTestServer({
        llmProvider: "mock",
        provider: mockProvider
    });

    const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/api/npc-response",
        method: "POST",
        headers: { "Content-Type": "application/json" }
    });
    req.on("error", () => {});

    const body = JSON.stringify({
        npc: { id: "npc1", name: "Aoi", personality: "P", speechStyle: "S", conversationPolicy: { truthfulness: "t", roleClaim: "r", allowedTactics: [], forbidden: [] } },
        playerInput: "Hello",
        context: { day: 1, phase: "day", publicEvidence: [], shareableKnownEvidence: [], privateStanceEvidence: [], publicClaims: [], intent: { asksWerewolfIdentity: false, asksRoleOrClaim: false, asksVoteReason: false }, topSuspect: null },
        policyDecision: { publicClaimAllowed: false, publicClaim: null, disclosedHiddenInfo: false },
        responsePlan: { baseText: "B", speechStyle: "S" },
        evidenceUsed: []
    });

    req.write(body);
    req.end();

    // Poll until request reaches provider
    for (let i = 0; i < 50; i++) {
        if (providerSignal) break;
        await new Promise(r => setTimeout(r, 20));
    }

    assert.ok(providerSignal, "Request should have reached provider");

    // Disconnect client
    req.destroy();

    // Wait for propagation (timeout if it fails)
    const propagationTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for abort propagation")), 2000));
    await Promise.race([providerAbortedPromise, propagationTimeout]);

    assert.ok(providerSignal.aborted, "Provider signal should be aborted after client disconnect");

    await close();
});

test("Integration: Full flow with real WerewolfGame request (Pseudo)", async () => {
    const game = WerewolfGame.create({ seed: 1 });
    const npc = game.getPlayer("npc1");
    const prepared = buildNpcResponseRequest(npc, game.state, "Hello");

    const { port, close } = await startTestServer({
        llmProvider: "pseudo",
        provider: new PseudoResponseProvider()
    });

    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/npc-response`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(prepared.request)
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.providerName, "pseudo");
        assert.ok(data.text);
    } finally {
        await close();
    }
});

test("Integration: Full flow with mocked OpenAI raw contract", async () => {
    const game = WerewolfGame.create({ seed: 1 });
    const npc = game.getPlayer("npc1");
    const prepared = buildNpcResponseRequest(npc, game.state, "Who is the werewolf?");

    let capturedBody;
    let capturedHeaders;
    const mockFetch = async (url, options) => {
        capturedBody = JSON.parse(options.body);
        capturedHeaders = options.headers;
        return {
            ok: true,
            status: 200,
            headers: new Map([["x-request-id", "req_integration"]]),
            json: async () => ({
                id: "resp_integration",
                status: "completed",
                output: [{
                    type: "message",
                    status: "completed",
                    content: [{ type: "output_text", text: "私は占い師です。" }]
                }],
                usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
            })
        };
    };

    const { port, close } = await startTestServer({
        config: {
            provider: "openai",
            openai: {
                apiKey: "test-key",
                model: "gpt-5.4-mini",
                timeoutMs: 15000,
                maxRetries: 1,
                maxOutputTokens: 220,
                maxRequestsPerMinute: 60,
                fallbackToPseudo: true,
                fetch: mockFetch
            }
        }
    });

    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/npc-response`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(prepared.request)
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.text, "私は占い師です。");
        assert.equal(data.providerName, "openai");
        assert.equal(data.diagnostics.requestId, "req_integration");

        // Verify raw contract
        assert.equal(capturedBody.store, false);
        assert.equal(capturedBody.reasoning.effort, "none");
        assert.equal(capturedBody.input[0].content[0].type, "input_text");
        assert.ok(capturedBody.instructions.includes("NPC"));
        assert.equal(capturedHeaders["Authorization"], "Bearer test-key");
    } finally {
        await close();
    }
});
