import assert from "node:assert/strict";
import test from "node:test";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { createPhase3Binding, validatePhase3Response } from "../src/interpreterValidation.mjs";
import { PseudoInterpreterProvider } from "../src/interpreterTransport.mjs";

function ids() { let value = 0; return () => String(++value); }
function game(options = {}) {
  return WerewolfGame.create({
    seed: 1,
    scenario: "sample",
    shuffleRoles: false,
    createId: ids(),
    responseProvider: { generateResponse: async () => ({ text: "same response", providerName: "test", model: "test", usage: null, notes: [] }) },
    ...options
  });
}
async function interpret(instance, rawText, { targetNpcId = "npc1" } = {}) {
  const binding = createPhase3Binding({ state: instance.state, rawText, targetNpcId, createId: ids() });
  const result = await new PseudoInterpreterProvider({ now: () => 0 }).interpretPlayerInput(binding.request, { targetNpcId });
  return { binding, result, act: result.modelOutput.alternatives[0].speechActs[0] };
}
function envelope(binding, result) {
  return { schemaVersion: 1, requestId: binding.requestId, correlationId: binding.correlationId, serverCorrelationId: "server-1", result };
}

test("pseudo interpreter: explicit vote declaration resolves the named roster member", async () => {
  const { act } = await interpret(game(), "Aoiに投票する");
  assert.equal(act.type, "vote_declaration");
  assert.equal(act.targetId, "npc1");
  assert.deepEqual(act.sourceSpan, { start: 0, end: 8 });
});

test("pseudo interpreter: polite and he-variants of the vote declaration also resolve", async () => {
  const polite = await interpret(game(), "私はAoiに投票します");
  assert.equal(polite.act.type, "vote_declaration");
  assert.equal(polite.act.targetId, "npc1");
  assert.deepEqual(polite.act.sourceSpan, { start: 2, end: 11 });

  const heVariant = await interpret(game(), "Beniへ投票する");
  assert.equal(heVariant.act.type, "vote_declaration");
  assert.equal(heVariant.act.targetId, "npc2");
});

test("pseudo interpreter: vote declaration wins over the selected-NPC question fallback", async () => {
  const { act } = await interpret(game(), "Chikaに投票する", { targetNpcId: "npc1" });
  assert.equal(act.type, "vote_declaration");
  assert.equal(act.targetId, "npc3");
});

test("pseudo interpreter: ordinary input keeps the previous fallback behavior", async () => {
  const question = await interpret(game(), "Aoiは人狼ですか", { targetNpcId: "npc1" });
  assert.equal(question.act.type, "question");
  assert.equal(question.act.targetId, "npc1");
  assert.equal(question.act.topic, "opinion");
  assert.deepEqual(question.act.sourceSpan, { start: 0, end: [..."Aoiは人狼ですか"].length });

  const noTarget = await interpret(game(), "こんにちは", { targetNpcId: "missing" });
  assert.equal(noTarget.act.type, "non_game_statement");
});

test("pseudo interpreter: deliberation about voting is not a declaration", async () => {
  const { act } = await interpret(game(), "Aoiに投票するかどうか迷っている", { targetNpcId: "npc1" });
  assert.equal(act.type, "question");
  assert.equal(act.targetId, "npc1");

  // Suspecting the person who votes for Aoi is not itself a vote for Aoi:
  // the phrase does not close the sentence.
  const attributive = await interpret(game(), "私はAoiに投票する人を疑う", { targetNpcId: "npc2" });
  assert.equal(attributive.act.type, "question");
  assert.equal(attributive.act.targetId, "npc2");

  // A negated intention is not a declaration either.
  const negated = await interpret(game(), "Aoiに投票するつもりはない", { targetNpcId: "npc1" });
  assert.equal(negated.act.type, "question");
  assert.equal(negated.act.targetId, "npc1");

  const withParticle = await interpret(game(), "Aoiに投票するよ", { targetNpcId: "npc2" });
  assert.equal(withParticle.act.type, "vote_declaration");
  assert.equal(withParticle.act.targetId, "npc1");
});

test("pseudo interpreter: two named members are ambiguous and fall back", async () => {
  const { act } = await interpret(game(), "Aoiに投票する。Beniに投票する", { targetNpcId: "npc1" });
  assert.equal(act.type, "question");
  assert.equal(act.targetId, "npc1");
});

test("pseudo interpreter: a dead target is not declared and falls back", async () => {
  const instance = game();
  instance.state.players.find((player) => player.id === "npc1").alive = false;
  const { act } = await interpret(instance, "Aoiに投票する", { targetNpcId: "npc2" });
  assert.equal(act.type, "question");
  assert.equal(act.targetId, "npc2");
});

test("pseudo interpreter: naming the player is not a vote declaration", async () => {
  const { act } = await interpret(game(), "Playerに投票する", { targetNpcId: "npc1" });
  assert.equal(act.type, "question");
  assert.equal(act.targetId, "npc1");
});

test("pseudo interpreter: vote declaration validates end to end in the vote phase only", async () => {
  const voteGame = game();
  voteGame.state.phase = "vote";
  const { binding, result } = await interpret(voteGame, "Aoiに投票する");
  const validated = validatePhase3Response(envelope(binding, result), binding, voteGame.state);
  assert.equal(validated.category, "validated");
  assert.equal(validated.reasonCode, "candidate_valid");
  assert.equal(validated.selectedAlternative.speechActs[0].type, "vote_declaration");

  const discussionGame = game();
  const discussion = await interpret(discussionGame, "Aoiに投票する");
  const rejected = validatePhase3Response(envelope(discussion.binding, discussion.result), discussion.binding, discussionGame.state);
  assert.equal(rejected.category, "rejected");
  assert.equal(rejected.reasonCode, "candidate_not_allowed");
});
