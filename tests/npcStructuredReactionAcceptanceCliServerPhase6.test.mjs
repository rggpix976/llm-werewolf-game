import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { sha256CanonicalJson } from "../src/conversation/ids.mjs";
import { HttpResponseProvider } from "../public/httpResponseProvider.mjs";
import { runCli } from "../src/cli.mjs";
import { createNpcReactionCandidateProvider } from "../src/npcReactionCandidateProvider.mjs";
import { createPseudoNpcReactionCandidateInvoker } from "../src/npcReactionCandidateUpstream.mjs";
import { createWebServer } from "../src/webServer.mjs";
import {
  assertPrivacySafe,
  completePlayerAndNpc,
  createAcceptanceGame,
  createDeferred,
  createDeliveryAcceptanceGame,
  installOneShotAcknowledgementPublicationFault,
  authoritativeSnapshot
} from "./helpers/npcStructuredReactionAcceptanceHarness.mjs";

for (const [id, consumerEnabled] of [["ACC-018", false], ["ACC-019", true]]) {
  test(`${id} actual CLI preserves two-question order and vote/night continuity with consumer ${consumerEnabled ? "on" : "off"}`, async () => {
    const order = [];
    const output = [];
    const errors = [];
    const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
    const { game } = createAcceptanceGame({
      counters,
      playerStructuredConsumerEnabled: consumerEnabled,
      npcWrite: async () => { order.push("npc"); }
    });
    const commands = [
      "ask npc1 CLI question A?",
      "ask npc2 CLI question B?",
      "state",
      "vote",
      "dev",
      "quit"
    ];
    await runCli({
      game,
      runtimeConfig: { playerStructuredConsumerMode: consumerEnabled },
      readlineInterface: { async question() { return commands.shift() ?? "quit"; }, close() {} },
      writeLine: (line) => output.push(String(line)),
      writeError: (line) => errors.push(String(line)),
      writePublicationText: async (text) => {
        if (text.includes("CLI question")) order.push("player");
      },
      destroyOnExit: false
    });
    assert.deepEqual(order.slice(0, 4), ["player", "npc", "player", "npc"]);
    assert.equal(counters.candidate, 2);
    assert.equal(counters.legacy, 0);
    assert.equal(game.state.conversation.reactionPlans.length, 2);
    assert.equal(game.state.voteHistory.length, 1);
    assert.equal(game.state.day, 2);
    assert.equal(game.state.phase, "day_discussion");
    assert.deepEqual(errors, []);
    assertPrivacySafe(output.join("\n"));
    game.destroy();
  });
}

test("ACC-020 actual CLI retry command preserves Player, repeat_sink, and ack_only authorities", async (t) => {
  await t.test("Player writer failure retries the same frozen action", async () => {
    const order = [];
    const errors = [];
    const output = [];
    let playerAttempts = 0;
    const counters = { candidate: 0, legacy: 0, ids: 0, npcWrites: 0, playerWrites: 0 };
    const { game } = createAcceptanceGame({
      counters,
      playerStructuredConsumerEnabled: true,
      npcWrite: async () => { order.push("npc"); }
    });
    const commands = ["ask npc1 CLI retry question?", "retry", "retry", "state", "quit"];
    await runCli({
      game,
      runtimeConfig: { playerStructuredConsumerMode: true },
      readlineInterface: { async question() { return commands.shift() ?? "quit"; }, close() {} },
      writeLine: (line) => output.push(String(line)),
      writeError: (line) => errors.push(String(line)),
      writePublicationText: async (text) => {
        if (!text.includes("CLI retry question?")) return;
        playerAttempts += 1;
        if (playerAttempts === 1) throw new Error("player writer failed");
        order.push("player");
      },
      destroyOnExit: false
    });
    assert.equal(playerAttempts, 2);
    assert.deepEqual(order, ["player", "npc"]);
    assert.equal(counters.candidate, 1);
    assert.equal(counters.legacy, 0);
    assert.equal(game.state.conversation.reactionPlans.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /player writer failed/);
    assert.equal(output.some((line) => /^Day \d+ \/ phase=/.test(line)), true);
    game.destroy();
  });

  await t.test("repeat_sink retries only the actual CLI writer", async () => {
    const order = [];
    const errors = [];
    const observations = [];
    const output = [];
    const counters = { candidate: 0, legacy: 0, npcWrites: 0, playerWrites: 0 };
    let npcAttempts = 0;
    let beforeRetry;
    const { game } = createDeliveryAcceptanceGame({
      counters,
      failureGuarantee: "no_output_on_rejection",
      observer: (event) => observations.push(event),
      npcWrite: async () => {
        npcAttempts += 1;
        if (npcAttempts === 1) throw new Error("proved CLI NPC no-output");
        order.push("npc");
      }
    });
    const commands = ["ask npc1 CLI repeat sink?", "retry", "state", "quit"];
    await runCli({
      game,
      runtimeConfig: { playerStructuredConsumerMode: true },
      readlineInterface: {
        async question() {
          const command = commands.shift() ?? "quit";
          if (command === "retry") beforeRetry = authoritativeSnapshot(game);
          return command;
        },
        close() {}
      },
      writeLine: (line) => output.push(String(line)),
      writeError: (line) => errors.push(String(line)),
      writePublicationText: async (text) => { if (text.includes("CLI repeat sink?")) order.push("player"); },
      destroyOnExit: false
    });
    assert.deepEqual(order, ["player", "npc"]);
    assert.equal(npcAttempts, 2);
    assert.equal(counters.candidate, 1);
    assert.equal(counters.legacy, 0);
    assert.deepEqual(authoritativeSnapshot(game), beforeRetry);
    assert.deepEqual(errors, []);
    assert.equal(output.some((line) => /^Day \d+ \/ phase=/.test(line)), true);
    assert.equal(new Set(observations
      .filter((event) => event.eventType === "npc_publication_delivery_orchestration")
      .map((event) => event.publicationId)
      .filter((publicationId) => publicationId !== null)).size, 1);
    game.destroy();
  });

  await t.test("ack_only retries the actual acknowledgement without a second CLI writer call", async () => {
    const observations = [];
    const errors = [];
    const output = [];
    const counters = { candidate: 0, legacy: 0, npcWrites: 0, playerWrites: 0 };
    let beforeRetry;
    const { game } = createDeliveryAcceptanceGame({ counters, observer: (event) => observations.push(event) });
    const commands = ["ask npc1 CLI ack only?", "retry", "state", "quit"];
    const fault = installOneShotAcknowledgementPublicationFault();
    try {
      await runCli({
        game,
        runtimeConfig: { playerStructuredConsumerMode: true },
        readlineInterface: {
          async question() {
            const command = commands.shift() ?? "quit";
            if (command === "retry") beforeRetry = authoritativeSnapshot(game);
            return command;
          },
          close() {}
        },
        writeLine: (line) => output.push(String(line)),
        writeError: (line) => errors.push(String(line)),
        writePublicationText: async () => {},
        destroyOnExit: false
      });
      const retry = observations.find((event) => event.eventType === "npc_publication_delivery_orchestration"
        && event.resultType === "retry_required");
      assert.equal(retry.retryMode, "ack_only");
      assert.equal(fault.acknowledgementAttempts, 2);
      assert.equal(counters.npcWrites, 1);
      assert.equal(counters.candidate, 1);
      assert.equal(counters.legacy, 0);
      assert.deepEqual(authoritativeSnapshot(game), beforeRetry);
      assert.deepEqual(errors, []);
      assert.equal(output.some((line) => /^Day \d+ \/ phase=/.test(line)), true);
      assert.equal(new Set(observations
        .filter((event) => event.eventType === "npc_publication_delivery_orchestration")
        .map((event) => event.publicationId)
        .filter((publicationId) => publicationId !== null)).size, 1);
    } finally {
      fault.restore();
      game.destroy();
    }
  });
});

test("ACC-021 actual CLI observability is bounded, redacted, and absent from normal output", async () => {
  const output = [];
  const errors = [];
  const commands = ["ask npc1 CLI observation?", "dev", "quit"];
  await runCli({
    runtimeConfig: structuredRuntimeConfig(true),
    showDev: true,
    readlineInterface: { async question() { return commands.shift() ?? "quit"; }, close() {} },
    writeLine: (line) => output.push(String(line)),
    writeError: (line) => errors.push(String(line))
  });
  const observationBlocks = output.filter((line) => line.includes("--- NPC Structured Observations ---"));
  assert.ok(observationBlocks.length >= 1);
  const observationText = observationBlocks.join("\n");
  assert.match(observationText, /source=route/);
  assert.match(observationText, /source=delivery_controller/);
  assert.match(observationText, /source=delivery_orchestrator/);
  assertPrivacySafe(observationText);
  for (const forbidden of ["knownInformation", "privateMemory", "promptPreview", "rawResponse", "retryToken", "receiptId"]) {
    assert.equal(observationText.includes(forbidden), false);
  }
  assert.deepEqual(errors, []);

  const normalOutput = [];
  const normalCommands = ["ask npc1 CLI normal output?", "quit"];
  await runCli({
    runtimeConfig: structuredRuntimeConfig(true),
    showDev: false,
    readlineInterface: { async question() { return normalCommands.shift() ?? "quit"; }, close() {} },
    writeLine: (line) => normalOutput.push(String(line)),
    writeError: (line) => { throw new Error(`unexpected CLI error: ${line}`); }
  });
  assert.equal(normalOutput.join("\n").includes("NPC Structured Observations"), false);
});

test("ACC-022 actual Server keeps the candidate endpoint absent when the flag is off", async () => {
  let candidateCalls = 0;
  await withServer({
    config: structuredRuntimeConfig(false),
    npcReactionCandidateProvider: { async generateCandidate() { candidateCalls += 1; throw new Error("must not run"); } }
  }, async (baseUrl) => {
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:/);
    const config = await fetch(`${baseUrl}/api/runtime-config`);
    assert.equal(config.status, 200);
    assert.equal((await config.json()).npcStructuredReactionMode, false);
    const candidate = await fetch(`${baseUrl}/api/generate-npc-reaction-candidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: "{}"
    });
    assert.equal(candidate.status, 404);
    assert.equal(candidateCalls, 0);
  });
});

test("ACC-023 actual HttpResponseProvider and localhost Server complete one candidate, commit, and delivery", async () => {
  let providerCalls = 0;
  const pseudo = createPseudoNpcReactionCandidateInvoker();
  const candidateProvider = createNpcReactionCandidateProvider({
    invokeProvider: async (request, options) => {
      providerCalls += 1;
      return pseudo(request, options);
    }
  });
  await withServer({
    config: structuredRuntimeConfig(true),
    npcReactionCandidateProvider: candidateProvider
  }, async (baseUrl) => {
    const requestTargets = [];
    const responseEvidence = [];
    let authorizationHeaderCount = 0;
    const httpProvider = new HttpResponseProvider({
      fetch: async (url, options) => {
        const target = new URL(url, baseUrl);
        assert.equal(target.origin, new URL(baseUrl).origin);
        requestTargets.push(target.pathname);
        assert.equal(Object.hasOwn(options.headers, ["Author", "ization"].join("")), false);
        authorizationHeaderCount += Object.keys(options.headers).filter((name) => name.toLowerCase() === "authorization").length;
        const response = await fetch(target, options);
        const rawBytes = Buffer.from(await response.clone().arrayBuffer());
        const parsed = await response.clone().json();
        responseEvidence.push({ status: response.status, cacheControl: response.headers.get("cache-control"), rawBytes, parsed });
        return response;
      }
    });
    const counters = { candidate: 0, legacy: 0, npcWrites: 0, playerWrites: 0 };
    const { game } = createDeliveryAcceptanceGame({
      counters,
      idPrefix: "loopback-game",
      candidateTransport: Object.freeze({
        generateCandidateTransport: httpProvider.generateCandidateTransport.bind(httpProvider)
      })
    });
    const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Loopback candidate?" });
    const { delivery } = await completePlayerAndNpc(game, action, { counters });
    assert.equal(action.result.structuredNpc.routeStatus, "committed");
    assert.equal(delivery.deliveryStatus, "delivered");
    assert.deepEqual(requestTargets, ["/api/generate-npc-reaction-candidate"]);
    assert.equal(responseEvidence[0].status, 200);
    assert.equal(responseEvidence[0].cacheControl, "no-store");
    assert.deepEqual(responseEvidence[0].rawBytes, Buffer.from(JSON.stringify(responseEvidence[0].parsed), "utf8"));
    assert.equal(authorizationHeaderCount, 0);
    assert.equal(providerCalls, 1);
    assert.equal(counters.legacy, 0);
    assert.equal(counters.npcWrites, 1);
    assert.equal(game.state.phase, "day_discussion");
    assert.equal(game.state.conversation.reactionPlans.length, 1);
    game.destroy();
  });
});

test("ACC-024 actual Server rejects malformed requests, propagates disconnect abort, and remains reusable", async () => {
  let providerCalls = 0;
  const entered = createDeferred();
  const aborted = createDeferred();
  const release = createDeferred();
  let capturedSignal;
  const provider = {
    async generateCandidate(request, { signal }) {
      providerCalls += 1;
      if (providerCalls === 1) {
        capturedSignal = signal;
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await release.promise;
      }
      return candidateResultFixture(request);
    }
  };
  await withServer({ config: structuredRuntimeConfig(true), npcReactionCandidateProvider: provider }, async (baseUrl) => {
    const wrongMethod = await fetch(`${baseUrl}/api/generate-npc-reaction-candidate`, { method: "GET" });
    assert.equal(wrongMethod.status, 405);

    const wrongContentType = await fetch(`${baseUrl}/api/generate-npc-reaction-candidate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
    });
    assert.equal(wrongContentType.status, 415);

    const encoded = await fetch(`${baseUrl}/api/generate-npc-reaction-candidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "identity" },
      body: "{}"
    });
    assert.equal(encoded.status, 415);
    assertPrivacySafe(await encoded.text());

    const malformed = await fetch(`${baseUrl}/api/generate-npc-reaction-candidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: "{"
    });
    assert.equal(malformed.status, 400);
    assertPrivacySafe(await malformed.text());

    const invalidSchema = await fetch(`${baseUrl}/api/generate-npc-reaction-candidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ...candidateRequestFixture(), extra: true })
    });
    assert.equal(invalidSchema.status, 400);
    assertPrivacySafe(await invalidSchema.text());

    const oversized = await fetch(`${baseUrl}/api/generate-npc-reaction-candidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: "x".repeat(65_537)
    });
    assert.equal(oversized.status, 413);
    assertPrivacySafe(await oversized.text());
    assert.equal(providerCalls, 0);

    const responseBodies = [];
    const clientErrors = [];
    const requestBody = JSON.stringify(candidateRequestFixture());
    const target = new URL("/api/generate-npc-reaction-candidate", baseUrl);
    let pendingRequest;
    const disconnected = new Promise((resolve) => {
      pendingRequest = httpRequest(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(requestBody)
        }
      }, (response) => {
        response.on("data", (chunk) => responseBodies.push(Buffer.from(chunk)));
        response.on("end", resolve);
      });
      pendingRequest.on("error", (error) => { clientErrors.push(error); resolve(); });
      pendingRequest.end(requestBody);
    });
    await entered.promise;
    pendingRequest.destroy(new Error("STACK_CAUSE_MARKER_DO_NOT_LEAK"));
    await aborted.promise;
    assert.equal(capturedSignal.aborted, true);
    release.resolve();
    await disconnected;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(responseBodies.length, 0);
    assert.equal(clientErrors.length, 1);
    assert.equal(providerCalls, 1);

    const runtime = await fetch(`${baseUrl}/api/runtime-config`);
    assert.equal(runtime.status, 200);
    assert.equal((await runtime.json()).npcStructuredReactionMode, true);

    const valid = await fetch(`${baseUrl}/api/generate-npc-reaction-candidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: requestBody
    });
    assert.equal(valid.status, 200);
    assertPrivacySafe(await valid.text());
    assert.equal(providerCalls, 2);
  });
});

function structuredRuntimeConfig(npcStructuredReactionMode) {
  return {
    provider: "pseudo",
    interpreterShadowMode: false,
    interpreterValidationMode: true,
    playerConversationCommitMode: true,
    playerStructuredConsumerMode: true,
    npcStructuredReactionMode,
    openai: { maxRequestsPerMinute: 60 }
  };
}

async function withServer(options, callback) {
  const server = createWebServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.equal(address.address, "127.0.0.1");
    return await callback(`http://127.0.0.1:${address.port}`, server);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.equal(server.listening, false);
    const connectionCount = await new Promise((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)));
    assert.equal(connectionCount, 0);
  }
}

const CANDIDATE_REQUEST_FIELDS = [
  "schemaVersion", "operation", "gameSessionId", "reactionPlanId", "reactionAttemptId", "requestId",
  "requestFingerprint", "correlationId", "causationId", "originatingInputRecordId", "turnId", "turnOrder",
  "preconditionPhase", "preconditionStateVersion", "npcId", "knownInformation", "limits"
];

function candidateRequestFixture() {
  const request = {
    schemaVersion: 1,
    operation: "generate_npc_reaction_candidate",
    gameSessionId: "acceptance-session-1",
    reactionPlanId: "acceptance-plan-1",
    reactionAttemptId: "acceptance-attempt-1",
    requestId: "acceptance-request-1",
    requestFingerprint: "0".repeat(64),
    correlationId: "acceptance-correlation-1",
    causationId: "acceptance-player-request-1",
    originatingInputRecordId: "acceptance-input-1",
    turnId: "acceptance-turn-1",
    turnOrder: 1,
    preconditionPhase: "player_question",
    preconditionStateVersion: 2,
    npcId: "npc1",
    knownInformation: {
      schemaVersion: 1,
      projectionType: "npc_known_information",
      public: {
        day: 1,
        phase: "player_question",
        participants: [
          { participantId: "npc1", displayName: "Aoi", publicStatus: "alive" },
          { participantId: "npc2", displayName: "Beni", publicStatus: "alive" },
          { participantId: "player", displayName: "Player", publicStatus: "alive" }
        ],
        events: [{
          schemaVersion: 1, projectionType: "public_question_event", eventId: "acceptance-event-1",
          actorId: "player", turnId: "acceptance-turn-1", occurredPhase: "day_discussion",
          targetId: "npc1", topic: "result"
        }],
        claims: [], votes: [], executions: [], attackDeaths: [],
        triggeringInput: {
          schemaVersion: 1, inputRecordId: "acceptance-input-1", requestId: "acceptance-player-request-1",
          correlationId: "acceptance-player-correlation-1", turnId: "acceptance-turn-1", capturedStateVersion: 1,
          actorId: "player", rawText: "Aoi, what is your result?", locale: "en"
        }
      },
      actorPrivate: {
        actorId: "npc1", ownRole: "seer", ownTeam: "village",
        investigationResults: [{ day: 1, targetId: "npc2", result: "werewolf", disclosurePolicy: "engine_policy_required" }],
        voteHistory: [], suspicionScores: [{ targetId: "npc2", score: 2 }]
      },
      constraints: {
        allowedTargetIds: ["npc2"], allowedLivingTargetIds: ["npc2"], allowedResultTargetIds: ["npc2"],
        allowedCandidateKinds: ["role_claim", "result_claim", "vote_declaration", "suspicion"],
        allowedClaimRoles: ["seer"], allowedResultValues: ["werewolf"],
        allowedReferenceIds: ["acceptance-event-1", "acceptance-input-1"],
        roleDisclosurePolicy: "claim_when_directly_asked_after_result"
      },
      presentation: { speechStyleId: "brief" }
    },
    limits: { maxProposals: 16, maxNestingDepth: 5 }
  };
  request.requestFingerprint = sha256CanonicalJson(Object.fromEntries(CANDIDATE_REQUEST_FIELDS
    .filter((field) => !["reactionAttemptId", "requestFingerprint"].includes(field))
    .map((field) => [field, request[field]])));
  return request;
}

function candidateResultFixture(request) {
  return {
    schemaVersion: 1,
    operation: request.operation,
    gameSessionId: request.gameSessionId,
    reactionPlanId: request.reactionPlanId,
    reactionAttemptId: request.reactionAttemptId,
    requestId: request.requestId,
    requestFingerprint: request.requestFingerprint,
    correlationId: request.correlationId,
    causationId: request.causationId,
    originatingInputRecordId: request.originatingInputRecordId,
    turnId: request.turnId,
    turnOrder: request.turnOrder,
    preconditionPhase: request.preconditionPhase,
    preconditionStateVersion: request.preconditionStateVersion,
    npcId: request.npcId,
    candidate: { schemaVersion: 1, proposals: [{ proposalType: "suspicion", targetId: "npc2" }] },
    diagnostics: { providerName: "acceptance", model: "deterministic", attemptCount: 1, elapsedMs: 1 }
  };
}
