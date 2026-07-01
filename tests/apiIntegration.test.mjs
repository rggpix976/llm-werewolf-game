import assert from "node:assert/strict";
import test from "node:test";
import { createWebServer } from "../src/webServer.mjs";

const dummyRequest = {
  npc: { id: "npc1", name: "Aoi", personality: "P", speechStyle: "S", conversationPolicy: { truthfulness: "t", roleClaim: "r", allowedTactics: [], forbidden: [] } },
  playerInput: "Hello",
  context: { day: 1, phase: "day", publicEvidence: [], shareableKnownEvidence: [], privateStanceEvidence: [], publicClaims: [], intent: { asksWerewolfIdentity: false, asksRoleOrClaim: false, asksVoteReason: false }, topSuspect: null },
  policyDecision: { publicClaimAllowed: false, publicClaim: null, disclosedHiddenInfo: false },
  responsePlan: { baseText: "B", speechStyle: "S" },
  evidenceUsed: []
};

const setupTestServer = (mockFetch) => {
    const config = {
        provider: "openai",
        openai: {
            apiKey: "test-key",
            model: "gpt-test",
            fetch: mockFetch,
            maxRetries: 0,
            fallbackToPseudo: false
        }
    };
    return createWebServer({ config });
};

const cases = [
    { label: "incomplete", body: { id: "res_inc", status: "incomplete", output: [] }, expectedStatus: 502, expectedType: "invalid_provider_response" },
    { label: "failed", body: { id: "res_fail", status: "failed", output: [] }, expectedStatus: 502, expectedType: "provider_server_error" },
    { label: "cancelled", body: { id: "res_can", status: "cancelled", output: [] }, expectedStatus: 502, expectedType: "provider_server_error" },
    { label: "missing status", body: { id: "res_miss", output: [] }, expectedStatus: 502, expectedType: "invalid_provider_response" },
    { label: "malformed output", body: { id: "res_mal", status: "completed", output: [null] }, expectedStatus: 502, expectedType: "invalid_provider_response" },
    { label: "empty output", body: { id: "res_empty", status: "completed", output: [] }, expectedStatus: 502, expectedType: "invalid_provider_response" },
    { label: "refusal", body: { id: "res_ref", status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }] }, expectedStatus: 502, expectedType: "invalid_provider_response" }
];

test("Full endpoint integration: non-success Responses API statuses", async () => {
    for (const c of cases) {
        const mockFetch = async () => ({
            ok: true,
            status: 200,
            headers: new Map([["x-request-id", "req_upstream"]]),
            json: async () => c.body
        });

        const server = setupTestServer(mockFetch);
        // Minimal mock of ServerResponse
        const resMock = {
            writeHead(status, headers) { this.status = status; this.headers = headers; },
            end(body) { this.body = JSON.parse(body); this.finished = true; },
            on() {},
            removeListener() {},
            writableEnded: false
        };

        const reqMock = {
            url: "/api/npc-response",
            method: "POST",
            headers: { "content-type": "application/json" },
            on(evt, cb) {
                if (evt === "data") cb(Buffer.from(JSON.stringify(dummyRequest)));
                if (evt === "end") cb();
            },
            removeListener() {}
        };

        await server.emit("request", reqMock, resMock);
        // Wait for potential async work inside handler
        await new Promise(r => setTimeout(r, 10));

        assert.equal(resMock.status, c.expectedStatus, `Case ${c.label} should have status ${c.expectedStatus}`);
        assert.equal(resMock.status >= 200 && resMock.status < 300, false);
        assert.equal(resMock.body.type, c.expectedType);
        assert.equal(resMock.body.diagnostics.providerName, "openai");
        assert.equal(resMock.body.diagnostics.httpStatus, 200, "Upstream status should be available in diagnostics");
        assert.ok(!resMock.body.error.includes("No"), "Should not leak raw provider content in error message");
    }
});

test("Full endpoint integration: provider error (401)", async () => {
    const mockFetch = async () => ({
        ok: false,
        status: 401,
        headers: new Map([["x-request-id", "req_upstream"]]),
        json: async () => ({ error: { message: "Auth failed", code: "invalid_api_key" } })
    });

    const server = setupTestServer(mockFetch);
    const resMock = {
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        end(body) { this.body = JSON.parse(body); this.finished = true; },
        on() {},
        removeListener() {},
        writableEnded: false
    };

    const reqMock = {
        url: "/api/npc-response",
        method: "POST",
        headers: { "content-type": "application/json" },
        on(evt, cb) {
            if (evt === "data") cb(Buffer.from(JSON.stringify(dummyRequest)));
            if (evt === "end") cb();
        },
        removeListener() {}
    };

    await server.emit("request", reqMock, resMock);
    await new Promise(r => setTimeout(r, 10));

    assert.equal(resMock.status, 502);
    assert.equal(resMock.body.type, "authentication_error");
    assert.equal(resMock.body.diagnostics.httpStatus, 401);
    assert.ok(!resMock.body.error.includes("Auth failed"), "Should not leak raw auth error");
});
