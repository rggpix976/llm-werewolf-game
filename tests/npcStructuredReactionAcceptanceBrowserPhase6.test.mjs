import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPrivacySafe,
  browserPublicationOrder,
  settleMicrotasks,
  submitBrowserQuestion,
  withBrowserApp
} from "./helpers/npcStructuredReactionAcceptanceHarness.mjs";

for (const [id, consumerEnabled] of [["ACC-013", false], ["ACC-014", true]]) {
  test(`${id} actual Browser preserves two-question Player-before-NPC order with consumer ${consumerEnabled ? "on" : "off"}`, async () => {
    await withBrowserApp(consumerEnabled, async ({ browser, transport }) => {
      await submitBrowserQuestion(browser, "npc1", "Browser question A?");
      assert.equal(browser.elements.questionInput.value, "");
      assert.deepEqual(browserPublicationOrder(browser), ["player", "npc"]);
      assert.equal(browser.elements.askButton.textContent, "Ask");

      await submitBrowserQuestion(browser, "npc2", "Browser question B?");
      assert.equal(browser.elements.questionInput.value, "");
      assert.deepEqual(browserPublicationOrder(browser), ["player", "npc", "player", "npc"]);
      assert.equal(browser.elements.askButton.textContent, "Ask");
      assert.equal(browser.elements.logList.querySelectorAll("[data-publication-id]").length, 2);
      assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 2);
      assert.equal(transport.candidateCalls, 2);
      assert.match(browser.elements.statusLine.textContent, /Day 1 \/ day discussion/i);
      assertPrivacySafe(nodeText(browser.elements.logList));
    });
  });
}

test("ACC-015 actual Browser duplicate submit is rejected by the busy gate without duplicate effects", async () => {
  await withBrowserApp(true, async ({ browser, transport }) => {
    browser.elements.targetSelect.value = "npc1";
    browser.elements.questionInput.value = "Duplicate submit?";
    const submit = browser.elements.askForm.listeners.get("submit");
    const first = submit({ preventDefault() {} });
    const second = submit({ preventDefault() {} });
    const results = await Promise.allSettled([first, second]);
    assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(results.filter((entry) => entry.status === "rejected").length, 1);
    assert.equal(transport.candidateCalls, 1);
    assert.equal(browser.elements.logList.querySelectorAll("[data-publication-id]").length, 1);
    assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 1);
    assert.deepEqual(browserPublicationOrder(browser), ["player", "npc"]);
    assert.equal(browser.elements.askButton.disabled, false);
  });
});

test("ACC-016 actual Browser New Game removes old nodes and permits a fresh isolated question", async () => {
  await withBrowserApp(true, async ({ browser, transport }) => {
    await submitBrowserQuestion(browser, "npc1", "Old session A?");
    await submitBrowserQuestion(browser, "npc2", "Old session B?");
    const oldPlayerIds = browser.elements.logList.querySelectorAll("[data-publication-id]").map((node) => node.dataset.publicationId);
    const oldNpcIds = browser.elements.logList.querySelectorAll("[data-npc-publication-id]").map((node) => node.dataset.npcPublicationId);
    assert.equal(oldPlayerIds.length, 2);
    assert.equal(oldNpcIds.length, 2);

    browser.elements.newGameButton.listeners.get("click")();
    await settleMicrotasks();
    assert.equal(browser.elements.logList.querySelectorAll("[data-publication-id]").length, 0);
    assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 0);
    assert.equal(browser.elements.askButton.textContent, "Ask");

    await submitBrowserQuestion(browser, "npc1", "Fresh session?" );
    const newPlayerIds = browser.elements.logList.querySelectorAll("[data-publication-id]").map((node) => node.dataset.publicationId);
    const newNpcIds = browser.elements.logList.querySelectorAll("[data-npc-publication-id]").map((node) => node.dataset.npcPublicationId);
    assert.equal(newPlayerIds.length, 1);
    assert.equal(newNpcIds.length, 1);
    assert.equal(oldPlayerIds.includes(newPlayerIds[0]), false);
    assert.equal(oldNpcIds.includes(newNpcIds[0]), false);
    assert.equal(transport.candidateCalls, 3);
    assert.deepEqual(browserPublicationOrder(browser), ["player", "npc"]);
  });
});

test("ACC-017 actual Browser keeps normal output clean and exposes only redacted structured observations", async () => {
  await withBrowserApp(true, async ({ browser }) => {
    await submitBrowserQuestion(browser, "npc1", "Observation question?" );
    assert.equal(browser.elements.developerPanel.children.length, 0);
    assert.equal(nodeText(browser.elements.logList).includes("NPC Structured Observations"), false);
    assertPrivacySafe(nodeText(browser.elements.logList));

    browser.elements.devModeToggle.listeners.get("click")();
    assert.equal(browser.elements.developerPanel.hidden, false);
    const observationTitle = findNode(browser.elements.developerPanel, (node) => node.textContent === "5. NPC Structured Observations");
    assert.ok(observationTitle);
    const observationSection = observationTitle.parentNode;
    const observationText = nodeText(observationSection);
    assert.match(observationText, /NPC Structured Observations/);
    assert.match(observationText, /(route|delivery|status=)/i);
    assertPrivacySafe(observationText);
    for (const forbidden of ["knownInformation", "ownRole", "ownTeam", "raw prompt", "retryToken", "receiptId"]) {
      assert.equal(observationText.includes(forbidden), false);
    }
  });
});

function nodeText(node) {
  return [node.textContent, ...node.children.flatMap((child) => nodeText(child))]
    .filter((value) => value !== "")
    .join("\n");
}

function findNode(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}
