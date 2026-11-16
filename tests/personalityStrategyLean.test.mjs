import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { buildNpcResponseRequest } from "../src/responseGenerator.mjs";
import { chooseTopSuspect, strategyLeanFor, strategyProposalFor } from "../src/personalityStrategy.mjs";

function setup(style = "direct", coScore = 8, grayScore = 4, scenario = "village9") {
  const game = WerewolfGame.create({ seed: 9, scenario, shuffleRoles: false });
  const npc = game.getPlayer("npc1");
  npc.speechStyle = style;
  npc.suspicionScores = Object.fromEntries(game.state.players.map((p) => [p.id, -20]));
  npc.suspicionScores.npc2 = coScore;
  npc.suspicionScores.npc3 = grayScore;
  game.getPlayer("npc2").publicClaims.push({ role: "knight", results: [] });
  return { game, npc };
}

function request(game, npc, input) {
  return buildNpcResponseRequest(npc, game.state, input).request;
}

test("all speech styles map to a role-independent lean", () => {
  for (const [speechStyle, expected] of Object.entries({ cautious: "roller", logical: "roller", direct: "gray", calm: "neutral", soft: "neutral" })) {
    for (const role of ["werewolf", "madman", "citizen", "seer"]) {
      assert.equal(strategyLeanFor({ speechStyle, role }), expected);
    }
  }
});

test("gray switches at four points, but not five; scores stay unchanged", () => {
  for (const [score, expected] of [[4, "npc3"], [3, "npc2"]]) {
    const { game, npc } = setup("direct", 8, score);
    const before = structuredClone(npc.suspicionScores);
    assert.equal(game.chooseVote(npc).targetId, expected);
    assert.deepEqual(npc.suspicionScores, before);
  }
});

test("roller switches in the opposite direction; neutral never switches", () => {
  for (const style of ["cautious", "logical", "calm", "soft"]) {
    for (const [co, gray] of [[4, 8], [8, 4], [3, 8]]) {
      const { game, npc } = setup(style, co, gray);
      const expected = co > gray || (strategyLeanFor(npc) === "roller" && gray - co <= 4) ? "npc2" : "npc3";
      assert.equal(game.chooseVote(npc).targetId, expected);
    }
  }
});

test("public seer and medium blacks are not gray, including dead claimants' results", () => {
  for (const role of ["seer", "medium"]) {
    const { game, npc } = setup();
    const source = game.getPlayer("npc4");
    source.publicClaims.push({ role, results: [{ targetId: "npc3", result: "werewolf" }] });
    source.alive = false;
    assert.equal(game.chooseVote(npc).targetId, "npc2");
    npc.speechStyle = "logical";
    npc.suspicionScores.npc3 = 10;
    assert.equal(game.chooseVote(npc).targetId, "npc3");
  }
});

test("self and dead candidates are excluded; absent opposite side does not switch", () => {
  const { game, npc } = setup();
  npc.suspicionScores.npc1 = 100;
  game.getPlayer("npc3").alive = false;
  assert.equal(game.chooseVote(npc).targetId, "npc2");
  game.getPlayer("npc2").publicClaims = [];
  npc.speechStyle = "logical";
  assert.equal(game.chooseVote(npc).targetId, "npc2");
});

test("ties retain name ordering for both raw and preferred candidates", () => {
  const { game, npc } = setup("direct", 8, 8);
  npc.suspicionScores.npc4 = 8;
  assert.equal(chooseTopSuspect(npc, game.state).id, "npc3");
  npc.speechStyle = "calm";
  assert.equal(chooseTopSuspect(npc, game.state).id, "npc2");
});

test("ordinary and strategy answers share the adjusted vote target", async () => {
  const { game, npc } = setup();
  for (const input of ["Beniをどう思う？", "グレーを詰めたい"]) {
    const response = await game.dispatchPlayerAction({ type: "ask_npc", target: npc.id, input });
    const vote = game.chooseVote(npc);
    assert.equal(vote.targetId, "npc3");
    assert.ok(response.result.text.includes(vote.targetName));
    assert.equal(request(game, npc, input).context.topSuspect.id, vote.targetId);
  }
});

test("both strategy proposals split gray and roller opinions and always name a target", () => {
  for (const [style, agreesGray] of [["direct", true], ["logical", false]]) {
    const { game, npc } = setup(style, 8, 8);
    for (const [input, agrees] of [["グレーを詰めたい", agreesGray], ["ローラーしよう", !agreesGray]]) {
      const base = request(game, npc, input).responsePlan.baseText;
      assert.ok(base.includes(agrees ? "賛成" : "反対"));
      assert.ok(base.includes(game.chooseVote(npc).targetName));
    }
  }
});

test("neutral and opposing leans agree when their adjusted target is on the proposal side", () => {
  for (const style of ["logical", "calm", "soft"]) {
    const { game, npc } = setup(style, 1, 8);
    assert.match(request(game, npc, "グレーを詰めたい").responsePlan.baseText, /賛成/);
  }
  const { game, npc } = setup("direct", 8, 1);
  assert.match(request(game, npc, "ローラーしよう").responsePlan.baseText, /賛成/);
});

test("strategy vocabulary is explicit and ambiguous or contextless input falls through", () => {
  for (const input of ["グレー", "グレーを詰める", "グレーを詰めたい", "CO者はほっとく", "占い師は放置"]) assert.equal(strategyProposalFor(input), "gray");
  for (const input of ["ローラー", "両方吊る", "両方を吊る", "CO者から吊る"]) assert.equal(strategyProposalFor(input), "roller");
  const { game, npc } = setup();
  for (const input of ["詰めたい", "放置", "ほっとく", "グレーかローラーか", "こんにちは"]) {
    assert.equal(strategyProposalFor(input), null);
    assert.doesNotMatch(request(game, npc, input).responsePlan.baseText, /方針には/);
  }
});

test("ask_all uses strategy replies too", async () => {
  const { game } = setup();
  await game.dispatchPlayerAction({ type: "ask_all", input: "グレーを詰めたい" });
  for (const npc of game.getAlivePlayers()) {
    const line = game.state.playerLog.find((entry) => entry.message.startsWith(`${npc.name}: `));
    assert.match(line.message, /方針には/);
    assert.ok(line.message.includes(game.chooseVote(npc).targetName));
  }
});

test("fresh CO publication and existing claim maintenance override strategy replies", () => {
  const { game } = setup();
  const seer = game.getPlayer("npc3");
  seer.knownInfo.push({ type: "seer_result", day: 1, targetId: "npc7", result: "not_werewolf", shareable: false });
  const fresh = request(game, seer, "占い師COして、グレーを詰めたい");
  assert.equal(fresh.policyDecision.publicClaimAllowed, true);
  assert.doesNotMatch(fresh.responsePlan.baseText, /方針には/);
  seer.publicClaims.push(fresh.policyDecision.publicClaim);
  const restated = request(game, seer, "結果を教えて、グレーを詰めたい");
  assert.equal(restated.policyDecision.publicClaimAllowed, false);
  assert.doesNotMatch(restated.responsePlan.baseText, /方針には/);
});

test("default five-player game keeps ranking and ordinary replies", () => {
  for (const style of ["direct", "logical"]) {
    const { game, npc } = setup(style, 8, 4, "default");
    assert.equal(game.chooseVote(npc).targetId, "npc2");
    assert.doesNotMatch(request(game, npc, "グレーを詰めたい").responsePlan.baseText, /方針には/);
  }
});
