import assert from "node:assert/strict";
import test from "node:test";

import { sha256CanonicalJson } from "../src/conversation/ids.mjs";
import {
  NpcReactionCandidateProviderError,
  createNpcReactionCandidateProvider
} from "../src/npcReactionCandidateProvider.mjs";
import { createLocalNpcReactionCandidateTransport } from "../src/npcReactionCandidateTransport.mjs";
import {
  createOpenAINpcReactionCandidateInvoker,
  createPseudoNpcReactionCandidateInvoker
} from "../src/npcReactionCandidateUpstream.mjs";
import { createWebServer } from "../src/webServer.mjs";

const REQUEST_FIELDS = [
  "schemaVersion", "operation", "gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId",
  "requestFingerprint", "correlationId", "causationId", "originatingInputRecordId", "turnId", "turnOrder",
  "preconditionPhase", "preconditionStateVersion", "npcId", "knownInformation", "limits"
];

function projection() {
  return {
    schemaVersion: 1,
    projectionType: "npc_known_information",
    public: {
      day: 1,
      phase: "player_question",
      participants: [
        { participantId: "npc-aoi", displayName: "Aoi", publicStatus: "alive" },
        { participantId: "npc-beni", displayName: "Beni", publicStatus: "alive" },
        { participantId: "player", displayName: "Player", publicStatus: "alive" }
      ],
      events: [{
        schemaVersion: 1,
        projectionType: "public_question_event",
        eventId: "event-question-1",
        actorId: "player",
        turnId: "turn-1",
        occurredPhase: "day_discussion",
        targetId: "npc-aoi",
        topic: "result"
      }],
      claims: [],
      votes: [],
      executions: [],
      attackDeaths: [],
      triggeringInput: {
        schemaVersion: 1,
        inputRecordId: "input-1",
        requestId: "player-request-1",
        correlationId: "player-correlation-1",
        turnId: "turn-1",
        capturedStateVersion: 1,
        actorId: "player",
        rawText: "Aoi, what is your result?",
        locale: "en"
      }
    },
    actorPrivate: {
      actorId: "npc-aoi",
      ownRole: "seer",
      ownTeam: "village",
      investigationResults: [{
        day: 1,
        targetId: "npc-beni",
        result: "werewolf",
        disclosurePolicy: "engine_policy_required"
      }],
      voteHistory: [],
      suspicionScores: [{ targetId: "npc-beni", score: 2 }]
    },
    constraints: {
      allowedTargetIds: ["npc-beni"],
      allowedLivingTargetIds: ["npc-beni"],
      allowedResultTargetIds: ["npc-beni"],
      allowedCandidateKinds: ["role_claim", "result_claim", "vote_declaration", "suspicion"],
      allowedClaimRoles: ["seer"],
      allowedResultValues: ["werewolf"],
      allowedReferenceIds: ["event-question-1", "input-1"],
      roleDisclosurePolicy: "claim_when_directly_asked_after_result"
    },
    presentation: { speechStyleId: "brief" }
  };
}

function requestFixture(suffix = "1") {
  const request = {
    schemaVersion: 1,
    operation: "generate_npc_reaction_candidate",
    gameSessionId: `game-session-${suffix}`,
    reactionPlanId: `reaction-plan-${suffix}`,
    reactionAttemptId: `reaction-attempt-${suffix}`,
    requestId: `reaction-request-${suffix}`,
    requestFingerprint: "0".repeat(64),
    correlationId: `correlation-${suffix}`,
    causationId: "player-request-1",
    originatingInputRecordId: "input-1",
    turnId: "turn-1",
    turnOrder: 1,
    preconditionPhase: "player_question",
    preconditionStateVersion: 2,
    npcId: "npc-aoi",
    knownInformation: projection(),
    limits: { maxProposals: 16, maxNestingDepth: 5 }
  };
  request.requestFingerprint = sha256CanonicalJson(Object.fromEntries(REQUEST_FIELDS
    .filter((field) => !["reactionAttemptId", "requestFingerprint"].includes(field))
    .map((field) => [field, request[field]])));
  return request;
}

function candidateFixture() {
  return { schemaVersion: 1, proposals: [{ proposalType: "suspicion", targetId: "npc-beni" }] };
}

function completedResponse(candidate = candidateFixture()) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async json() { return { status: "completed", output_text: JSON.stringify(candidate) }; }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function countJsonKey(value, key) {
  if (!value || typeof value !== "object") return 0;
  return (Object.hasOwn(value, key) ? 1 : 0)
    + Object.values(value).reduce((sum, child) => sum + countJsonKey(child, key), 0);
}

function assertRateDenial(error) {
  assert.equal(error?.name, "NpcCandidateUpstreamError");
  assert.equal(error?.message, "NPC candidate upstream failed.");
  assert.equal(error?.code, "rate_limited");
  assert.equal(error?.retryable, false);
  assert.equal(error?.retryAfterMs, undefined);
  assert.equal(Object.hasOwn(error ?? {}, "cause"), false);
  return true;
}

test("candidate upstream keeps the exact two browser-safe production exports", async () => {
  const module = await import("../src/npcReactionCandidateUpstream.mjs");
  assert.deepEqual(Object.keys(module).sort(), [
    "createOpenAINpcReactionCandidateInvoker",
    "createPseudoNpcReactionCandidateInvoker"
  ]);
});

test("OpenAI candidate factory validates cost-control dependencies", () => {
  const valid = { apiKey: "unit-test-credential", fetch: async () => completedResponse(), now: () => 0 };
  for (const [field, values] of Object.entries({
    maxOutputTokens: [0, -1, 1.5, 4097, Number.MAX_SAFE_INTEGER + 1],
    maxRequestsPerMinute: [0, -1, 1.5, 61, Number.MAX_SAFE_INTEGER + 1],
    maxConcurrentRequests: [0, -1, 1.5, 9, Number.MAX_SAFE_INTEGER + 1]
  })) {
    for (const value of values) assert.throws(
      () => createOpenAINpcReactionCandidateInvoker({ ...valid, [field]: value }),
      TypeError,
      `${field}=${value}`
    );
  }
  for (const model of ["", "   ", "x".repeat(129)]) {
    assert.throws(() => createOpenAINpcReactionCandidateInvoker({ ...valid, model }), TypeError);
  }
  assert.throws(() => createOpenAINpcReactionCandidateInvoker({ ...valid, fetch: null }), TypeError);
  assert.throws(() => createOpenAINpcReactionCandidateInvoker({ ...valid, now: null }), TypeError);
  for (const maxOutputTokens of [1, 4096]) createOpenAINpcReactionCandidateInvoker({ ...valid, maxOutputTokens });
  for (const maxRequestsPerMinute of [1, 60]) createOpenAINpcReactionCandidateInvoker({ ...valid, maxRequestsPerMinute });
  for (const maxConcurrentRequests of [1, 8]) createOpenAINpcReactionCandidateInvoker({ ...valid, maxConcurrentRequests });
});

test("OpenAI candidate request transmits configured max_output_tokens without changing the strict schema", async () => {
  for (const [configured, expected] of [[undefined, 220], [321, 321]]) {
    const request = requestFixture(`body-${expected}`);
    const before = structuredClone(request);
    let calls = 0;
    let body;
    const invoke = createOpenAINpcReactionCandidateInvoker({
      apiKey: "unit-test-credential",
      model: "test-model",
      maxOutputTokens: configured,
      fetch: async (_url, options) => {
        calls += 1;
        body = JSON.parse(options.body);
        return completedResponse();
      },
      now: () => 0
    });
    await invoke(request);
    assert.equal(calls, 1);
    assert.equal(body.max_output_tokens, expected);
    assert.equal(typeof body.max_output_tokens, "number");
    assert.equal(body.model, "test-model");
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.equal(countJsonKey(body.text.format.schema, "oneOf"), 0);
    assert.equal(countJsonKey(body.text.format.schema, "anyOf"), 1);
    assert.equal(body.text.format.schema.properties.proposals.items.anyOf.length, 9);
    assert.equal(Object.hasOwn(body, "max_tokens"), false);
    assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
    assert.deepEqual(request, before);
  }
});

test("rolling request budget enforces sliding-window starts and exact expiry", async () => {
  let now = 0;
  let calls = 0;
  const invoke = createOpenAINpcReactionCandidateInvoker({
    apiKey: "unit-test-credential",
    maxRequestsPerMinute: 2,
    maxConcurrentRequests: 2,
    fetch: async () => { calls += 1; return completedResponse(); },
    now: () => now
  });
  await invoke(requestFixture("window-a"));
  now = 30_000;
  await invoke(requestFixture("window-b"));
  now = 59_999;
  await assert.rejects(invoke(requestFixture("window-denied")), assertRateDenial);
  await assert.rejects(invoke(requestFixture("window-denied-again")), assertRateDenial);
  assert.equal(calls, 2);
  now = 60_000;
  await invoke(requestFixture("window-c"));
  assert.equal(calls, 3);
  now = 89_999;
  await assert.rejects(invoke(requestFixture("window-partial")), assertRateDenial);
  now = 90_000;
  await invoke(requestFixture("window-d"));
  assert.equal(calls, 4);
});

test("rolling request budget is shared across session and reaction identities and resists clock rollback", async () => {
  let now = 100_000;
  let calls = 0;
  const invoke = createOpenAINpcReactionCandidateInvoker({
    apiKey: "unit-test-credential",
    maxRequestsPerMinute: 1,
    maxConcurrentRequests: 1,
    fetch: async () => { calls += 1; return completedResponse(); },
    now: () => now
  });
  await invoke(requestFixture("session-a"));
  now = 0;
  await assert.rejects(invoke(requestFixture("session-b")), assertRateDenial);
  assert.equal(calls, 1);
  now = 160_000;
  await invoke(requestFixture("session-c"));
  assert.equal(calls, 2);
});

test("failed, HTTP-error, malformed, and aborted fetch starts retain request-rate slots", async (t) => {
  const cases = [
    ["fetch rejection", async () => { throw new TypeError("PRIVATE_NETWORK"); }],
    ["HTTP failure", async () => ({ ok: false, status: 503, headers: { get: () => null } })],
    ["malformed JSON response", async () => ({ ok: true, status: 200, headers: { get: () => null }, async json() { throw new Error("PRIVATE_JSON"); } })]
  ];
  for (const [name, fetchImpl] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      const invoke = createOpenAINpcReactionCandidateInvoker({
        apiKey: "unit-test-credential",
        maxRequestsPerMinute: 1,
        fetch: async (...args) => { calls += 1; return fetchImpl(...args); },
        now: () => 0
      });
      await assert.rejects(invoke(requestFixture(`${name}-first`)));
      await assert.rejects(invoke(requestFixture(`${name}-second`)), assertRateDenial);
      assert.equal(calls, 1);
    });
  }

  await t.test("abort after start", async () => {
    const pending = deferred();
    let calls = 0;
    const controller = new AbortController();
    const invoke = createOpenAINpcReactionCandidateInvoker({
      apiKey: "unit-test-credential",
      maxRequestsPerMinute: 1,
      fetch: () => { calls += 1; return pending.promise; },
      now: () => 0
    });
    const first = invoke(requestFixture("abort-start"), { signal: controller.signal });
    controller.abort(new Error("PRIVATE_ABORT"));
    pending.resolve(completedResponse());
    await assert.rejects(first);
    await assert.rejects(invoke(requestFixture("abort-denied")), assertRateDenial);
    assert.equal(calls, 1);
  });
});

test("pre-abort, serialization failure, and invalid budget clock start no fetch and consume no slot", async () => {
  let nowCalls = 0;
  let fetchCalls = 0;
  const invoke = createOpenAINpcReactionCandidateInvoker({
    apiKey: "unit-test-credential",
    maxRequestsPerMinute: 1,
    fetch: async () => { fetchCalls += 1; return completedResponse(); },
    now: () => { nowCalls += 1; return 0; }
  });
  const controller = new AbortController();
  controller.abort(new Error("PRIVATE_PRE_ABORT"));
  await assert.rejects(invoke(requestFixture("pre-abort"), { signal: controller.signal }));
  assert.equal(fetchCalls, 0);
  assert.equal(nowCalls, 0);
  const circular = requestFixture("circular");
  circular.self = circular;
  await assert.rejects(invoke(circular));
  assert.equal(fetchCalls, 0);
  assert.equal(nowCalls, 0);
  await invoke(requestFixture("after-zero-consumption"));
  assert.equal(fetchCalls, 1);

  for (const invalid of [NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
    let invalidFetches = 0;
    const invalidInvoke = createOpenAINpcReactionCandidateInvoker({
      apiKey: "unit-test-credential",
      fetch: async () => { invalidFetches += 1; return completedResponse(); },
      now: () => invalid
    });
    await assert.rejects(invalidInvoke(requestFixture(`invalid-clock-${String(invalid)}`)));
    assert.equal(invalidFetches, 0);
  }
  let throwFetches = 0;
  const throwingClock = createOpenAINpcReactionCandidateInvoker({
    apiKey: "unit-test-credential",
    fetch: async () => { throwFetches += 1; return completedResponse(); },
    now: () => { throw new Error("PRIVATE_CLOCK"); }
  });
  await assert.rejects(throwingClock(requestFixture("throw-clock")));
  assert.equal(throwFetches, 0);
});

test("concurrency ceiling has no queue and releases exactly once after settlement", async () => {
  const pending = deferred();
  let calls = 0;
  const invoke = createOpenAINpcReactionCandidateInvoker({
    apiKey: "unit-test-credential",
    maxRequestsPerMinute: 10,
    maxConcurrentRequests: 1,
    fetch: async () => {
      calls += 1;
      if (calls === 1) return pending.promise;
      return completedResponse();
    },
    now: () => 0
  });
  const first = invoke(requestFixture("concurrency-first"));
  await assert.rejects(invoke(requestFixture("concurrency-denied")), assertRateDenial);
  assert.equal(calls, 1);
  pending.resolve(completedResponse());
  await first;
  await invoke(requestFixture("concurrency-after"));
  assert.equal(calls, 2);
});

test("concurrency two permits two starts, denies the third, and reopens one lease", async () => {
  const firstPending = deferred();
  const secondPending = deferred();
  let calls = 0;
  const invoke = createOpenAINpcReactionCandidateInvoker({
    apiKey: "unit-test-credential",
    maxRequestsPerMinute: 10,
    maxConcurrentRequests: 2,
    fetch: async () => {
      calls += 1;
      if (calls === 1) return firstPending.promise;
      if (calls === 2) return secondPending.promise;
      return completedResponse();
    },
    now: () => 0
  });
  const first = invoke(requestFixture("two-first"));
  const second = invoke(requestFixture("two-second"));
  await assert.rejects(invoke(requestFixture("two-denied")), assertRateDenial);
  assert.equal(calls, 2);
  firstPending.resolve(completedResponse());
  await first;
  await invoke(requestFixture("two-after"));
  assert.equal(calls, 3);
  secondPending.resolve(completedResponse());
  await second;
});

test("concurrency lease releases after synchronous throw, rejection, and parse failure", async (t) => {
  const cases = [
    ["synchronous throw", () => { throw new Error("PRIVATE_SYNC"); }],
    ["rejected Promise", async () => { throw new Error("PRIVATE_REJECT"); }],
    ["response parse failure", async () => ({ ok: true, status: 200, headers: { get: () => null }, async json() { throw new Error("PRIVATE_PARSE"); } })]
  ];
  for (const [name, firstFetch] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      const invoke = createOpenAINpcReactionCandidateInvoker({
        apiKey: "unit-test-credential",
        maxRequestsPerMinute: 10,
        maxConcurrentRequests: 1,
        fetch: (...args) => {
          calls += 1;
          if (calls === 1) return firstFetch(...args);
          return Promise.resolve(completedResponse());
        },
        now: () => 0
      });
      await assert.rejects(invoke(requestFixture(`${name}-first`)));
      await invoke(requestFixture(`${name}-next`));
      assert.equal(calls, 2);
    });
  }
});

test("Provider normalizes local rate and concurrency denial as redacted nonretryable rate_limited", async () => {
  let fetchCalls = 0;
  const rateInvoker = createOpenAINpcReactionCandidateInvoker({
    apiKey: "unit-test-credential",
    maxRequestsPerMinute: 1,
    fetch: async () => { fetchCalls += 1; return completedResponse(); },
    now: () => 0
  });
  const rateProvider = createNpcReactionCandidateProvider({
    invokeProvider: rateInvoker,
    now: () => 0,
    setTimeout: () => 1,
    clearTimeout: () => {}
  });
  await rateProvider.generateCandidate(requestFixture("provider-rate-first"));
  await assert.rejects(rateProvider.generateCandidate(requestFixture("provider-rate-second")), (error) => {
    assert.ok(error instanceof NpcReactionCandidateProviderError);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryable, false);
    assert.equal(error.message, "NPC reaction candidate provider failed.");
    assert.equal(JSON.stringify(error).includes("budget"), false);
    return true;
  });
  assert.equal(fetchCalls, 1);

  const pending = deferred();
  let concurrencyFetches = 0;
  const concurrencyInvoker = createOpenAINpcReactionCandidateInvoker({
    apiKey: "unit-test-credential",
    maxRequestsPerMinute: 10,
    maxConcurrentRequests: 1,
    fetch: () => { concurrencyFetches += 1; return pending.promise; },
    now: () => 0
  });
  const concurrencyProvider = createNpcReactionCandidateProvider({
    invokeProvider: concurrencyInvoker,
    now: () => 0,
    setTimeout: () => 1,
    clearTimeout: () => {}
  });
  const first = concurrencyProvider.generateCandidate(requestFixture("provider-concurrency-first"));
  await assert.rejects(concurrencyProvider.generateCandidate(requestFixture("provider-concurrency-second")), (error) => {
    assert.ok(error instanceof NpcReactionCandidateProviderError);
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(concurrencyFetches, 1);
  pending.resolve(completedResponse());
  await first;
});

test("Server candidate requests across sessions share one invoker budget", async () => {
  let fetchCalls = 0;
  const invoker = createOpenAINpcReactionCandidateInvoker({
    apiKey: "unit-test-credential",
    maxRequestsPerMinute: 1,
    fetch: async () => { fetchCalls += 1; return completedResponse(); },
    now: () => 0
  });
  const provider = createNpcReactionCandidateProvider({ invokeProvider: invoker });
  const server = createWebServer({
    config: {
      provider: "pseudo",
      npcStructuredReactionMode: true,
      interpreterValidationMode: true,
      interpreterShadowMode: false,
      playerConversationCommitMode: true,
      playerStructuredConsumerMode: false,
      openai: null
    },
    npcReactionCandidateProvider: provider
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/generate-npc-reaction-candidate`;
    const first = await fetch(endpoint, candidateHttpRequest(requestFixture("server-a")));
    const second = await fetch(endpoint, candidateHttpRequest(requestFixture("server-b")));
    assert.equal(first.status, 200);
    assert.equal(second.status, 503);
    assert.deepEqual((await second.json()).error, { code: "provider_unavailable", retryable: false });
    assert.equal(fetchCalls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("CLI-equivalent local transport shares one process-local invoker budget", async () => {
  let fetchCalls = 0;
  const invoker = createOpenAINpcReactionCandidateInvoker({
    apiKey: "unit-test-credential",
    maxRequestsPerMinute: 1,
    fetch: async () => { fetchCalls += 1; return completedResponse(); },
    now: () => 0
  });
  const provider = createNpcReactionCandidateProvider({ invokeProvider: invoker });
  let correlation = 0;
  const transport = createLocalNpcReactionCandidateTransport({
    provider,
    createServerCorrelationId: () => `server-local-${++correlation}`
  });
  await transport.generateCandidateTransport(requestFixture("cli-a"));
  await assert.rejects(transport.generateCandidateTransport(requestFixture("cli-b")), (error) => {
    assert.ok(error instanceof NpcReactionCandidateProviderError);
    assert.equal(error.code, "provider_unavailable");
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(fetchCalls, 1);
});

test("malformed and flag-off HTTP requests consume no candidate fetch", async () => {
  let fetchCalls = 0;
  const provider = createNpcReactionCandidateProvider({
    invokeProvider: createOpenAINpcReactionCandidateInvoker({
      apiKey: "unit-test-credential",
      fetch: async () => { fetchCalls += 1; return completedResponse(); },
      now: () => 0
    })
  });
  for (const enabled of [true, false]) {
    const server = createWebServer({
      config: {
        provider: "pseudo",
        npcStructuredReactionMode: enabled,
        interpreterValidationMode: true,
        interpreterShadowMode: false,
        playerConversationCommitMode: true,
        playerStructuredConsumerMode: false,
        openai: null
      },
      npcReactionCandidateProvider: provider
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/generate-npc-reaction-candidate`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: "{}"
      });
      assert.equal(response.status, enabled ? 400 : 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
  assert.equal(fetchCalls, 0);
});

test("pseudo candidate invoker remains independent of OpenAI budget fields", async () => {
  let nowCalls = 0;
  const pseudo = createPseudoNpcReactionCandidateInvoker({ now: () => { nowCalls += 1; return 0; } });
  const result = await pseudo(requestFixture("pseudo"));
  assert.equal(result.diagnostics.providerName, "pseudo");
  assert.equal(nowCalls, 2);
});

function candidateHttpRequest(request) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(request)
  };
}
