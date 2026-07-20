import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { WerewolfGame } from "../src/gameEngine.mjs";
import { createLocalInterpreterHttpProvider, PseudoInterpreterProvider } from "../src/interpreterTransport.mjs";
import { createNpcCliPublicationSink } from "../src/npcCliPublicationSink.mjs";
import { createNpcBrowserPublicationSink } from "../src/npcBrowserPublicationSink.mjs";
import { createProductionNpcStructuredDeliveryIntegration } from "../src/npcProductionIntegration.mjs";
import { createNpcReactionCandidateHttpHandler, createNpcReactionCandidateProvider } from "../src/npcReactionCandidateProvider.mjs";
import { createLocalNpcReactionCandidateTransport } from "../src/npcReactionCandidateTransport.mjs";
import { createPseudoNpcReactionCandidateInvoker } from "../src/npcReactionCandidateUpstream.mjs";
import { consumeLiveActionDisplay } from "../src/playerDisplaySink.mjs";
import { runCli } from "../src/cli.mjs";

test("NPC delivery remains pending until the exact Player publication has display evidence", async () => {
  const order = [];
  const game = enabledGame({ npcWrite: async () => { order.push("npc"); } });
  const action = await ask(game);
  const playerPublicationId = action.result.conversationCommitResult.playerPublicationId;

  assert.equal(action.result.structuredNpc.routeStatus, "committed");
  assert.equal(action.result.structuredNpc.deliveryStatus, "pending_player_display");
  assert.deepEqual(order, []);
  const authoritativeBeforeDisplay = JSON.stringify(game.state);
  assert.deepEqual(Reflect.ownKeys(game.npcStructuredProductionIntegration), [
    "executeNpcReaction", "pumpNpcPublicationAfterPlayerDisplay", "reset"
  ]);

  const pending = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId
  });
  assert.equal(pending.deliveryStatus, "pending_player_display");
  assert.deepEqual(order, []);

  await displayPlayer(game, action, async () => { order.push("player"); });
  const completed = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId
  });
  assert.equal(completed.deliveryStatus, "delivered");
  assert.deepEqual(order, ["player", "npc"]);
  assert.equal(Object.isFrozen(completed), true);
  assert.equal(JSON.stringify(game.state), authoritativeBeforeDisplay);
  for (const marker of ["knownInformation", "ownRole", "ownTeam", "retryToken", "receiptId", "stack", "cause"]) {
    assert.equal(JSON.stringify(completed).includes(marker), false);
  }

  const duplicate = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId
  });
  assert.equal(duplicate, completed);
  assert.deepEqual(order, ["player", "npc"]);
  game.destroy();
});

test("legacy-compatible Player evidence also gates NPC delivery", async () => {
  const order = [];
  const game = enabledGame({ playerStructuredConsumerEnabled: false, npcWrite: async () => { order.push("npc"); } });
  const action = await ask(game);
  const playerPublicationId = action.result.conversationCommitResult.playerPublicationId;
  await displayPlayer(game, action, async () => { order.push("player"); });
  assert.equal(game.playerPublicationDeliveryController.stateFor(playerPublicationId), "evidence_recorded");
  await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({ schemaVersion: 1, gameSessionId: game.state.gameSessionId, playerPublicationId });
  assert.deepEqual(order, ["player", "npc"]);
  game.destroy();
});

test("pending handoff blocks mutation, allows reads, and rejects malformed identities without effects", async () => {
  let npcWrites = 0;
  const game = enabledGame({ npcWrite: async () => { npcWrites += 1; } });
  const action = await ask(game);
  const playerPublicationId = action.result.conversationCommitResult.playerPublicationId;
  const version = game.state.stateVersion;

  const state = await game.dispatchPlayerAction({ type: "get_state" });
  assert.equal(state.ok, true);
  assert.equal(game.state.stateVersion, version);
  await assert.rejects(
    () => game.dispatchPlayerAction({ type: "advance_vote" }),
    (error) => error.code === "input_in_progress"
  );
  assert.equal(game.state.stateVersion, version);

  const exact = { schemaVersion: 1, gameSessionId: game.state.gameSessionId, playerPublicationId };
  const sourceBefore = structuredClone(exact);
  const malformed = [
    {},
    ...Object.keys(exact).map((field) => Object.fromEntries(Object.entries(exact).filter(([key]) => key !== field))),
    { ...exact, extra: true },
    { ...exact, schemaVersion: 2 },
    Object.assign(Object.create({ inherited: true }), exact),
    Object.defineProperty({ ...exact }, "playerPublicationId", { enumerable: true, get: () => playerPublicationId }),
    Object.assign({ ...exact }, { [Symbol("hidden")]: true })
  ];
  for (const value of malformed) {
    await assert.rejects(
      () => game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(value),
      TypeError
    );
  }
  await assert.rejects(
    () => game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({ ...exact, gameSessionId: "other-session" }),
    (error) => error.code === "stale_session"
  );
  await assert.rejects(
    () => game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({ ...exact, playerPublicationId: "other-publication" }),
    (error) => error.code === "publication_not_found"
  );
  assert.equal(npcWrites, 0);
  assert.equal(game.state.stateVersion, version);
  assert.deepEqual(exact, sourceBefore);
  game.destroy();
});

test("integration pump input is strict and reset before Player evidence starts no sink", async () => {
  let npcWrites = 0;
  const game = enabledGame({ npcWrite: async () => { npcWrites += 1; } });
  const action = await ask(game);
  const integration = game.npcStructuredProductionIntegration;
  for (const value of [
    {},
    null,
    { schemaVersion: 1, gameSessionId: game.state.gameSessionId, extra: true },
    { schemaVersion: 2, gameSessionId: game.state.gameSessionId },
    { schemaVersion: 1, gameSessionId: "other-session" },
    Object.assign(Object.create({ inherited: true }), { schemaVersion: 1, gameSessionId: game.state.gameSessionId }),
    Object.defineProperty({ gameSessionId: game.state.gameSessionId }, "schemaVersion", { enumerable: true, get: () => 1 }),
    Object.assign({ schemaVersion: 1, gameSessionId: game.state.gameSessionId }, { [Symbol("hidden")]: true })
  ]) {
    await assert.rejects(() => integration.pumpNpcPublicationAfterPlayerDisplay(value), TypeError);
  }
  integration.reset();
  await displayPlayer(game, action, async () => {});
  const result = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId: action.result.conversationCommitResult.playerPublicationId
  });
  assert.equal(result.routeStatus, "reset");
  assert.equal(npcWrites, 0);
  game.destroy();
});

test("concurrent completion pumps once and destroy makes late completion stale", async () => {
  let releaseNpc;
  let npcWrites = 0;
  const game = enabledGame({
    npcWrite: async () => {
      npcWrites += 1;
      await new Promise((resolve) => { releaseNpc = resolve; });
    }
  });
  const action = await ask(game);
  await displayPlayer(game, action, async () => {});
  const input = {
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId: action.result.conversationCommitResult.playerPublicationId
  };
  const first = game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input),
    (error) => error.code === "input_in_progress"
  );
  assert.equal(npcWrites, 1);
  game.destroy();
  releaseNpc();
  await first;
  await assert.rejects(
    () => game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input),
    (error) => error.code === "stale_session"
  );
  assert.equal(npcWrites, 1);
});

test("Player display failure never starts the NPC sink and can be retried explicitly", async () => {
  let npcWrites = 0;
  const game = enabledGame({ npcWrite: async () => { npcWrites += 1; } });
  const action = await ask(game);
  const input = {
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId: action.result.conversationCommitResult.playerPublicationId
  };
  await assert.rejects(() => displayPlayer(game, action, async () => { throw new Error("player write failed"); }));
  assert.equal(npcWrites, 0);
  assert.equal((await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input)).deliveryStatus, "pending_player_display");
  await displayPlayer(game, action, async () => {});
  await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input);
  assert.equal(npcWrites, 1);
  game.destroy();
});

test("production repeat-sink retry stays nonterminal and reruns neither Provider nor Commit", async () => {
  const npcDom = failingNpcDom(1);
  let providerCalls = 0;
  const pseudo = createPseudoNpcReactionCandidateInvoker();
  const game = enabledGame({
    npcSinkType: "browser",
    npcDom,
    invokeProvider: async (request, options) => {
      providerCalls += 1;
      return pseudo(request, options);
    }
  });
  const action = await ask(game);
  const planCount = game.state.conversation.reactionPlans.length;
  await displayPlayer(game, action, async () => {});
  const input = {
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId: action.result.conversationCommitResult.playerPublicationId
  };

  const retryRequired = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input);
  assert.equal(retryRequired.deliveryStatus, "retry_required");
  assert.match(retryRequired.retryId, /^runtime-/);
  assert.equal(npcDom.appendAttempts, 1);
  await assert.rejects(() => game.dispatchPlayerAction({ type: "advance_vote" }), (error) => error.code === "input_in_progress");

  const delivered = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input);
  assert.equal(delivered.deliveryStatus, "delivered");
  assert.equal(npcDom.appendAttempts, 2);
  assert.equal(npcDom.container.children.length, 1);
  assert.equal(providerCalls, 1);
  assert.equal(game.state.conversation.reactionPlans.length, planCount);
  const duplicate = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input);
  assert.equal(duplicate, delivered);
  assert.equal(npcDom.appendAttempts, 2);
  game.destroy();
});

test("repeat-sink exhaustion is terminal and releases the mutation gate", async () => {
  const npcDom = failingNpcDom(3);
  const game = enabledGame({ npcSinkType: "browser", npcDom });
  const action = await ask(game);
  await displayPlayer(game, action, async () => {});
  const input = {
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId: action.result.conversationCommitResult.playerPublicationId
  };
  assert.equal((await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input)).deliveryStatus, "retry_required");
  assert.equal((await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input)).deliveryStatus, "retry_required");
  const exhausted = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input);
  assert.equal(exhausted.deliveryStatus, "failed_terminal");
  assert.equal(npcDom.appendAttempts, 3);
  assert.equal((await game.dispatchPlayerAction({ type: "advance_vote" })).ok, true);
  game.destroy();
});

test("ack-only and closed delivery failures retain the same engine handoff until explicit retry", async () => {
  const pumpResults = [
    frozenIntegrationResult("retry_required", "retry-ack"),
    frozenIntegrationResult("acknowledged_existing", null)
  ];
  let executeCalls = 0;
  let pumpCalls = 0;
  let simulatedSinkCalls = 1;
  const game = enabledGame({
    createIntegration: () => Object.freeze({
      async executeNpcReaction() { executeCalls += 1; return frozenIntegrationResult("pending_player_display", null, "committed"); },
      async pumpNpcPublicationAfterPlayerDisplay() {
        const result = pumpResults[pumpCalls++];
        if (pumpCalls > 1) simulatedSinkCalls += 0;
        return result;
      },
      reset() {}
    })
  });
  const action = await ask(game);
  await displayPlayer(game, action, async () => {});
  const input = { schemaVersion: 1, gameSessionId: game.state.gameSessionId, playerPublicationId: action.result.conversationCommitResult.playerPublicationId };
  assert.equal((await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input)).deliveryStatus, "retry_required");
  await assert.rejects(() => game.dispatchPlayerAction({ type: "advance_vote" }), (error) => error.code === "input_in_progress");
  assert.equal((await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input)).deliveryStatus, "acknowledged_existing");
  assert.equal(executeCalls, 1);
  assert.equal(pumpCalls, 2);
  assert.equal(simulatedSinkCalls, 1);
  game.destroy();

  const failureThenSuccess = [frozenIntegrationResult("delivery_failed"), frozenIntegrationResult("delivered")];
  let failurePumps = 0;
  const retryableGame = enabledGame({
    createIntegration: () => Object.freeze({
      async executeNpcReaction() { return frozenIntegrationResult("pending_player_display", null, "committed"); },
      async pumpNpcPublicationAfterPlayerDisplay() { return failureThenSuccess[failurePumps++]; },
      reset() {}
    })
  });
  const retryableAction = await ask(retryableGame);
  await displayPlayer(retryableGame, retryableAction, async () => {});
  const retryableInput = { schemaVersion: 1, gameSessionId: retryableGame.state.gameSessionId, playerPublicationId: retryableAction.result.conversationCommitResult.playerPublicationId };
  assert.equal((await retryableGame.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(retryableInput)).deliveryStatus, "delivery_failed");
  await assert.rejects(() => retryableGame.dispatchPlayerAction({ type: "advance_vote" }), (error) => error.code === "input_in_progress");
  assert.equal((await retryableGame.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(retryableInput)).deliveryStatus, "delivered");
  retryableGame.destroy();
});

test("reset during a retained delivery retry invalidates late retry effects", async () => {
  const npcDom = failingNpcDom(1);
  const game = enabledGame({ npcSinkType: "browser", npcDom });
  const action = await ask(game);
  await displayPlayer(game, action, async () => {});
  const input = { schemaVersion: 1, gameSessionId: game.state.gameSessionId, playerPublicationId: action.result.conversationCommitResult.playerPublicationId };
  assert.equal((await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input)).deliveryStatus, "retry_required");
  game.destroy();
  await assert.rejects(() => game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay(input), (error) => error.code === "stale_session");
  assert.equal(npcDom.appendAttempts, 1);
  assert.equal(npcDom.container.children.length, 0);
});

test("Browser and CLI entrypoints encode Player-first sequencing and stale-session DOM isolation", () => {
  const browser = readFileSync(new URL("../public/browserApp.mjs", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../src/cli.mjs", import.meta.url), "utf8");

  const browserConsume = browser.indexOf("await consumeLiveActionDisplay");
  const browserComplete = browser.indexOf("completeNpcStructuredReactionDeliveryAfterPlayerDisplay");
  assert.ok(browserConsume >= 0 && browserComplete > browserConsume);
  assert.match(browser, /sessionManager\.isCurrentGame\(gameIdAtStart\)[\s\S]*completeNpcStructuredReactionDeliveryAfterPlayerDisplay/);
  assert.match(browser, /capturedGameId[\s\S]*isCurrentGame\(capturedGameId\)/);
  assert.match(browser, /querySelectorAll\("\[data-npc-publication-id\]"\)[\s\S]*node\.remove\(\)/);
  assert.ok(browser.indexOf("node.remove()") < browser.indexOf("npcPublicationDomBookkeeping.clear()"));
  assert.equal(browser.includes("merged.push(...untrackedNpcNodes)"), false);
  assert.match(browser, /createTextNode: \(text\) => document\.createTextNode\(text\)/);

  const cliConsume = cli.indexOf("await consumeLiveActionDisplay");
  const cliComplete = cli.indexOf("completeNpcStructuredReactionDeliveryAfterPlayerDisplay");
  assert.ok(cliConsume >= 0 && cliComplete > cliConsume);
});

test("Browser New Game and renderLogs remove old or untracked NPC nodes in the actual entrypoint", async () => {
  const browser = fakeBrowserEnvironment();
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalAlert = globalThis.alert;
  globalThis.document = browser.document;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        provider: "pseudo",
        interpreterShadowMode: false,
        interpreterValidationMode: false,
        playerConversationCommitMode: false,
        playerStructuredConsumerMode: false,
        npcStructuredReactionMode: false
      };
    }
  });
  globalThis.alert = () => { throw new Error("browser initialization must not alert"); };
  try {
    await import(`../public/browserApp.mjs?npc-cleanup=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const oldNode = browser.document.createElement("div");
    oldNode.dataset.npcPublicationId = "old-publication";
    oldNode.dataset.browserGameId = "1";
    browser.elements.logList.append(oldNode);
    assert.equal(oldNode.parentNode, browser.elements.logList);
    browser.elements.newGameButton.listeners.get("click")();
    assert.equal(oldNode.parentNode, null);
    assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 0);

    const untracked = browser.document.createElement("div");
    untracked.dataset.npcPublicationId = "untracked-current-looking-publication";
    untracked.dataset.browserGameId = "2";
    browser.elements.logList.append(untracked);
    await browser.elements.voteButton.listeners.get("click")();
    assert.equal(untracked.parentNode, null);
    assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 0);
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.alert = originalAlert;
  }
});

test("actual Browser Ask control explicitly retries the retained Player display without redispatch", async () => {
  const browser = fakeBrowserEnvironment();
  const transport = browserTransportHarness();
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalAlert = globalThis.alert;
  globalThis.document = browser.document;
  globalThis.fetch = transport.fetch;
  globalThis.alert = () => { throw new Error("browser initialization must not alert"); };
  try {
    await import(`../public/browserApp.mjs?display-retry=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const submit = browser.elements.askForm.listeners.get("submit");
    browser.elements.newGameButton.listeners.get("click")();
    browser.elements.targetSelect.value = "npc1";
    browser.elements.questionInput.value = "Who do you suspect?";
    browser.elements.logList.failNextPlayerPublicationAppend = true;

    await assert.rejects(() => submit({ preventDefault() {} }), /browser_sink_attachment_failed/);
    assert.equal(transport.candidateCalls, 1);
    assert.equal(browser.elements.logList.querySelectorAll("[data-publication-id]").length, 0);
    assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 0);
    assert.equal(browser.elements.askButton.textContent, "Retry Display");

    await submit({ preventDefault() {} });
    const playerNodes = browser.elements.logList.querySelectorAll("[data-publication-id]");
    const npcNodes = browser.elements.logList.querySelectorAll("[data-npc-publication-id]");
    assert.equal(playerNodes.length, 1);
    assert.equal(npcNodes.length, 1);
    assert.ok(browser.elements.logList.children.indexOf(playerNodes[0]) < browser.elements.logList.children.indexOf(npcNodes[0]));
    assert.equal(transport.candidateCalls, 1);
    assert.equal(browser.elements.askButton.textContent, "Ask");

    await submit({ preventDefault() {} });
    assert.equal(transport.candidateCalls, 1);
    assert.equal(browser.elements.logList.querySelectorAll("[data-publication-id]").length, 1);
    assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 1);

    browser.elements.newGameButton.listeners.get("click")();
    browser.elements.targetSelect.value = "npc1";
    browser.elements.questionInput.value = "Who do you suspect now?";
    browser.elements.logList.failNextPlayerPublicationAppend = true;
    await assert.rejects(() => submit({ preventDefault() {} }), /browser_sink_attachment_failed/);
    assert.equal(transport.candidateCalls, 2);
    browser.elements.newGameButton.listeners.get("click")();
    await submit({ preventDefault() {} });
    assert.equal(transport.candidateCalls, 2);
    assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 0);
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.alert = originalAlert;
  }
});

test("actual Browser Developer Mode projects all NPC observation sources and New Game clears the session ledger", async () => {
  const browser = fakeBrowserEnvironment();
  const transport = browserTransportHarness();
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalAlert = globalThis.alert;
  globalThis.document = browser.document;
  globalThis.fetch = transport.fetch;
  globalThis.alert = () => { throw new Error("browser initialization must not alert"); };
  try {
    await import(`../public/browserApp.mjs?npc-observability=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    browser.elements.targetSelect.value = "npc1";
    browser.elements.questionInput.value = "Who do you suspect?";
    await browser.elements.askForm.listeners.get("submit")({ preventDefault() {} });
    browser.elements.devModeToggle.listeners.get("click")();

    const diagnosticText = nodeText(browser.elements.developerPanel.children.at(-1));
    assert.match(diagnosticText, /NPC Structured Observations/);
    assert.match(diagnosticText, /source=route/);
    assert.match(diagnosticText, /source=delivery_controller/);
    assert.match(diagnosticText, /source=delivery_orchestrator/);
    assert.doesNotMatch(diagnosticText, /knownInformation|prompt|rawResponse|role|team/);

    browser.elements.newGameButton.listeners.get("click")();
    const resetText = nodeText(browser.elements.developerPanel.children.at(-1));
    assert.match(resetText, /NPC Structured Observations/);
    assert.match(resetText, /No NPC structured observations yet/);
    assert.doesNotMatch(resetText, /source=route|source=delivery_controller|source=delivery_orchestrator/);
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.alert = originalAlert;
  }
});

test("actual Browser Retry Display refreshes repeat-sink and terminal observations without redispatch", async () => {
  const browser = fakeBrowserEnvironment();
  const transport = browserTransportHarness();
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalAlert = globalThis.alert;
  globalThis.document = browser.document;
  globalThis.fetch = transport.fetch;
  globalThis.alert = () => { throw new Error("browser initialization must not alert"); };
  try {
    await import(`../public/browserApp.mjs?npc-observability-retry=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    browser.elements.devModeToggle.listeners.get("click")();
    browser.elements.targetSelect.value = "npc1";
    browser.elements.questionInput.value = "Who do you suspect?";
    browser.elements.logList.failNextNpcPublicationAppend = true;
    const submit = browser.elements.askForm.listeners.get("submit");

    await submit({ preventDefault() {} });
    assert.equal(browser.elements.askButton.textContent, "Retry Display");
    assert.equal(transport.candidateCalls, 1);
    assert.equal(browser.elements.logList.querySelectorAll("[data-publication-id]").length, 1);
    assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 0);
    assert.match(nodeText(browser.elements.developerPanel), /outcome=retry_required/);
    assert.match(nodeText(browser.elements.developerPanel), /retry=repeat_sink/);

    await submit({ preventDefault() {} });
    const diagnosticText = nodeText(browser.elements.developerPanel);
    assert.equal(browser.elements.askButton.textContent, "Ask");
    assert.equal(transport.candidateCalls, 1);
    assert.equal(browser.elements.logList.querySelectorAll("[data-publication-id]").length, 1);
    assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 1);
    assert.match(diagnosticText, /outcome=delivered/);
    assert.equal((diagnosticText.match(/retry=repeat_sink/g) ?? []).length, 1);
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.alert = originalAlert;
  }
});

test("actual Browser retry isolates diagnostic projection failure after successful delivery", async () => {
  const browser = fakeBrowserEnvironment();
  const transport = browserTransportHarness();
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalAlert = globalThis.alert;
  globalThis.document = browser.document;
  globalThis.fetch = transport.fetch;
  globalThis.alert = () => { throw new Error("browser initialization must not alert"); };
  try {
    await import(`../public/browserApp.mjs?npc-observability-retry-failure=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    browser.elements.devModeToggle.listeners.get("click")();
    browser.elements.targetSelect.value = "npc1";
    browser.elements.questionInput.value = "Who do you suspect?";
    browser.elements.logList.failNextNpcPublicationAppend = true;
    const submit = browser.elements.askForm.listeners.get("submit");
    await submit({ preventDefault() {} });

    browser.elements.developerPanel.failNextReplaceChildren = true;
    await submit({ preventDefault() {} });
    const diagnosticText = nodeText(browser.elements.developerPanel);
    assert.equal(browser.elements.askButton.textContent, "Ask");
    assert.equal(transport.candidateCalls, 1);
    assert.equal(browser.elements.logList.querySelectorAll("[data-publication-id]").length, 1);
    assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 1);
    assert.match(diagnosticText, /Developer diagnostics unavailable/);
    assert.doesNotMatch(diagnosticText, /sensitive diagnostic projection failure|stack|cause/);
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.alert = originalAlert;
  }
});

test("actual Browser flag-off session reports NPC observations unavailable without creating a ledger", async () => {
  const browser = fakeBrowserEnvironment();
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalAlert = globalThis.alert;
  globalThis.document = browser.document;
  globalThis.fetch = async () => new Response(JSON.stringify({
    provider: "pseudo",
    interpreterShadowMode: false,
    interpreterValidationMode: false,
    playerConversationCommitMode: false,
    playerStructuredConsumerMode: false,
    npcStructuredReactionMode: false
  }), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.alert = () => { throw new Error("browser initialization must not alert"); };
  try {
    await import(`../public/browserApp.mjs?npc-observability-off=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    browser.elements.devModeToggle.listeners.get("click")();
    const diagnosticText = nodeText(browser.elements.developerPanel.children.at(-1));
    assert.match(diagnosticText, /NPC structured observations unavailable/);
    assert.doesNotMatch(diagnosticText, /source=/);
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.alert = originalAlert;
  }
});

test("actual CLI dev and --show-dev expose bounded NPC observations without duplicate automatic lines", async () => {
  const output = [];
  const commands = [
    "ask npc1 Who do you suspect?",
    "ask npc1 Who do you suspect now?",
    "dev",
    "quit"
  ];
  await runCli({
    runtimeConfig: {
      provider: "pseudo",
      interpreterValidationMode: true,
      playerConversationCommitMode: true,
      playerStructuredConsumerMode: true,
      npcStructuredReactionMode: true
    },
    showDev: true,
    readlineInterface: {
      async question() { return commands.shift() ?? "quit"; },
      close() {}
    },
    writeLine: (line) => output.push(String(line)),
    writeError: (line) => { throw new Error(`unexpected CLI error: ${line}`); }
  });
  const text = output.join("\n");
  assert.match(text, /NPC Structured Observations/);
  assert.match(text, /source=route/);
  assert.match(text, /source=delivery_controller/);
  assert.match(text, /source=delivery_orchestrator/);
  const observationOutput = output.filter((entry) => entry.includes("--- NPC Structured Observations ---"));
  const autoOutput = observationOutput[0];
  assert.equal(autoOutput.split("\n").filter((line) => line.startsWith("#1 ")).length, 1);
  assert.doesNotMatch(observationOutput.join("\n"), /knownInformation|rawResponse|privateMemory|promptPreview/);
});

test("actual CLI retry auto-tail prints only observations not shown before the retry", async () => {
  const output = [];
  const errors = [];
  let candidateCalls = 0;
  let playerWriteCalls = 0;
  const commands = ["ask npc1 Who do you suspect?", "retry", "retry", "quit"];
  await runCli({
    runtimeConfig: {
      provider: "openai",
      openai: {
        apiKey: "unit-test-credential",
        model: "test-model",
        maxOutputTokens: 220,
        maxRequestsPerMinute: 10,
        maxConcurrentRequests: 1,
        fetch: async (_url, options) => {
          candidateCalls += 1;
          const body = JSON.parse(options.body);
          const request = JSON.parse(body.input[0].content[0].text);
          const targetId = request.knownInformation.constraints.allowedLivingTargetIds[0];
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            async json() {
              return {
                status: "completed",
                output_text: JSON.stringify({
                  schemaVersion: 1,
                  proposals: [{ proposalType: "suspicion", targetId }]
                })
              };
            }
          };
        }
      },
      interpreterValidationMode: true,
      playerConversationCommitMode: true,
      playerStructuredConsumerMode: true,
      npcStructuredReactionMode: true
    },
    showDev: true,
    readlineInterface: {
      async question() { return commands.shift() ?? "quit"; },
      close() {}
    },
    writeLine: (line) => output.push(String(line)),
    writeError: (line) => errors.push(String(line)),
    writePublicationText: async (text) => {
      if (!text.includes("Who do you suspect?")) return;
      playerWriteCalls += 1;
      if (playerWriteCalls === 1) throw new Error("player writer failed");
    }
  });

  assert.equal(candidateCalls, 1);
  assert.equal(playerWriteCalls, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /player writer failed/);
  const observationOutput = output.filter((entry) => entry.includes("--- NPC Structured Observations ---"));
  assert.equal(observationOutput.length, 1);
  assert.match(observationOutput[0], /source=route/);
  assert.match(observationOutput[0], /source=delivery_controller/);
  assert.match(observationOutput[0], /source=delivery_orchestrator/);
  assert.match(observationOutput[0], /outcome=delivered/);
  const orders = observationOutput[0].split("\n")
    .filter((line) => /^#\d+ /.test(line))
    .map((line) => Number(line.match(/^#(\d+) /)[1]));
  assert.equal(new Set(orders).size, orders.length);
  assert.deepEqual([...orders].sort((left, right) => left - right), orders);
});

test("actual CLI retry isolates diagnostic output failure and does not retain the completed handoff", async () => {
  const errors = [];
  const commands = ["ask npc1 Who do you suspect?", "retry", "retry", "quit"];
  let playerWriteCalls = 0;
  let diagnosticFailures = 0;
  let sawNoRetryTarget = false;
  await runCli({
    runtimeConfig: {
      provider: "pseudo",
      interpreterValidationMode: true,
      playerConversationCommitMode: true,
      playerStructuredConsumerMode: true,
      npcStructuredReactionMode: true
    },
    showDev: true,
    readlineInterface: {
      async question() { return commands.shift() ?? "quit"; },
      close() {}
    },
    writeLine: (line) => {
      const text = String(line);
      if (text.includes("再試行対象の表示はありません")) sawNoRetryTarget = true;
      if (text.includes("--- developer log tail ---") && diagnosticFailures === 0) {
        diagnosticFailures += 1;
        throw new Error("sensitive diagnostic output failure");
      }
    },
    writeError: (line) => errors.push(String(line)),
    writePublicationText: async (text) => {
      if (!text.includes("Who do you suspect?")) return;
      playerWriteCalls += 1;
      if (playerWriteCalls === 1) throw new Error("player writer failed");
    }
  });

  assert.equal(playerWriteCalls, 2);
  assert.equal(diagnosticFailures, 1);
  assert.equal(sawNoRetryTarget, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /player writer failed/);
  assert.doesNotMatch(errors.join("\n"), /sensitive diagnostic output failure/);
});

test("CLI external games have no synthetic ledger and normal output never includes diagnostics", async () => {
  const externalGame = enabledGame();
  const externalOutput = [];
  const externalCommands = ["dev", "quit"];
  await runCli({
    game: externalGame,
    runtimeConfig: { playerStructuredConsumerMode: true },
    readlineInterface: { async question() { return externalCommands.shift() ?? "quit"; }, close() {} },
    writeLine: (line) => externalOutput.push(String(line)),
    writeError: () => {},
    destroyOnExit: false
  });
  assert.match(externalOutput.join("\n"), /NPC Structured Observations[\s\S]*unavailable/);
  externalGame.destroy();

  const normalOutput = [];
  const commands = ["ask npc1 Who do you suspect?", "quit"];
  await runCli({
    runtimeConfig: {
      provider: "pseudo",
      interpreterValidationMode: true,
      playerConversationCommitMode: true,
      playerStructuredConsumerMode: true,
      npcStructuredReactionMode: true
    },
    showDev: false,
    readlineInterface: { async question() { return commands.shift() ?? "quit"; }, close() {} },
    writeLine: (line) => normalOutput.push(String(line)),
    writeError: (line) => { throw new Error(`unexpected CLI error: ${line}`); }
  });
  assert.doesNotMatch(normalOutput.join("\n"), /NPC Structured Observations|source=delivery_|source=route/);
});

test("actual CLI retry command preserves the exact action after Player writer failure", async () => {
  const order = [];
  let providerCalls = 0;
  let playerWriteCalls = 0;
  const pseudo = createPseudoNpcReactionCandidateInvoker();
  const game = enabledGame({
    npcWrite: async () => { order.push("npc"); },
    invokeProvider: async (request, options) => {
      providerCalls += 1;
      return pseudo(request, options);
    }
  });
  const commands = ["ask npc1 Who do you suspect?", "retry", "retry", "quit"];
  const errors = [];
  const readlineInterface = {
    async question() { return commands.shift() ?? "quit"; },
    close() {}
  };
  await runCli({
    game,
    runtimeConfig: { playerStructuredConsumerMode: true },
    readlineInterface,
    writeLine: () => {},
    writeError: (text) => { errors.push(text); },
    writePublicationText: async (text) => {
      if (!text.includes("Who do you suspect?")) return;
      playerWriteCalls += 1;
      if (playerWriteCalls === 1) throw new Error("player writer failed");
      order.push("player");
    },
    destroyOnExit: false
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /player writer failed/);
  assert.deepEqual(order, ["player", "npc"]);
  assert.equal(playerWriteCalls, 2);
  assert.equal(providerCalls, 1);
  assert.equal(game.state.conversation.reactionPlans.length, 1);
  game.destroy();
});

async function ask(game) {
  return game.dispatchPlayerAction({ type: "ask_npc", targetId: "npc1", input: "Who do you suspect?" });
}

async function displayPlayer(game, action, write) {
  const bookkeeping = new Map();
  await consumeLiveActionDisplay({
    game,
    action,
    consumerId: "test-player",
    sinkType: "cli",
    bookkeeping,
    writeStructured: write,
    writeLegacy: write
  });
}

function enabledGame({ npcWrite, playerStructuredConsumerEnabled = true, npcSinkType = "cli", npcDom = null, invokeProvider = null, createIntegration = null } = {}) {
  const provider = createNpcReactionCandidateProvider({ invokeProvider: invokeProvider ?? createPseudoNpcReactionCandidateInvoker() });
  let serverCorrelationOrder = 0;
  const candidateTransport = createLocalNpcReactionCandidateTransport({
    provider,
    createServerCorrelationId: () => `server-candidate-${++serverCorrelationOrder}`
  });
  return WerewolfGame.create({
    seed: 1,
    scenario: "sample",
    shuffleRoles: false,
    createId: ids("game"),
    interpreterValidationEnabled: true,
    playerConversationCommitEnabled: true,
    playerStructuredConsumerEnabled,
    npcStructuredReactionEnabled: true,
    interpreterProvider: createLocalInterpreterHttpProvider(new PseudoInterpreterProvider(), {
      createServerCorrelationId: ids("server-interpreter")
    }),
    createNpcStructuredProductionIntegration: createIntegration ?? (({ gameSessionId, authorityPort, deliveryReadPort }) => {
      const sink = npcSinkType === "browser"
        ? createNpcBrowserPublicationSink({
            getConversationContainer: npcDom.getConversationContainer,
            createTextNode: npcDom.createTextNode,
            createMessageNode: npcDom.createMessageNode
          })
        : createNpcCliPublicationSink({
            write: async ({ text }) => npcWrite?.(text),
            failureGuarantee: "unknown_on_failure"
          });
      return createProductionNpcStructuredDeliveryIntegration({
        gameSessionId,
        authorityPort,
        deliveryReadPort,
        candidateTransport,
        sink,
        consumer: { consumerId: `${npcSinkType}-npc`, sinkType: npcSinkType },
        createId: ids("runtime"),
        nowUtc: () => "2026-07-20T00:00:00.000Z",
        nowMonotonicMs: () => Math.floor(performance.now()),
        scheduleTimer: (callback, delay) => setTimeout(callback, delay),
        cancelTimer: (handle) => clearTimeout(handle),
        createAbortController: () => new AbortController(),
        observer: () => {}
      });
    })
  });
}

function failingNpcDom(failures) {
  let remainingFailures = failures;
  const container = {
    children: [],
    appendAttempts: 0,
    appendChild(node) {
      this.appendAttempts += 1;
      if (remainingFailures > 0) { remainingFailures -= 1; throw new Error("browser append failed"); }
      this.children.push(node);
      node.parentNode = this;
      return node;
    },
    contains(node) { return this.children.includes(node); },
    removeChild(node) { this.children = this.children.filter((value) => value !== node); node.parentNode = null; }
  };
  return {
    container,
    get appendAttempts() { return container.appendAttempts; },
    getConversationContainer: () => container,
    createTextNode: (text) => ({ nodeType: 3, textContent: text, parentNode: null }),
    createMessageNode: ({ textNode }) => {
      const node = { nodeType: 1, childNodes: [textNode], firstChild: textNode, lastChild: textNode, parentNode: null, remove() { this.parentNode?.removeChild(this); } };
      textNode.parentNode = node;
      return node;
    }
  };
}

function frozenIntegrationResult(deliveryStatus, retryId = null, routeStatus = "committed") {
  return Object.freeze({
    schemaVersion: 1,
    resultType: "npc_structured_production_integration",
    enabled: true,
    routeStatus,
    deliveryStatus,
    publicationId: null,
    retryId,
    errorCode: deliveryStatus === "delivery_failed" ? "integration_invariant" : null,
    legacyUsed: false,
    legacySuppressed: true
  });
}

function ids(prefix) {
  let order = 0;
  return () => `${prefix}-${++order}`;
}

function fakeBrowserEnvironment() {
  class FakeNode {
    constructor(tagName) {
      this.tagName = tagName;
      this.nodeType = tagName === "#text" ? 3 : 1;
      this.children = [];
      this.childNodes = this.children;
      this.dataset = {};
      this.listeners = new Map();
      this.parentNode = null;
      this.textContent = "";
      this.value = "";
      this.hidden = false;
      this.disabled = false;
      this.className = "";
      this.scrollTop = 0;
    }
    get firstChild() { return this.children[0] ?? null; }
    get lastChild() { return this.children.at(-1) ?? null; }
    get scrollHeight() { return this.children.length; }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) {
      if (this.failNextPlayerPublicationAppend && Object.hasOwn(node.dataset, "publicationId")) {
        this.failNextPlayerPublicationAppend = false;
        throw new Error("browser_sink_attachment_failed");
      }
      if (this.failNextNpcPublicationAppend && Object.hasOwn(node.dataset, "npcPublicationId")) {
        this.failNextNpcPublicationAppend = false;
        throw new Error("browser_sink_attachment_failed");
      }
      node.remove?.();
      this.children.push(node);
      node.parentNode = this;
      return node;
    }
    replaceChildren(...nodes) {
      if (this.failNextReplaceChildren) {
        this.failNextReplaceChildren = false;
        throw new Error("sensitive diagnostic projection failure");
      }
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      this.childNodes = this.children;
      this.append(...nodes);
    }
    remove() {
      if (!this.parentNode) return;
      const parent = this.parentNode;
      parent.children = parent.children.filter((child) => child !== this);
      parent.childNodes = parent.children;
      this.parentNode = null;
    }
    contains(node) { return this === node || this.children.some((child) => child.contains?.(node)); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    setAttribute(name, value) { this[name] = String(value); }
    querySelectorAll(selector) {
      const field = selector === "[data-publication-id]" ? "publicationId"
        : selector === "[data-npc-publication-id]" ? "npcPublicationId" : null;
      if (!field) return [];
      const found = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (Object.hasOwn(child.dataset, field)) found.push(child);
          visit(child);
        }
      };
      visit(this);
      return found;
    }
  }

  const ids = [
    "statusLine", "newGameButton", "playerGrid", "askForm", "targetSelect", "questionInput",
    "askButton", "voteButton", "nightButton", "logList", "voteList", "devModeToggle", "developerPanel"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeNode(id)]));
  const document = {
    querySelector(selector) { return elements[selector.slice(1)]; },
    createElement(tagName) { return new FakeNode(tagName); },
    createTextNode(text) { const node = new FakeNode("#text"); node.nodeType = 3; node.textContent = text; return node; }
  };
  return { document, elements };
}

function nodeText(node) {
  return [node.textContent, ...node.children.flatMap((child) => nodeText(child))].filter(Boolean).join("\n");
}

function browserTransportHarness() {
  const interpreter = createLocalInterpreterHttpProvider(new PseudoInterpreterProvider(), {
    createServerCorrelationId: ids("browser-interpreter")
  });
  const provider = createNpcReactionCandidateProvider({ invokeProvider: createPseudoNpcReactionCandidateInvoker() });
  const handler = createNpcReactionCandidateHttpHandler({
    provider,
    createServerCorrelationId: ids("browser-candidate")
  });
  let candidateCalls = 0;
  return {
    get candidateCalls() { return candidateCalls; },
    async fetch(url, options = {}) {
      if (url === "/api/runtime-config") {
        return new Response(JSON.stringify({
          provider: "pseudo",
          interpreterShadowMode: false,
          interpreterValidationMode: true,
          playerConversationCommitMode: true,
          playerStructuredConsumerMode: true,
          npcStructuredReactionMode: true
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/interpret-player-input") {
        const request = JSON.parse(options.body);
        const response = await interpreter.interpretPlayerInput(request, { signal: options.signal });
        return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      if (url === "/api/generate-npc-reaction-candidate") {
        candidateCalls += 1;
        const response = await handler.handle({
          method: "POST",
          path: "/api/generate-npc-reaction-candidate",
          contentTypeHeader: "application/json; charset=utf-8",
          contentEncodingHeader: null,
          bodyBytes: new TextEncoder().encode(options.body)
        }, { signal: options.signal });
        return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
      }
      throw new Error(`Unexpected browser test URL: ${url}`);
    }
  };
}
