import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { reconcileBrowserPublicationNodes } from "../src/playerDisplaySink.mjs";
import {
  browserPublicationOrder,
  settleMicrotasks,
  submitBrowserQuestion,
  withBrowserApp
} from "./helpers/npcStructuredReactionAcceptanceHarness.mjs";
import {
  createBrowserEnvironment
} from "./helpers/npcStructuredReactionLifecycleCorrectionHarness.mjs";

const BROWSER_APP_URL = new URL("../public/browserApp.mjs", import.meta.url);
const PRIVATE_DIAGNOSTIC_MARKER = "BLR_PRIVATE_DIAGNOSTIC_MARKER_DO_NOT_RENDER";
let browserImportOrder = 0;

for (const [id, consumerEnabled] of [["BLR-001", false], ["BLR-002", true]]) {
  test(`${id} actual flag-off Browser preserves one legacy NPC response with consumer ${consumerEnabled ? "on" : "off"}`, async () => {
    const question = `${id} question`;
    const answer = `${id} legacy NPC answer`;
    await withLegacyBrowserApp({ consumerEnabled, answers: [answer] }, async ({ browser, transport }) => {
      await submitLegacyQuestion(browser, "npc1", question);

      const messages = directMessages(browser);
      const legacyNpcNode = findDirectMessageNode(browser, (value) => value === `Aoi: ${answer}`);
      assert.equal(transport.legacyCalls, 1);
      assert.equal(transport.candidateCalls, 0);
      assert.equal(messages.filter((value) => value.includes(question)).length, 1);
      assert.equal(messages.filter((value) => value === `Aoi: ${answer}`).length, 1);
      const relevant = relevantMessages(messages, [question, answer]);
      assert.equal(relevant.length, 2);
      assert.ok(relevant[0].includes(question));
      assert.equal(relevant[1], `Aoi: ${answer}`);
      assert.ok(legacyNpcNode);
      assert.equal(Object.hasOwn(legacyNpcNode.dataset, "publicationId"), false);
      assert.equal(Object.hasOwn(legacyNpcNode.dataset, "npcPublicationId"), false);
      assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 0);
      assert.equal(browser.elements.askButton.textContent, "Ask");
      assert.equal(nodeText(browser.elements.logList).includes(PRIVATE_DIAGNOSTIC_MARKER), false);
    });
  });
}

test("BLR-003 two flag-off questions survive repeated reconciliation in source order", async (t) => {
  for (const consumerEnabled of [false, true]) {
    await t.test(`consumer ${consumerEnabled ? "on" : "off"}`, async () => {
      const questionA = `BLR-003 ${consumerEnabled} question A`;
      const questionB = `BLR-003 ${consumerEnabled} question B`;
      const answerA = `BLR-003 ${consumerEnabled} answer A`;
      const answerB = `BLR-003 ${consumerEnabled} answer B`;
      await withLegacyBrowserApp({
        consumerEnabled,
        answers: [answerA, answerB]
      }, async ({ browser, transport }) => {
        await submitLegacyQuestion(browser, "npc1", questionA);
        assert.equal(directMessages(browser).filter((value) => value === `Aoi: ${answerA}`).length, 1);

        await submitLegacyQuestion(browser, "npc2", questionB);
        const messages = directMessages(browser);
        assert.equal(transport.legacyCalls, 2);
        assert.equal(transport.candidateCalls, 0);
        assertMarkerOrder(messages, [questionA, answerA, questionB, answerB]);
        for (const marker of [questionA, answerA, questionB, answerB]) {
          assert.equal(messages.filter((value) => value.includes(marker)).length, 1, marker);
        }
      });
    });
  }
});

test("BLR-004 an additional public render keeps the legacy pair exactly once", async () => {
  const question = "BLR-004 question";
  const answer = "BLR-004 legacy NPC answer";
  await withLegacyBrowserApp({ consumerEnabled: false, answers: [answer] }, async ({ browser, transport }) => {
    await submitLegacyQuestion(browser, "npc1", question);
    await browser.elements.voteButton.listeners.get("click")();

    const messages = directMessages(browser);
    assert.equal(transport.legacyCalls, 1);
    assert.equal(transport.candidateCalls, 0);
    assert.equal(messages.filter((value) => value.includes(question)).length, 1);
    assert.equal(messages.filter((value) => value === `Aoi: ${answer}`).length, 1);
    const playerIndex = messages.findIndex((value) => value === `あなた -> Aoi: ${question}`);
    const npcIndex = messages.findIndex((value) => value === `Aoi: ${answer}`);
    assert.ok(playerIndex >= 0);
    assert.ok(npcIndex >= 0);
    assert.ok(playerIndex < npcIndex);
  });
});

test("BLR-005 New Game removes the old legacy pair and a fresh pair renders once", async () => {
  const oldQuestion = "BLR-005 old question";
  const oldAnswer = "BLR-005 old answer";
  const freshQuestion = "BLR-005 fresh question";
  const freshAnswer = "BLR-005 fresh answer";
  await withLegacyBrowserApp({
    consumerEnabled: false,
    answers: [oldAnswer, freshAnswer]
  }, async ({ browser, transport }) => {
    await submitLegacyQuestion(browser, "npc1", oldQuestion);
    assert.equal(directMessages(browser).filter((value) => value === `Aoi: ${oldAnswer}`).length, 1);

    browser.elements.newGameButton.listeners.get("click")();
    await settleMicrotasks();
    assert.equal(nodeText(browser.elements.logList).includes(oldQuestion), false);
    assert.equal(nodeText(browser.elements.logList).includes(oldAnswer), false);
    assert.equal(browser.elements.askButton.textContent, "Ask");

    await submitLegacyQuestion(browser, "npc1", freshQuestion);
    const messages = directMessages(browser);
    assert.equal(transport.legacyCalls, 2);
    assert.equal(transport.candidateCalls, 0);
    assert.equal(messages.filter((value) => value.includes(freshQuestion)).length, 1);
    assert.equal(messages.filter((value) => value === `Aoi: ${freshAnswer}`).length, 1);
    assert.equal(messages.some((value) => value.includes(oldQuestion) || value.includes(oldAnswer)), false);
  });
});

test("BLR-006 a fresh disabled Browser shows the legacy answer and unavailable structured observations", async () => {
  const answer = "BLR-006 disabled legacy answer";
  await withLegacyBrowserApp({ consumerEnabled: false, answers: [answer] }, async ({ browser, transport }) => {
    await submitLegacyQuestion(browser, "npc1", "BLR-006 disabled question");
    browser.elements.devModeToggle.listeners.get("click")();

    assert.equal(transport.legacyCalls, 1);
    assert.equal(transport.candidateCalls, 0);
    assert.equal(directMessages(browser).filter((value) => value === `Aoi: ${answer}`).length, 1);
    assert.match(nodeText(browser.elements.developerPanel), /NPC structured observations unavailable/);
    assert.equal(browser.elements.askButton.textContent, "Ask");
    assert.doesNotMatch(nodeText(browser.elements.logList), /Error:/);
  });
});

for (const [id, consumerEnabled] of [["BLR-007", false], ["BLR-008", true]]) {
  test(`${id} structured Browser ordering and identity remain unchanged with consumer ${consumerEnabled ? "on" : "off"}`, async () => {
    await withBrowserApp(consumerEnabled, async ({ browser, transport }) => {
      const questionA = `${id} structured question A`;
      const questionB = `${id} structured question B`;
      await submitBrowserQuestion(browser, "npc1", questionA);
      await submitBrowserQuestion(browser, "npc2", questionB);

      const playerNodes = browser.elements.logList.querySelectorAll("[data-publication-id]");
      const npcNodes = browser.elements.logList.querySelectorAll("[data-npc-publication-id]");
      assert.equal(transport.candidateCalls, 2);
      assert.equal(playerNodes.length, 2);
      assert.equal(npcNodes.length, 2);
      assert.deepEqual(browserPublicationOrder(browser), ["player", "npc", "player", "npc"]);
      assert.equal(new Set(playerNodes.map((node) => node.dataset.publicationId)).size, 2);
      assert.equal(new Set(npcNodes.map((node) => node.dataset.npcPublicationId)).size, 2);
      assert.equal(browser.elements.logList.children.filter((node) => (
        !Object.hasOwn(node.dataset, "publicationId")
        && !Object.hasOwn(node.dataset, "npcPublicationId")
        && [questionA, questionB].some((question) => nodeText(node).includes(question))
      )).length, 0);
    });
  });
}

test("BLR-009 reconciliation keeps ID-less nodes while the Browser anchor counter remains publication-only", () => {
  const browser = createBrowserEnvironment();
  const entries = [
    { day: 1, phase: "npc_response", message: "legacy before" },
    { day: 1, phase: "player_question", message: "publication backed", publicationId: "player-publication-1" },
    { day: 1, phase: "npc_response", message: "legacy after" }
  ];
  const nodes = reconcileBrowserPublicationNodes({
    document: browser.document,
    container: browser.elements.logList,
    entries
  });
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.map(messageText), entries.map((entry) => entry.message));
  assert.deepEqual(
    nodes.map((node) => Object.hasOwn(node.dataset, "publicationId")),
    [false, true, false]
  );

  const source = readFileSync(BROWSER_APP_URL, "utf8");
  const renderLogsSource = source.slice(
    source.indexOf("function renderLogs()"),
    source.indexOf("function captureNpcPublicationNodes()")
  );
  assert.match(renderLogsSource, /const playerNodes = reconcileBrowserPublicationNodes\(/);
  assert.match(renderLogsSource, /let publicationBackedPlayerCount = 0;/);
  assert.match(
    renderLogsSource,
    /if \(Object\.hasOwn\(node\.dataset, "publicationId"\)\) \{\s*publicationBackedPlayerCount \+= 1;\s*appendNpcNodesAfterPlayerCount\(merged, publicationBackedPlayerCount\);/s
  );
  assert.doesNotMatch(
    renderLogsSource,
    /const playerNodes = \[\.\.\.elements\.logList\.querySelectorAll\("\[data-publication-id\]"\)\]/
  );
});

test("BLR-010 legacy text and identity stay UI-only, safe, and authority-neutral", async () => {
  const answer = "<b>BLR-010 $& literal text</b>";
  await withLegacyBrowserApp({
    consumerEnabled: false,
    answers: [answer],
    privateMarker: PRIVATE_DIAGNOSTIC_MARKER
  }, async ({ browser, transport }) => {
    await submitLegacyQuestion(browser, "npc1", "BLR-010 question");
    const expected = `Aoi: ${answer}`;
    const legacyNpcNode = findDirectMessageNode(browser, (value) => value === expected);
    assert.ok(legacyNpcNode);
    assert.equal(messageText(legacyNpcNode), expected);
    assert.equal(legacyNpcNode.children[1].children.length, 0);
    assert.equal(Object.hasOwn(legacyNpcNode.dataset, "publicationId"), false);
    assert.equal(Object.hasOwn(legacyNpcNode.dataset, "npcPublicationId"), false);
    assert.equal(transport.rawPrivateMarker, PRIVATE_DIAGNOSTIC_MARKER);
    browser.elements.devModeToggle.listeners.get("click")();
    const allBrowserText = Object.values(browser.elements).map(nodeText).join("\n");
    assert.equal(allBrowserText.includes(PRIVATE_DIAGNOSTIC_MARKER), false);
  });

  const source = readFileSync(BROWSER_APP_URL, "utf8");
  const renderLogsSource = source.slice(
    source.indexOf("function renderLogs()"),
    source.indexOf("function captureNpcPublicationNodes()")
  );
  assert.doesNotMatch(source, /message\.innerHTML\s*=/);
  assert.doesNotMatch(renderLogsSource, /game\.state|stateVersion|turnOrder|turnId/);
});

async function withLegacyBrowserApp({
  consumerEnabled,
  answers,
  privateMarker = PRIVATE_DIAGNOSTIC_MARKER
}, callback) {
  const browser = createBrowserEnvironment();
  const transport = createLegacyTransport({ consumerEnabled, answers, privateMarker });
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalAlert = globalThis.alert;
  globalThis.document = browser.document;
  globalThis.fetch = transport.fetch;
  globalThis.alert = (message) => {
    throw new Error(`unexpected Browser alert: ${message}`);
  };
  try {
    browserImportOrder += 1;
    await import(`../public/browserApp.mjs?blr-correction-${browserImportOrder}`);
    await settleMicrotasks();
    return await callback({ browser, transport });
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.alert = originalAlert;
  }
}

function createLegacyTransport({ consumerEnabled, answers, privateMarker }) {
  let legacyCalls = 0;
  let candidateCalls = 0;
  const queuedAnswers = [...answers];
  return {
    get legacyCalls() {
      return legacyCalls;
    },
    get candidateCalls() {
      return candidateCalls;
    },
    get rawPrivateMarker() {
      return privateMarker;
    },
    async fetch(url) {
      if (url === "/api/runtime-config") {
        return new Response(JSON.stringify({
          provider: "pseudo",
          interpreterShadowMode: false,
          interpreterValidationMode: true,
          playerConversationCommitMode: true,
          playerStructuredConsumerMode: consumerEnabled,
          npcStructuredReactionMode: false
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url === "/api/generate-npc-reaction-candidate") {
        candidateCalls += 1;
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "content-type": "application/json" }
        });
      }
      if (url === "/api/npc-response") {
        legacyCalls += 1;
        return new Response(JSON.stringify({
          text: queuedAnswers.shift() ?? `legacy answer ${legacyCalls}`,
          providerName: "pseudo",
          model: "test",
          usage: null,
          notes: [],
          privateField: { marker: privateMarker }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`Unexpected BLR Browser URL: ${url}`);
    }
  };
}

async function submitLegacyQuestion(browser, targetId, input) {
  browser.elements.targetSelect.value = targetId;
  browser.elements.questionInput.value = input;
  return browser.elements.askForm.listeners.get("submit")({ preventDefault() {} });
}

function directMessages(browser) {
  return browser.elements.logList.children.map(messageText);
}

function messageText(node) {
  return node.children[1]?.textContent ?? node.textContent;
}

function findDirectMessageNode(browser, predicate) {
  return browser.elements.logList.children.find((node) => predicate(messageText(node)));
}

function relevantMessages(messages, markers) {
  return messages.filter((value) => markers.some((marker) => value.includes(marker)));
}

function assertMarkerOrder(messages, markers) {
  const positions = markers.map((marker) => messages.findIndex((value) => value.includes(marker)));
  assert.equal(positions.every((position) => position >= 0), true, JSON.stringify({ messages, markers }));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
}

function nodeText(node) {
  return [node.textContent, ...node.children.flatMap((child) => nodeText(child))]
    .filter((value) => value !== "")
    .join("\n");
}
