import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createWebServer } from "../src/webServer.mjs";
import { OpenAIInterpreterProvider, PseudoInterpreterProvider } from "../src/interpreterTransport.mjs";
import { runProviderWithRetry } from "../src/providerRetry.mjs";
import { buildShadowInterpreterRequest, InterpreterShadowClient, shouldObserveInterpreterShadow } from "../public/interpreterShadowClient.mjs";
import { HttpResponseProvider, SessionManager } from "../public/httpResponseProvider.mjs";

const snapshot = Object.freeze({ day: 1, phase: "day_discussion", winner: null, players: Object.freeze([{ id: "npc-1", name: "Aoi", alive: true }]) });
const binding = Object.freeze({ schemaVersion: 1, sessionId: "shadow-session-1", inputRecordId: "shadow-input-1", shadowTurnId: "shadow-turn-1", shadowSnapshotVersion: 0 });
function requestFixture(overrides = {}) { return { ...buildShadowInterpreterRequest({ snapshot, rawText: "hello", binding, requestId: "interpreter-1", correlationId: "correlation-1" }), ...overrides }; }
async function start(options = {}) { const server = createWebServer({ config: { provider: "pseudo", interpreterShadowMode: true, openai: null }, ...options }); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) }; }
function providerResult(request) { return new PseudoInterpreterProvider().interpretPlayerInput(request); }

test("shadow feature flag defaults disabled and is safely public", async () => {
  const { parseConfig, getRuntimeConfig } = await import("../src/config.mjs"); assert.equal(parseConfig({}).interpreterShadowMode, false); assert.equal(parseConfig({}).interpreterValidationMode, false); assert.equal(parseConfig({ INTERPRETER_SHADOW_MODE: "true" }).interpreterShadowMode, true); assert.equal(parseConfig({ INTERPRETER_VALIDATION_MODE: "true" }).interpreterValidationMode, true); assert.throws(() => parseConfig({ INTERPRETER_SHADOW_MODE: "yes" })); assert.deepEqual(getRuntimeConfig(parseConfig({})), { provider: "pseudo", interpreterShadowMode: false, interpreterValidationMode: false, playerConversationCommitMode: false, playerStructuredConsumerMode: false, npcStructuredReactionMode: false });
});

test("Phase 2 and Phase 3 feature flags select exactly one Interpreter owner", () => {
  assert.equal(shouldObserveInterpreterShadow({ interpreterShadowMode: false, interpreterValidationMode: false }), false);
  assert.equal(shouldObserveInterpreterShadow({ interpreterShadowMode: true, interpreterValidationMode: false }), true);
  assert.equal(shouldObserveInterpreterShadow({ interpreterShadowMode: false, interpreterValidationMode: true }), false);
  assert.equal(shouldObserveInterpreterShadow({ interpreterShadowMode: true, interpreterValidationMode: true }), false);
});

test("disabled server endpoint never calls Interpreter provider", async () => {
  let calls = 0; const server = createWebServer({ config: { provider: "pseudo", interpreterShadowMode: false, openai: null }, interpreterProvider: { interpretPlayerInput: async () => { calls += 1; } } }); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { const response = await fetch(`http://127.0.0.1:${server.address().port}/api/interpret-player-input`, { method: "POST" }); assert.equal(response.status, 404); assert.equal(calls, 0); } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("shadow rate limiting is isolated from the authoritative NPC endpoint", async () => {
  let interpreterCalls = 0; const { url, close } = await start({ interpreterRateLimiter: { allow: () => false }, rateLimiter: { allow: () => true }, interpreterProvider: { interpretPlayerInput: async () => { interpreterCalls += 1; } }, provider: { generateResponse: async () => ({ text: "authoritative", providerName: "mock" }) } });
  try { const shadow = await fetch(`${url}/api/interpret-player-input`, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(requestFixture()) }); assert.equal(shadow.status, 429); assert.equal(interpreterCalls, 0); const npc = await fetch(`${url}/api/npc-response`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ npc: { id: "n1", name: "n1", personality: "p", speechStyle: "s", conversationPolicy: { truthfulness: "t", roleClaim: "r", allowedTactics: [], forbidden: [] } }, playerInput: "h", context: { day: 1, phase: "p", publicEvidence: [], shareableKnownEvidence: [], privateStanceEvidence: [], publicClaims: [], intent: { asksWerewolfIdentity: false, asksRoleOrClaim: false, asksVoteReason: false }, topSuspect: null }, policyDecision: { publicClaimAllowed: false, publicClaim: null, disclosedHiddenInfo: false }, responsePlan: { baseText: "b", speechStyle: "s" }, evidenceUsed: [] }) }); assert.equal(npc.status, 200); assert.equal((await npc.json()).text, "authoritative"); } finally { await close(); }
});

test("Interpreter endpoint returns strict success envelope and stable replay", async () => {
  let calls = 0; const interpreterProvider = { interpretPlayerInput: async (request) => { calls += 1; return providerResult(request); } }, { url, close } = await start({ interpreterProvider }); const request = requestFixture();
  try { for (let index = 0; index < 2; index += 1) { const response = await fetch(`${url}/api/interpret-player-input`, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(request) }); assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.requestId, request.requestId); assert.equal(body.correlationId, request.correlationId); assert.match(body.serverCorrelationId, /^server-/); assert.equal(body.result.requestId, request.requestId); assert.equal(body.result.correlationId, request.correlationId); } assert.equal(calls, 1); } finally { await close(); }
});

test("Interpreter endpoint enforces HTTP and ErrorEnvelope contracts", async () => {
  const { url, close } = await start();
  try {
    const cases = [
      [{ method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: "{" }, 400, "malformed_json"],
      [{ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 415, "unsupported_media_type"],
      [{ method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "identity" }, body: "{}" }, 415, "unsupported_media_type"],
      [{ method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ ...requestFixture(), unknown: true }) }, 400, "invalid_schema"],
      [{ method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ ...requestFixture(), rawText: undefined }) }, 400, "invalid_schema"],
      [{ method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ ...requestFixture(), schemaVersion: 2 }) }, 400, "unsupported_schema_version"],
      [{ method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ padding: "x".repeat(65536) }) }, 413, "body_too_large"]
    ];
    for (const [options, status, code] of cases) { const response = await fetch(`${url}/api/interpret-player-input`, options); assert.equal(response.status, status); const body = await response.json(); assert.equal(body.schemaVersion, 1); assert.equal(body.error.code, code); assert.equal(body.error.retryable, false); assert.match(body.correlationId, /^server-/); assert.equal("message" in body.error, false); }
  } finally { await close(); }
});

test("Interpreter endpoint accepts the exact 64 KiB boundary and rejects the next byte", async () => {
  const { url, close } = await start(), json = JSON.stringify(requestFixture()), exact = json + " ".repeat(65536 - Buffer.byteLength(json));
  try { const accepted = await fetch(`${url}/api/interpret-player-input`, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: exact }); assert.equal(accepted.status, 200); const rejected = await fetch(`${url}/api/interpret-player-input`, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: `${exact} ` }); assert.equal(rejected.status, 413); assert.equal((await rejected.json()).error.code, "body_too_large"); } finally { await close(); }
});

test("Interpreter endpoint rejects malformed provider results as 502", async () => {
  const { url, close } = await start({ interpreterProvider: { interpretPlayerInput: async () => ({ rawProviderBody: "secret" }) } });
  try { const response = await fetch(`${url}/api/interpret-player-input`, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(requestFixture()) }); assert.equal(response.status, 502); const text = await response.text(); assert.equal(text.includes("rawProviderBody"), false); assert.equal(JSON.parse(text).error.code, "invalid_provider_response"); } finally { await close(); }
});

test("Interpreter endpoint maps provider failures without raw bodies", async () => {
  for (const [code, status] of [["invalid_provider_response", 502], ["provider_auth_failure", 502], ["provider_unavailable", 503], ["provider_timeout", 504]]) {
    const error = Object.assign(new Error("RAW SECRET PROVIDER BODY"), { code }), { url, close } = await start({ interpreterProvider: { interpretPlayerInput: async () => { throw error; } } });
    try { const response = await fetch(`${url}/api/interpret-player-input`, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(requestFixture()) }); assert.equal(response.status, status); const text = await response.text(); assert.equal(text.includes("RAW SECRET"), false); assert.equal(JSON.parse(text).error.code, code); } finally { await close(); }
  }
});

test("same request ID with changed fingerprint is an idempotency conflict", async () => {
  const { url, close } = await start(); try { const first = requestFixture(); await fetch(`${url}/api/interpret-player-input`, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(first) }); const response = await fetch(`${url}/api/interpret-player-input`, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ ...first, rawText: "changed" }) }); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "idempotency_conflict"); } finally { await close(); }
});

test("browser HTTP provider validates success, errors, and correlation", async () => {
  const request = requestFixture(), result = await providerResult(request), valid = { schemaVersion: 1, requestId: request.requestId, correlationId: request.correlationId, serverCorrelationId: "server-1", result };
  const sessionManager = new SessionManager(), provider = new HttpResponseProvider({ sessionManager, fetch: async () => ({ ok: true, status: 200, json: async () => valid }) }); assert.equal((await provider.interpretPlayerInput(request)).requestId, request.requestId); assert.equal(sessionManager.pendingRequests.size, 0);
  const mismatch = new HttpResponseProvider({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ ...valid, correlationId: "other" }) }) }); await assert.rejects(mismatch.interpretPlayerInput(request));
  const errorProvider = new HttpResponseProvider({ fetch: async () => ({ ok: false, status: 502, json: async () => ({ schemaVersion: 1, requestId: request.requestId, correlationId: "server-1", error: { code: "invalid_provider_response", retryable: false } }) }) }); await assert.rejects(errorProvider.interpretPlayerInput(request), (error) => error.code === "invalid_provider_response");
});

test("browser HTTP provider preserves input identity and links external abort", async () => {
  const request = requestFixture(); let fetchSignal, added = 0, removed = 0;
  const external = new AbortController(), originalAdd = external.signal.addEventListener.bind(external.signal), originalRemove = external.signal.removeEventListener.bind(external.signal);
  external.signal.addEventListener = (...args) => { added += 1; return originalAdd(...args); };
  external.signal.removeEventListener = (...args) => { removed += 1; return originalRemove(...args); };
  const manager = new SessionManager({ createId: () => "session" }); manager.startNewGame();
  const provider = new HttpResponseProvider({ sessionManager: manager, fetch: async (_url, options) => { fetchSignal = options.signal; return await new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })); } });
  const pending = provider.interpretPlayerInput(request, { signal: external.signal });
  assert.equal(manager.pendingRequests.get(request.requestId).pending.inputRecordId, request.inputRecordId);
  external.abort(); await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(fetchSignal.aborted, true); assert.equal(added, 1); assert.equal(removed, 1); assert.equal(manager.pendingRequests.size, 0);
});

test("SessionManager rejects duplicate pending and aborts on new game", () => {
  const manager = new SessionManager(), pending = { schemaVersion: 1, pendingType: "interpreter", requestId: "pending-1" }, first = new AbortController(), second = new AbortController(); manager.registerPendingRequest(pending, first); assert.throws(() => manager.registerPendingRequest(pending, second)); manager.startNewGame(); assert.equal(first.signal.aborted, true); assert.equal(manager.pendingRequests.size, 0);
});

test("ShadowInterpreterBinding uses real runtime-only identities and monotonic versions", () => {
  let id = 0; const manager = new SessionManager({ createId: () => String(++id) }); manager.startNewGame();
  const first = manager.stageShadowInput({ rawText: "first" }), second = manager.stageShadowInput({ rawText: "second" });
  assert.notEqual(first.inputRecordId, second.inputRecordId); assert.notEqual(first.shadowTurnId, second.shadowTurnId); assert.equal(first.shadowSnapshotVersion, 0); assert.equal(second.shadowSnapshotVersion, 1);
  assert.equal(manager.shadowInputs.get(first.inputRecordId).rawText, "first");
  const priorSession = first.sessionId; manager.startNewGame(); const next = manager.stageShadowInput({ rawText: "next" });
  assert.notEqual(next.sessionId, priorSession); assert.equal(next.shadowSnapshotVersion, 0); assert.equal(manager.shadowInputs.size, 1);
  const request = buildShadowInterpreterRequest({ snapshot, rawText: "next", binding: next, requestId: "request-next", correlationId: "correlation-next" });
  assert.equal(request.inputRecordId, next.inputRecordId); assert.equal(request.turnId, next.shadowTurnId); assert.equal(request.preconditionStateVersion, next.shadowSnapshotVersion);
  assert.deepEqual(request.publicContext, { publicEvents: [], publicClaims: [], publicVotes: [], executions: [], attackDeaths: [] });
});

test("shadow client is fire-and-forget, redacted, and ignores stale results", async () => {
  let resolve, observed = [], calls = 0; const manager = new SessionManager(), gameId = manager.startNewGame(), provider = { interpretPlayerInput: () => { calls += 1; return new Promise((done) => { resolve = done; }); } }, client = new InterpreterShadowClient({ provider, sessionManager: manager, observer: (entry) => observed.push(entry), createId: (() => { let id = 0; return () => String(++id); })(), now: () => 1 }); const before = structuredClone(snapshot); client.observe({ snapshot, rawText: "PRIVATE RAW", gameId }); assert.equal(calls, 1); assert.deepEqual(snapshot, before); manager.startNewGame(); resolve({ serverCorrelationId: "server-1", result: { diagnostics: { attemptCount: 1 }, modelOutput: { alternatives: [] } } }); await Promise.resolve(); assert.deepEqual(observed, []);
});

test("shadow success and failure observations never expose raw input or alter game data", async () => {
  for (const outcome of ["success", "failure"]) { const observed = [], manager = new SessionManager(), gameId = manager.startNewGame(), provider = { interpretPlayerInput: async (request) => { if (outcome === "failure") throw Object.assign(new Error("RAW PROVIDER SECRET"), { code: "provider_unavailable" }); return { serverCorrelationId: "server-1", result: { diagnostics: { attemptCount: 1 }, modelOutput: { alternatives: [{ alternativeId: "alt-1" }] } } }; } }, client = new InterpreterShadowClient({ provider, sessionManager: manager, observer: (entry) => observed.push(entry), createId: () => "id", now: () => 1 }), before = structuredClone(snapshot); const requestId = client.observe({ snapshot, rawText: "RAW PLAYER SECRET", gameId, targetNpcId: "npc-1" }); assert.equal(requestId, "interpreter-id"); await Promise.resolve(); await Promise.resolve(); assert.equal(observed.length, 1); assert.equal(observed[0].status, outcome); const serialized = JSON.stringify(observed); assert.equal(serialized.includes("RAW PLAYER"), false); assert.equal(serialized.includes("RAW PROVIDER"), false); assert.deepEqual(snapshot, before); }
});

test("Interpreter endpoint aborts the active provider attempt on client disconnect", async () => {
  let calls = 0, backoffs = 0, providerStarted, providerAborted; const started = new Promise((resolve) => { providerStarted = resolve; }), aborted = new Promise((resolve) => { providerAborted = resolve; });
  const interpreterProvider = { interpretPlayerInput: (request, { signal }) => runProviderWithRetry(({ signal: attemptSignal }) => { calls += 1; providerStarted(); return new Promise((resolve, reject) => attemptSignal.addEventListener("abort", () => { providerAborted(); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true })); }, { signal, delay: async () => { backoffs += 1; } }).then(({ value }) => value) };
  const { url, close } = await start({ interpreterProvider }); const target = new URL("/api/interpret-player-input", url);
  const client = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname, method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" } }); client.on("error", () => {}); client.end(JSON.stringify(requestFixture()));
  await started; client.destroy();
  try { await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error("provider was not aborted")), 1000))]); assert.equal(calls, 1); assert.equal(backoffs, 0); } finally { await close(); }
});

test("provider retry preserves identity, retries transient failures, and aborts backoff", async () => {
  let calls = 0, delays = []; const result = await runProviderWithRetry(async ({ attempt }) => { calls += 1; if (attempt < 3) throw Object.assign(new Error("temporary"), { retryable: true }); return "ok"; }, { now: () => 0, delay: async (ms) => { delays.push(ms); } }); assert.equal(result.value, "ok"); assert.equal(result.attemptCount, 3); assert.deepEqual(delays, [1000, 2000]); assert.equal(calls, 3);
  const controller = new AbortController(); await assert.rejects(runProviderWithRetry(async () => { throw Object.assign(new Error("temporary"), { retryable: true }); }, { signal: controller.signal, now: () => 0, delay: async () => { controller.abort(); throw Object.assign(new Error("Aborted"), { name: "AbortError" }); } }), (error) => error.name === "AbortError");
});

test("provider retry enforces attempts, budget, timeout, and Retry-After policy", async () => {
  let calls = 0; await assert.rejects(runProviderWithRetry(async () => { calls += 1; throw Object.assign(new Error("temporary"), { retryable: true }); }, { now: () => 0, delay: async () => {} })); assert.equal(calls, 3);
  calls = 0; await assert.rejects(runProviderWithRetry(async () => { calls += 1; throw Object.assign(new Error("auth"), { retryable: false }); }, { now: () => 0, delay: async () => assert.fail("must not back off") })); assert.equal(calls, 1);
  let firstClockRead = true; calls = 0; await assert.rejects(runProviderWithRetry(async () => { calls += 1; }, { now: () => firstClockRead ? (firstClockRead = false, 0) : 14000 })); assert.equal(calls, 0);
  const waits = []; calls = 0; await runProviderWithRetry(async () => { calls += 1; if (calls === 1) throw Object.assign(new Error("rate"), { retryable: true, retryAfterMs: 1500 }); return "ok"; }, { now: () => 0, delay: async (ms) => waits.push(ms) }); assert.deepEqual(waits, [1500]);
  waits.length = 0; calls = 0; await runProviderWithRetry(async () => { calls += 1; if (calls === 1) throw Object.assign(new Error("rate"), { retryable: true, retryAfterMs: 3000 }); return "ok"; }, { now: () => 0, delay: async (ms) => waits.push(ms) }); assert.deepEqual(waits, [1000]);
  await assert.rejects(runProviderWithRetry(({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), { policy: { perAttemptTimeoutMs: 5, maxAttempts: 1 } }), (error) => error.code === "provider_timeout");
  let scheduled, cleared; await assert.rejects(runProviderWithRetry(({ signal }) => new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); scheduled(); }), { policy: { maxAttempts: 1 }, setTimeout: (callback) => (scheduled = callback, 17), clearTimeout: (timer) => { cleared = timer; } }), (error) => error.code === "provider_timeout"); assert.equal(cleared, 17);
});

test("OpenAI Interpreter returns only strict structured output and redacts private data", async () => {
  const request = requestFixture(), modelOutput = { schemaVersion: 1, alternatives: [{ alternativeId: "alt-1", speechActs: [{ type: "non_game_statement", sourceSpan: { start: 0, end: 5 } }], confidence: 1 }] }; let outbound;
  const provider = new OpenAIInterpreterProvider({ apiKey: "SECRET-KEY", model: "model", now: () => 0, fetch: async (_url, options) => { outbound = JSON.parse(options.body); return { ok: true, status: 200, headers: new Headers(), json: async () => ({ status: "completed", output_text: JSON.stringify(modelOutput) }) }; } }); const result = await provider.interpretPlayerInput(request); assert.deepEqual(result.modelOutput, modelOutput); assert.equal(result.requestId, request.requestId); assert.equal(result.correlationId, request.correlationId); assert.equal(outbound.text.format.type, "json_schema"); assert.equal(outbound.text.format.strict, true); assert.equal(outbound.text.format.schema.additionalProperties, false); const serialized = JSON.stringify(outbound); assert.equal(serialized.includes("SECRET-KEY"), false); assert.equal(serialized.includes("privateRole"), false); assert.equal(serialized.includes("hiddenTeam"), false); assert.equal("text" in result, false);
});

test("OpenAI Interpreter does not retry auth or invalid output and bounds transient retries", async () => {
  for (const response of [{ ok: false, status: 401, headers: new Headers(), json: async () => ({ secret: "raw" }) }, { ok: true, status: 200, headers: new Headers(), json: async () => ({ status: "completed", output_text: "not-json" }) }]) { let calls = 0; const provider = new OpenAIInterpreterProvider({ apiKey: "key", now: () => 0, delay: async () => {}, fetch: async () => { calls += 1; return response; } }); await assert.rejects(provider.interpretPlayerInput(requestFixture())); assert.equal(calls, 1); }
  let calls = 0; const transient = new OpenAIInterpreterProvider({ apiKey: "key", now: () => 0, delay: async () => {}, fetch: async () => { calls += 1; return { ok: false, status: 503, headers: new Headers(), json: async () => ({}) }; } }); await assert.rejects(transient.interpretPlayerInput(requestFixture())); assert.equal(calls, 3);
});
