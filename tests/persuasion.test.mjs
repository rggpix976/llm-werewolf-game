import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";
import { assertionFor, persuasionShiftFor } from "../src/persuasion.mjs";
import { buildNpcResponseRequest } from "../src/responseGenerator.mjs";

function setup(choose = () => "reject_persuasion", scenario = "village9") {
  const captured = [];
  const provider = new PseudoResponseProvider();
  provider.chooseAction = async (request) => {
    captured.push(request);
    return { choiceId: choose(request) };
  };
  const game = WerewolfGame.create({ seed: 9, scenario, shuffleRoles: false, responseProvider: provider });
  for (const npc of game.state.players) {
    npc.strategyLean = "neutral";
    npc.suspicionScores = { npc2: 5, npc3: 5 };
  }
  return { game, captured, provider };
}
const ask = (game, input = "Beniは確白だろ", targetId) =>
  game.dispatchPlayerAction({ type: targetId ? "ask_npc" : "ask_all", targetId, input });
const playerRequests = (captured) => captured.filter((r) => r.context.publicEvidence[0].sourceKind === "player");
const score = (game, id = "npc1") => game.getPlayer(id).suspicionScores.npc2;

test("broadcast acceptance flips a tied top and persists across working-copy dispatch", async () => {
  const { game, captured } = setup((r) => r.npc.id === "npc1" && r.context.publicEvidence[0].sourceKind === "player" ? "accept_persuasion" : "reject_persuasion");
  assert.equal(game.chooseVote(game.getPlayer("npc1")).targetId, "npc2");
  const { result } = await ask(game);
  assert.equal(score(game), 3);
  assert.equal(score(game, "npc4"), 5);
  assert.equal(game.chooseVote(game.getPlayer("npc1")).targetId, "npc3");
  assert.match(result.responses[0].text, /Beniが白いというのは確かにそう思います。今日はChikaに投票したいです。/);
  assert.equal(result.responses[0].declaredVoteTargetId, null);
  assert.equal(game.state.lastPersuasion.results.npc1.accepted, true);
  assert.equal(playerRequests(captured).length, 8);
});

test("rejection keeps scores and produces the holdout acknowledgment", async () => {
  const { game } = setup();
  const { result } = await ask(game, undefined, "npc1");
  assert.equal(score(game), 5);
  assert.match(result.text, /それでも私はBeniが気になります。今日はBeniに投票したいです。/);
});

test("accepted white deep top produces softened holdout", async () => {
  const { game } = setup(() => "accept_persuasion");
  game.getPlayer("npc1").suspicionScores.npc2 = 10;
  const { result } = await ask(game, undefined, "npc1");
  assert.equal(score(game), 8);
  assert.match(result.text, /白いという話は分かりましたが、それでも私はBeni/);
});

test("accepted black shifts by two and agrees with the top target", async () => {
  const { game } = setup(() => "accept_persuasion");
  const { result } = await ask(game, "Beniは確黒", "npc1");
  // Existing question pressure adds one for 黒 before persuasion adds two.
  assert.equal(score(game), 8);
  assert.equal(game.state.developerLog.find((e) => e.kind === "persuasion_applied").detail.shift, 2);
  assert.match(result.text, /Beniは確かに怪しいです。今日はBeniに投票したいです。/);
});

for (const input of ["Beniは白いけど黒い", "Beniのことを教えて", "BeniとChikaは確白"]) {
  test(`ambiguous or absent assertion offers no player decision: ${input}`, async () => {
    const { game, captured } = setup();
    await ask(game, input, "npc1");
    assert.equal(captured.length, 0);
    // Mixed black wording still receives the unchanged question pressure.
    assert.equal(score(game), input.includes("黒") ? 6 : 5);
  });
}

for (const choice of ["accept_persuasion", "reject_persuasion"]) {
  test(`same-day cap includes ${choice} and resets next day`, async () => {
    const { game, captured } = setup(() => choice);
    await ask(game, undefined, "npc1");
    const first = score(game);
    await ask(game, undefined, "npc1");
    assert.equal(captured.length, 1);
    assert.equal(score(game), first);
    game.state.day += 1;
    await ask(game, undefined, "npc1");
    assert.equal(captured.length, 2);
  });
}

test("direct ask only offers to addressee; self and dead listeners are excluded", async () => {
  const { game, captured } = setup();
  await ask(game, undefined, "npc1");
  await ask(game, undefined, "npc2");
  game.getPlayer("npc4").alive = false;
  await ask(game, undefined, "npc4");
  assert.deepEqual(captured.map((r) => r.npc.id), ["npc1"]);
});

for (const failure of ["provider_error", "invalid_choice", "method_missing"]) {
  test(`safe rejection on ${failure}`, async () => {
    const { game, provider } = setup(() => {
      if (failure === "provider_error") throw new Error("failure");
      return "not_offered";
    });
    if (failure === "method_missing") provider.chooseAction = undefined;
    const { result } = await ask(game, undefined, "npc1");
    assert.equal(result.responded, true);
    assert.equal(score(game), 5);
    const log = game.state.developerLog.find((e) => e.kind === "persuasion_decision");
    assert.equal(log.detail.fallbackReason, failure);
    assert.equal(log.detail.choiceId, "reject_persuasion");
  });
}

test("wave uses engine declaration, four-point boundary, daily dedup, and no cascading", async () => {
  const { game, captured, provider } = setup(() => "accept_persuasion");
  for (const npc of game.state.players) npc.suspicionScores = {};
  game.getPlayer("npc1").suspicionScores = { npc2: 5 };
  game.getPlayer("npc3").suspicionScores = { npc4: 0, npc2: -4 };
  game.getPlayer("npc5").suspicionScores = { npc4: 0, npc2: -5 };
  // Composed wording cannot add a declaration or change the engine's target.
  provider.generateResponse = async () => ({ text: "今日はHanaに投票します。" });
  const { result } = await ask(game, "今の考えを聞かせて");
  assert.equal(result.responses[0].declaredVoteTargetId, "npc2");
  assert.equal(score(game, "npc3"), -3);
  assert.equal(score(game, "npc5"), -5);
  assert.ok(captured.some((r) => r.npc.id === "npc3"));
  assert.ok(!captured.some((r) => r.npc.id === "npc5"));
  assert.ok(captured.every((r) => r.context.publicEvidence[0].targetId === "npc2"));
  const count = captured.length;
  await ask(game, "今の考えを聞かせて");
  assert.equal(captured.length, count);
});

test("acknowledgments never create wave declarations", async () => {
  const { game, captured } = setup(() => "accept_persuasion");
  game.getPlayer("npc2").suspicionScores = {};
  const { result } = await ask(game);
  assert.ok(result.responses.every((r) => r.declaredVoteTargetId === null));
  assert.ok(captured.every((r) => r.context.publicEvidence[0].sourceKind === "player"));
});

test("pseudo rejects both channels without changing scores", async () => {
  const { game } = setup();
  game.responseProvider = new PseudoResponseProvider();
  const before = game.state.players.map((p) => structuredClone(p.suspicionScores));
  await ask(game);
  assert.deepEqual(game.state.players.map((p) => p.suspicionScores), before);
  assert.ok(game.state.developerLog.filter((e) => e.kind === "persuasion_decision").every((e) => e.detail.choiceId === "reject_persuasion"));
});

test("request is frozen and limited to public assertion plus listener's role/goals", async () => {
  const { game, captured } = setup();
  await ask(game, undefined, "npc1");
  const request = captured[0];
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.context.publicEvidence[0]));
  assert.deepEqual(Object.keys(request.private).sort(), ["goals", "role"]);
  assert.equal(request.private.role, game.getPlayer("npc1").role);
  assert.deepEqual(request.context.publicEvidence[0], {
    targetId: "npc2", direction: "white", text: "Beniは確白だろ",
    sourceKind: "player", sourceId: "player", sourceName: "あなた", targetName: "Beni"
  });
  const snapshot = game.getPublicSnapshot();
  assert.equal(snapshot.lastPersuasion, undefined);
  assert.equal(snapshot.persuasionDecisions, undefined);
  assert.ok(!JSON.stringify(snapshot).includes("wasTopBefore"));
});

test("stale exchange and non-top targets fall through to ordinary replies", async () => {
  const { game } = setup(() => "accept_persuasion");
  game.getPlayer("npc1").suspicionScores.npc3 = 10;
  const { result } = await ask(game, undefined, "npc1");
  assert.ok(!result.text.includes("確かにそう思います"));
  await ask(game, "今の考えを聞かせて", "npc1");
  const npc = game.getPlayer("npc1");
  const ordinary = buildNpcResponseRequest(npc, game.state, "Chikaは確白");
  assert.ok(!ordinary.request.responsePlan.baseText.includes("白いという"));
  game.state.day += 1;
  assert.ok(!buildNpcResponseRequest(npc, game.state, "Beniは確白").request.responsePlan.baseText.includes("白いという"));
});

test("five-player default supports persuasion", async () => {
  const { game } = setup(() => "accept_persuasion", "default");
  await ask(game, undefined, "npc1");
  assert.equal(score(game), 3);
});

test("assertion vocabulary and centralized magnitudes", () => {
  const { game } = setup();
  for (const word of ["確白", "白い", "白っぽい", "吊るな", "吊らない", "信じて", "味方", "村人だ", "無実"]) {
    assert.deepEqual(assertionFor(`Beniは${word}`, game.state.players), { targetId: "npc2", direction: "white" });
  }
  for (const word of ["確黒", "破綻", "吊ろう", "吊るべき", "黒い"]) assert.equal(assertionFor(`Beniは${word}`, game.state.players).direction, "black");
  assert.equal(persuasionShiftFor("white", "player"), -2);
  assert.equal(persuasionShiftFor("black", "player"), 2);
  assert.equal(persuasionShiftFor("black", "npc"), 1);
});

test("claim maintenance and strategy replies take priority over acknowledgments", async () => {
  const { game } = setup(() => "accept_persuasion");
  const npc = game.getPlayer("npc1");
  npc.publicClaims.push({ day: 1, actorId: npc.id, role: "seer", results: [] });
  const { result } = await ask(game, "Beniは確白、COある？", "npc1");
  assert.match(result.text, /占い師COします/);
  assert.equal(result.declaredVoteTargetId, null);
  const strategy = await ask(game, "Beniは確白、グレーから詰めよう", "npc4");
  assert.match(strategy.result.text, /グレーから詰める方針/);
  assert.equal(strategy.result.declaredVoteTargetId, "npc3");
});

test("wasTopBefore uses the lean-adjusted target, not the highest raw score", async () => {
  const { game } = setup(() => "accept_persuasion");
  const npc = game.getPlayer("npc1");
  npc.strategyLean = "roller";
  npc.suspicionScores = { npc2: 3, npc3: 5 };
  game.getPlayer("npc2").publicClaims.push({ role: "seer", results: [] });
  const { result } = await ask(game, undefined, "npc1");
  assert.equal(game.state.lastPersuasion.results.npc1.wasTopBefore, true);
  assert.equal(game.chooseVote(game.getPlayer("npc1")).targetId, "npc2");
  assert.match(result.text, /白いという話は分かりましたが/);
});

test("D-026 declarations name the appended top, while past votes are not declarations", () => {
  const { game } = setup();
  const npc = game.getPlayer("npc1");
  const reply = buildNpcResponseRequest(npc, game.state, "Daichiのことを教えて");
  assert.equal(reply.declaredVoteTargetId, "npc2");
  assert.match(reply.request.responsePlan.baseText, /Beni/);
  npc.voteHistory.push({ targetId: "npc3" });
  assert.equal(buildNpcResponseRequest(npc, game.state, "投票理由は？").declaredVoteTargetId, null);
});

test("wave rejection is capped and duplicate declarers do not multiply offers", async () => {
  const { game, captured } = setup();
  for (const npc of game.state.players) npc.suspicionScores = {};
  game.getPlayer("npc1").suspicionScores = { npc2: 5 };
  game.getPlayer("npc4").suspicionScores = { npc2: 5 };
  game.getPlayer("npc3").suspicionScores = { npc5: 0, npc2: -4 };
  await ask(game, "今の考えを聞かせて");
  assert.equal(captured.filter((r) => r.npc.id === "npc3").length, 1);
  assert.equal(score(game, "npc3"), -4);
  const count = captured.length;
  await ask(game, "今の考えを聞かせて");
  assert.equal(captured.length, count);
});
