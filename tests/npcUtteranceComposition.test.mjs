import assert from "node:assert/strict";
import test from "node:test";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { OpenAIResponseProvider } from "../src/openaiProvider.mjs";
import { buildNpcResponseRequest } from "../src/responseGenerator.mjs";

const dummyRequest = {
  npc: { id: "npc1", name: "Aoi", personality: "冷静", speechStyle: "calm", conversationPolicy: { truthfulness: "t", roleClaim: "r", allowedTactics: [], forbidden: [] } },
  playerInput: "Beniについてどう思う？",
  context: { day: 1, phase: "day_discussion", publicEvidence: [{ type: "utterance", text: "Beniの発言" }], shareableKnownEvidence: [], privateStanceEvidence: [], publicClaims: [], intent: { asksWerewolfIdentity: false, asksRoleOrClaim: false, asksVoteReason: false }, topSuspect: { id: "npc2", name: "Beni", score: 1 } },
  policyDecision: { publicClaimAllowed: false, publicClaim: null, disclosedHiddenInfo: false },
  responsePlan: { baseText: "Beniは少し気になります。", speechStyle: "calm" },
  evidenceUsed: []
};

const successResponse = {
  id: "resp_utter",
  status: "completed",
  output: [
    {
      id: "msg_utter",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "Beniの様子が少し気になっています。" }]
    }
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
};

test("openai instructions: the model composes from stance and materials instead of rephrasing baseText", async () => {
  let fetchOptions;
  const mockFetch = async (url, options) => {
    fetchOptions = options;
    return {
      ok: true,
      status: 200,
      headers: new Map([["x-request-id", "req_utter"]]),
      json: async () => successResponse
    };
  };
  const provider = new OpenAIResponseProvider({ apiKey: "test-key", fetch: mockFetch });
  const result = await provider.generateResponse(dummyRequest);
  assert.equal(result.text, "Beniの様子が少し気になっています。");

  const body = JSON.parse(fetchOptions.body);
  // The old rephrase-only mandate is gone.
  assert.ok(!body.instructions.includes("絶対的な事実ベース"));
  assert.ok(!body.instructions.includes("書き換えてください"));
  // The stance is still decided by the game side, and grounding rules remain.
  assert.ok(body.instructions.includes("立場"));
  assert.ok(body.instructions.includes("捏造"));
  assert.ok(body.instructions.includes("publicClaimAllowed"));

  // The model still receives the stance and the allowed materials.
  const sent = JSON.parse(body.input[0].content[0].text);
  assert.equal(sent.responsePlan.baseText, "Beniは少し気になります。");
  assert.equal(sent.context.publicEvidence.length, 1);
  assert.equal(sent.context.topSuspect.id, "npc2");
});

function gameWithPublicInfo(entries) {
  const game = WerewolfGame.create({ seed: 1 });
  for (const entry of entries) {
    game.state.publicInfo.push(entry);
  }
  return game;
}

test("public evidence: without a mention, the latest 8 entries are provided", () => {
  const entries = Array.from({ length: 16 }, (_, i) => ({ type: "utterance", text: `発言${i + 1}`, actorId: "player" }));
  const game = gameWithPublicInfo(entries);
  const npc = game.getPlayer("npc1");
  const { request } = buildNpcResponseRequest(npc, game.state, "Hello");
  assert.deepEqual(
    request.context.publicEvidence.map((info) => info.text),
    ["発言9", "発言10", "発言11", "発言12", "発言13", "発言14", "発言15", "発言16"]
  );
});

test("public evidence: mentioned entries are kept and filled with recent context in order", () => {
  const entries = Array.from({ length: 16 }, (_, i) => ({ type: "utterance", text: `発言${i + 1}`, actorId: "player", targetId: "npc3" }));
  entries[2] = { type: "utterance", text: "発言3", actorId: "player", targetId: "npc2" };
  entries[10] = { type: "utterance", text: "発言11", actorId: "player", targetId: "npc2" };
  const game = gameWithPublicInfo(entries);
  const npc = game.getPlayer("npc1");
  const { request } = buildNpcResponseRequest(npc, game.state, "Beniについてどう思いますか");
  assert.deepEqual(
    request.context.publicEvidence.map((info) => info.text),
    ["発言3", "発言11", "発言15", "発言16"]
  );
});
