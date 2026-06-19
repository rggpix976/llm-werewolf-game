import { WerewolfGame } from "../src/gameEngine.mjs";
import { auditGameState, formatAudit } from "../src/audit.mjs";

const game = WerewolfGame.create({
  seed: 20260613,
  scenario: "sample",
  shuffleRoles: false
});

let printedLogIndex = 0;

await step("質問1: 人狼本人に正体を聞く", () => {
  return dispatch({
    type: "ask_npc",
    target: "npc3",
    input: "あなたは人狼ですか？ Daichiを疑っている理由も教えて。"
  });
});

await step("質問2: 占い師にChikaへの印象を聞く", () => {
  return dispatch({
    type: "ask_npc",
    target: "npc1",
    input: "Chikaの発言は怪しくない？"
  });
});

await step("1回目の投票と処刑", () => {
  return dispatch({ type: "advance_vote" });
});

const firstExecutedId = game.state.voteHistory.at(-1).executedId;
await step("死亡者への質問ブロック確認", () => {
  return dispatch({
    type: "ask_npc",
    target: firstExecutedId,
    input: "処刑後だけど、まだ話せますか？"
  });
});

await step("夜行動: 占いと襲撃", () => {
  return dispatch({ type: "run_night" });
});

await step("質問3: 占い師にCOを促す", () => {
  return dispatch({
    type: "ask_npc",
    target: "npc1",
    input: "Chikaについて、占いCOも含めてどう思う？"
  });
});

await step("2回目の投票と勝敗判定", () => {
  return dispatch({ type: "advance_vote" });
});

console.log("\n=== Developer Snapshot ===");
console.log(JSON.stringify(game.createDeveloperSnapshot(), null, 2));

console.log("\n=== Developer Log Tail ===");
console.log(game.formatDeveloperLog({ last: 12 }));

console.log("\n=== Audit ===");
console.log(formatAudit(auditGameState(game.state)));

async function step(title, action) {
  console.log(`\n=== ${title} ===`);
  await action();
  printNewPlayerLog();
}

function dispatch(action) {
  return game.dispatchPlayerAction({
    ...action,
    logCursor: printedLogIndex
  });
}

function printNewPlayerLog() {
  const text = game.formatPlayerLog(printedLogIndex);
  if (text) {
    console.log(text);
  }
  printedLogIndex = game.state.playerLog.length;
}
