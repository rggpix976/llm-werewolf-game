import { WerewolfGame } from "../src/gameEngine.mjs";
import { auditGameState, formatAudit } from "../src/audit.mjs";

const game = WerewolfGame.create({
  seed: 20260613,
  scenario: "sample",
  shuffleRoles: false
});

let printedLogIndex = 0;

step("質問1: 人狼本人に正体を聞く", () => {
  game.handlePlayerQuestion("npc3", "あなたは人狼ですか？ Daichiを疑っている理由も教えて。");
});

step("質問2: 占い師にChikaへの印象を聞く", () => {
  game.handlePlayerQuestion("npc1", "Chikaの発言は怪しくない？");
});

step("1回目の投票と処刑", () => {
  game.runVote();
});

const firstExecutedId = game.state.voteHistory.at(-1).executedId;
step("死亡者への質問ブロック確認", () => {
  game.handlePlayerQuestion(firstExecutedId, "処刑後だけど、まだ話せますか？");
});

step("夜行動: 占いと襲撃", () => {
  game.runNight();
});

step("質問3: 占い師にCOを促す", () => {
  game.handlePlayerQuestion("npc1", "Chikaについて、占いCOも含めてどう思う？");
});

step("2回目の投票と勝敗判定", () => {
  game.runVote();
});

console.log("\n=== Developer Snapshot ===");
console.log(JSON.stringify(game.createDeveloperSnapshot(), null, 2));

console.log("\n=== Developer Log Tail ===");
console.log(game.formatDeveloperLog({ last: 12 }));

console.log("\n=== Audit ===");
console.log(formatAudit(auditGameState(game.state)));

function step(title, action) {
  console.log(`\n=== ${title} ===`);
  action();
  printNewPlayerLog();
}

function printNewPlayerLog() {
  const text = game.formatPlayerLog(printedLogIndex);
  if (text) {
    console.log(text);
  }
  printedLogIndex = game.state.playerLog.length;
}
