import { test } from "node:test";
import assert from "node:assert/strict";

import { WerewolfGame } from "../src/gameEngine.mjs";
import { buildNpcResponseRequest } from "../src/responseGenerator.mjs";
import { validateNpcResponseRequest } from "../src/validator.mjs";
import { OpenAIResponseProvider } from "../src/openaiProvider.mjs";

// Regression: the web server validates (allowlist-reconstructs) every
// utterance request before the provider sees it. The D-034 voice/address
// fields were not on the allowlist, so they were silently stripped and
// real web play never received the character voices, while tests that
// bypassed the validator stayed green.
test("voice and address materials survive server validation into the provider material", async () => {
  const game = WerewolfGame.create({ scenario: "village9", shuffleRoles: false, seed: 9 });
  const speaker = game.getPlayer("npc9"); // 趙天佑: pinned standard dialect, light register
  const { request } = buildNpcResponseRequest(speaker, game.state, "おはよう");
  assert.match(request.npc.voiceProfile, /方言は標準語/);

  const validated = validateNpcResponseRequest(structuredClone(request));
  assert.equal(validated.npc.voiceProfile, request.npc.voiceProfile);
  assert.equal(validated.npc.callName, request.npc.callName);
  assert.deepEqual(validated.npc.addressForms, request.npc.addressForms);

  let body;
  const provider = new OpenAIResponseProvider({ apiKey: "mock", maxRetries: 0, fallbackToPseudo: false,
    fetch: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "まあまあ、様子を見よう。" }] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    } });
  await provider.generateResponse(validated);
  const material = JSON.parse(body.input[0].content[0].text);
  assert.equal(material.npc.voiceProfile, request.npc.voiceProfile);
  assert.equal(material.npc.callName, request.npc.callName);
  assert.deepEqual(material.npc.addressForms, request.npc.addressForms);
});

test("requests without voice materials still validate, with the fields absent", () => {
  const game = WerewolfGame.create({ seed: 1 });
  const { request } = buildNpcResponseRequest(game.state.players[0], game.state, "こんにちは");
  const legacy = structuredClone(request);
  delete legacy.npc.voiceProfile;
  delete legacy.npc.callName;
  delete legacy.npc.addressForms;
  const validated = validateNpcResponseRequest(legacy);
  assert.equal("voiceProfile" in validated.npc, false);
  assert.equal("callName" in validated.npc, false);
  assert.equal("addressForms" in validated.npc, false);
});

test("null voice materials validate as absent, malformed address forms are rejected", () => {
  const game = WerewolfGame.create({ seed: 1 });
  const { request } = buildNpcResponseRequest(game.state.players[0], game.state, "こんにちは");
  const nulled = structuredClone(request);
  nulled.npc.voiceProfile = null;
  nulled.npc.callName = null;
  nulled.npc.addressForms = null;
  const validated = validateNpcResponseRequest(nulled);
  assert.equal("voiceProfile" in validated.npc, false);
  assert.equal("addressForms" in validated.npc, false);

  const malformed = structuredClone(request);
  malformed.npc.addressForms = { npc1: 42 };
  assert.throws(() => validateNpcResponseRequest(malformed), /addressForms/);
});
