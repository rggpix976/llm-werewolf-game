import test from "node:test";
import assert from "node:assert/strict";
import { WerewolfGame } from "../src/gameEngine.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";
import { boardDigestFor, contestedClaimGroups } from "../src/boardAssessment.mjs";
import { buildNpcResponseRequest } from "../src/responseGenerator.mjs";

function setup({ role = "medium", scenario = "village9", choice = "execute_first_npc2", options = {} } = {}) {
  const captured = [];
  const provider = new PseudoResponseProvider();
  provider.chooseAction = async (request) => {
    captured.push(request);
    return { choiceId: request.decisionPoint === "board_assessment" ? choice : "reject_persuasion" };
  };
  const game = WerewolfGame.create({ seed: 9, scenario, shuffleRoles: false, responseProvider: provider, ...options });
  game.state.day = 2;
  for (const p of game.state.players) {
    p.strategyLean = "neutral";
    p.suspicionScores = { npc2: 4, npc3: 7 };
  }
  game.getPlayer("npc5").alive = false;
  game.addPublicInfo({ type: "execution", targetId: "npc5", day: 1 });
  for (const [id, result] of [["npc2", "werewolf"], ["npc3", "not_werewolf"]]) {
    game.getPlayer(id).publicClaims.push({ day: 2, actorId: id, role, results: [{ targetId: "npc5", result }] });
  }
  return { game, provider, captured };
}
const ask = (game, targetId = "npc1", input = "今の考えを聞かせて") =>
  game.dispatchPlayerAction({ type: targetId ? "ask_npc" : "ask_all", targetId, input });
const requests = (captured) => captured.filter((r) => r.decisionPoint === "board_assessment");

test("public medium digest counts distinct blacks, executions, and remaining wolves", () => {
  const { game } = setup();
  const group = contestedClaimGroups(game.state)[0];
  assert.deepEqual(group, { role: "medium", claimantIds: ["npc2", "npc3"], conflicts: [
    { targetId: "npc5", resultsByClaimant: { npc2: "werewolf", npc3: "not_werewolf" } }
  ] });
  game.getPlayer("npc2").publicClaims.push(structuredClone(game.getPlayer("npc2").publicClaims[0]));
  game.addPublicInfo({ type: "execution", targetId: "npc9", day: 2 });
  const [black, white] = boardDigestFor(game.state, group).claimants;
  assert.equal(black.bankedBlacks, 1);
  assert.equal(black.wolvesRemainingIfGenuine, 1);
  assert.equal(white.wolvesRemainingIfGenuine, 2);
  assert.equal(black.unpublishedExecutions, 1);
  assert.deepEqual(black.publishedResults[0], { targetId: "npc5", targetName: "春日一番", result: "werewolf", targetStatus: "executed", day: 1 });
  const before = boardDigestFor(game.state, group);
  for (const p of game.state.players) { p.role = "werewolf"; p.knownInfo = []; p.privateMemory = []; }
  assert.deepEqual(boardDigestFor(game.state, group), before);
});

for (const [blackScore, expected] of [[4, "npc2"], [3, "npc2"], [2, "npc3"]]) {
  test(`playtest-22: white 7 versus black ${blackScore} selects ${expected}`, async () => {
    const { game } = setup();
    game.getPlayer("npc1").suspicionScores.npc2 = blackScore;
    await ask(game);
    assert.equal(game.chooseVote(game.getPlayer("npc1")).targetId, expected);
    assert.deepEqual(game.getPlayer("npc1").suspicionScores, { npc2: blackScore, npc3: 7 });
  });
}

test("board reply names the assessed black claimant and declares the same vote", async () => {
  const { game } = setup();
  const { result } = await ask(game);
  assert.equal(result.declaredVoteTargetId, "npc2");
  assert.match(result.text, /真島吾朗は結果を出し終えている。真でも村は保てるので、先に真島吾朗に投票したいです。/);
  const npc = game.getPlayer("npc1");
  assert.match(buildNpcResponseRequest(npc, game.state, "グレーから詰めよう").request.responsePlan.baseText, /グレーから詰める方針/);
  await ask(game, "npc1", "真島吾朗は確白");
  assert.match(buildNpcResponseRequest(npc, game.state, "真島吾朗は確白").request.responsePlan.baseText, /それでも私は真島吾朗/);
});

test("white choice and stale assessment use ordinary replies", async () => {
  const { game } = setup({ choice: "execute_first_npc3" });
  await ask(game);
  assert.ok(!buildNpcResponseRequest(game.getPlayer("npc1"), game.state, "考えは？").request.responsePlan.baseText.includes("結果を出し終えて"));
  game.state.boardAssessments["npc1:medium"].firstChoiceId = "npc2";
  game.state.day++;
  assert.equal(game.chooseVote(game.getPlayer("npc1")).targetId, "npc3");
});

test("broadcast covers all living observers, excludes group members, and caps by day", async () => {
  const { game, captured } = setup();
  await ask(game, null);
  assert.deepEqual(requests(captured).map((r) => r.npc.id), ["npc1", "npc4", "npc6", "npc7", "npc8", "npc9"]);
  await ask(game, null);
  assert.equal(requests(captured).length, 6);
  game.state.day++;
  await ask(game);
  assert.equal(requests(captured).length, 7);
});

test("direct asks assess only the addressee; dead claimant ends the pair", async () => {
  const { game, captured } = setup();
  await ask(game);
  assert.deepEqual(requests(captured).map((r) => r.npc.id), ["npc1"]);
  await ask(game, "npc2");
  assert.equal(requests(captured).length, 1);
  game.getPlayer("npc2").alive = false;
  await ask(game, "npc4");
  assert.deepEqual(contestedClaimGroups(game.state), []);
  assert.equal(requests(captured).length, 1);
  assert.equal(game.chooseVote(game.getPlayer("npc1")).targetId, "npc3");
});

test("structured interpreter ask persists one addressee assessment through working copies", async () => {
  const interpreterProvider = {
    async interpretPlayerInput(request) {
      return {
        schemaVersion: 1, requestId: request.requestId, correlationId: request.correlationId, serverCorrelationId: "server-1",
        result: {
          schemaVersion: 1, requestId: request.requestId, correlationId: request.correlationId,
          modelOutput: { schemaVersion: 1, alternatives: [{ alternativeId: "alternative-1", confidence: 1,
            speechActs: [{ type: "question", targetId: "npc1", topic: "opinion", sourceSpan: { start: 0, end: 5 } }] }] },
          diagnostics: { providerName: "test", model: "test", attemptCount: 1, elapsedMs: 0 }
        }
      };
    }
  };
  const { game, captured } = setup({ options: {
    interpreterValidationEnabled: true, playerConversationCommitEnabled: true, interpreterProvider
  } });
  const { result } = await ask(game, "npc1", "hello");
  assert.ok(result.conversationCommitResult);
  assert.equal(result.declaredVoteTargetId, "npc2");
  assert.deepEqual(requests(captured).map((r) => r.npc.id), ["npc1"]);
  assert.deepEqual(game.state.boardAssessments["npc1:medium"], { day: 2, firstChoiceId: "npc2" });
  await ask(game, "npc1", "hello");
  assert.equal(requests(captured).length, 1);
});

test("board switch follows strategy adjustment and cannot jump from a different group", async () => {
  const { game } = setup();
  const npc = game.getPlayer("npc1");
  npc.strategyLean = "roller";
  npc.suspicionScores = { npc7: 10, npc3: 7, npc2: 4 };
  await ask(game);
  assert.equal(game.chooseVote(game.getPlayer("npc1")).targetId, "npc2");
  game.getPlayer("npc1").strategyLean = "neutral";
  assert.equal(game.chooseVote(game.getPlayer("npc1")).targetId, "npc7");
});

for (const failure of ["provider_error", "invalid_choice", "method_missing"]) {
  test(`${failure} safely stores no preference and continues`, async () => {
    const { game, provider } = setup({ choice: "bad" });
    if (failure === "method_missing") provider.chooseAction = undefined;
    if (failure === "provider_error") provider.chooseAction = async () => { throw new Error("failure"); };
    assert.equal((await ask(game)).result.responded, true);
    assert.deepEqual(game.state.boardAssessments["npc1:medium"], { day: 2, firstChoiceId: null });
    assert.equal(game.chooseVote(game.getPlayer("npc1")).targetId, "npc3");
    const log = game.state.developerLog.find((e) => e.kind === "board_assessment_decision");
    assert.equal(log.detail.choiceId, "no_preference");
    assert.equal(log.detail.fallbackReason, failure);
    assert.equal(log.detail.observerId, "npc1");
  });
}

test("request is deeply frozen, detached, private-safe, and absent from public snapshot", async () => {
  const { game, captured } = setup();
  await ask(game);
  const request = requests(captured)[0];
  assert.ok(Object.isFrozen(request.context.publicEvidence[0].claimants[0].publishedResults[0]));
  assert.deepEqual(Object.keys(request.private).sort(), ["goals", "role"]);
  assert.equal(request.private.role, game.getPlayer("npc1").role);
  assert.deepEqual(request.private.goals, ["人狼陣営を勝利に導く"]);
  assert.deepEqual(request.candidates.map((c) => c.id), ["execute_first_npc2", "execute_first_npc3", "no_preference"]);
  game.getPlayer("npc2").publicClaims[0].results[0].result = "not_werewolf";
  assert.equal(request.context.publicEvidence[0].claimants[0].publishedResults[0].result, "werewolf");
  assert.ok(!JSON.stringify(game.getPublicSnapshot()).includes("boardAssessments"));
  assert.ok(!JSON.stringify(game.getPublicSnapshot()).includes("board_assessment_decision"));
});

test("seer groups work in five-player games with public wolf count one", async () => {
  const { game } = setup({ role: "seer", scenario: "default" });
  const group = contestedClaimGroups(game.state)[0];
  assert.equal(group.role, "seer");
  const digest = boardDigestFor(game.state, group);
  assert.equal(digest.claimants[0].wolvesRemainingIfGenuine, 0);
  assert.equal(digest.claimants[1].wolvesRemainingIfGenuine, 1);
  assert.equal(digest.claimants[0].unpublishedExecutions, undefined);
  await ask(game);
  assert.equal(game.chooseVote(game.getPlayer("npc1")).targetId, "npc2");
});

test("three claimants share one group; agreement, different targets, and knights do not", () => {
  const { game } = setup();
  game.getPlayer("npc4").publicClaims.push({ role: "medium", results: [{ targetId: "npc5", result: "not_werewolf" }] });
  assert.equal(contestedClaimGroups(game.state)[0].claimantIds.length, 3);
  game.getPlayer("npc2").publicClaims[0].results[0].result = "not_werewolf";
  assert.deepEqual(contestedClaimGroups(game.state), []);
  game.getPlayer("npc2").publicClaims[0].results[0] = { targetId: "npc1", result: "werewolf" };
  assert.deepEqual(contestedClaimGroups(game.state), []);
  for (const p of game.state.players) for (const c of p.publicClaims) c.role = "knight";
  assert.deepEqual(contestedClaimGroups(game.state), []);
});

test("digest exposes public alive/night-killed/other status without private death memory", () => {
  const { game } = setup({ role: "seer" });
  game.getPlayer("npc4").alive = false;
  game.getPlayer("npc6").alive = false;
  game.addPublicInfo({ type: "night_death", targetId: "npc4" });
  game.getPlayer("npc2").publicClaims[0].results.push(...["npc1", "npc4", "npc6"].map((targetId) => ({ targetId, result: "not_werewolf" })));
  const digest = boardDigestFor(game.state, contestedClaimGroups(game.state)[0]);
  assert.deepEqual(digest.claimants[0].publishedResults.map((r) => r.targetStatus), ["executed", "alive", "night_killed", "other"]);
});

test("pseudo leaves scores and votes unchanged and records no preference", async () => {
  const { game } = setup();
  game.responseProvider = new PseudoResponseProvider();
  const beforeScores = game.state.players.map((p) => structuredClone(p.suspicionScores));
  const beforeVotes = game.collectVotes();
  await ask(game, null);
  assert.deepEqual(game.state.players.map((p) => p.suspicionScores), beforeScores);
  assert.deepEqual(game.collectVotes(), beforeVotes);
  assert.ok(Object.values(game.state.boardAssessments).every((a) => a.firstChoiceId === null));
});

for (const playerVote of [false, true]) {
  test(`rescue medium conflicts get assessed before re-cast (player vote: ${playerVote})`, async () => {
    const provider = new PseudoResponseProvider();
    const choose = provider.chooseAction.bind(provider);
    const captured = [];
    provider.chooseAction = async (request) => {
      if (request.decisionPoint === "board_assessment") {
        captured.push(request);
        return { choiceId: "execute_first_npc4" };
      }
      return choose(request);
    };
    const game = WerewolfGame.create({ seed: 9, scenario: "village9", shuffleRoles: false, responseProvider: provider });
    game.state.day = 2;
    game.killPlayer("npc9", "execution");
    game.addPublicInfo({ type: "execution", targetId: "npc9", day: 1 });
    game.state.voteHistory.push({ day: 1, executedId: "npc9", votes: [] });
    game.recordMediumResults(game.getPlayer("npc9"));
    for (const p of game.state.players) { p.strategyLean = "neutral"; p.suspicionScores = { npc4: 7 }; }
    const collect = game.collectVotes.bind(game);
    let rounds = 0;
    game.collectVotes = () => {
      rounds++;
      if (rounds > 1) assert.ok(captured.length > 0, "assessment must precede re-cast");
      return collect();
    };
    assert.deepEqual(contestedClaimGroups(game.state), []);
    let result = await game.runVote(playerVote ? "npc4" : undefined);
    if (playerVote) {
      assert.equal(result.revoteRequired, true);
      result = await game.runVote("npc4");
    }
    assert.ok(rounds >= 2);
    assert.ok(captured.length > 0);
    assert.ok(captured.every((r) => !r.context.publicEvidence[0].claimants.some((c) => c.claimantId === r.npc.id)));
    assert.equal(new Set(captured.map((r) => r.npc.id)).size, captured.length);
    assert.ok(result.executedId);
  });
}
