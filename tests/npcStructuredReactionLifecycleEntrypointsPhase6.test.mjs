import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.mjs";
import {
  createBrowserEnvironment,
  createBrowserTransportHarness,
  createLifecycleGame
} from "./helpers/npcStructuredReactionLifecycleCorrectionHarness.mjs";

test("RC-005 actual Browser accepts two structured questions with consumer off and on", async () => {
  for (const playerStructuredConsumerEnabled of [false, true]) {
    const browser = createBrowserEnvironment();
    const transport = createBrowserTransportHarness(playerStructuredConsumerEnabled);
    const originalDocument = globalThis.document;
    const originalFetch = globalThis.fetch;
    const originalAlert = globalThis.alert;
    globalThis.document = browser.document;
    globalThis.fetch = transport.fetch;
    globalThis.alert = (message) => { throw new Error(`unexpected Browser alert: ${message}`); };
    try {
      await import(`../public/browserApp.mjs?phase-lifecycle-${playerStructuredConsumerEnabled}-${Date.now()}`);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      for (const question of ["Who do you suspect first?", "Who do you suspect next?"]) {
        browser.elements.targetSelect.value = "npc1";
        browser.elements.questionInput.value = question;
        await browser.elements.askForm.listeners.get("submit")({ preventDefault() {} });
      }
      assert.equal(transport.candidateCalls, 2);
      assert.equal(browser.elements.logList.querySelectorAll("[data-npc-publication-id]").length, 2);
      assert.equal(browser.elements.logList.querySelectorAll("[data-publication-id]").length, 2);
    } finally {
      globalThis.document = originalDocument;
      globalThis.fetch = originalFetch;
      globalThis.alert = originalAlert;
    }
  }
});

test("RC-005 actual CLI preserves Player-before-NPC order for two questions with consumer off and on", async () => {
  for (const playerStructuredConsumerEnabled of [false, true]) {
    const order = [];
    const counters = { candidate: 0, legacy: 0 };
    const { game } = createLifecycleGame({
      counters,
      playerStructuredConsumerEnabled,
      npcWrite: async () => { order.push("npc"); }
    });
    const commands = [
      "ask npc1 Who do you suspect first?",
      "ask npc1 Who do you suspect next?",
      "quit"
    ];
    const errors = [];
    await runCli({
      game,
      runtimeConfig: { playerStructuredConsumerMode: playerStructuredConsumerEnabled },
      readlineInterface: {
        async question() { return commands.shift() ?? "quit"; },
        close() {}
      },
      writeLine: () => {},
      writeError: (line) => errors.push(String(line)),
      writePublicationText: async (text) => {
        if (text.includes("Who do you suspect")) order.push("player");
      },
      destroyOnExit: false
    });
    assert.deepEqual(order, ["player", "npc", "player", "npc"]);
    assert.deepEqual(errors, []);
    assert.equal(counters.candidate, 2);
    assert.equal(counters.legacy, 0);
    assert.equal(game.state.phase, "day_discussion");
    assert.equal(game.state.conversation.reactionPlans.length, 2);
    game.destroy();
  }
});
