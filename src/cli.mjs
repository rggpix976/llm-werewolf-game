import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { WerewolfGame } from "./gameEngine.mjs";

const showDev = process.argv.includes("--show-dev");
const game = WerewolfGame.create({
  seed: Date.now(),
  shuffleRoles: true
});

let printedLogIndex = 0;

const rl = readline.createInterface({ input, output });

printIntro();
printNewPlayerLog();

while (true) {
  const line = (await rl.question("\n> ")).trim();
  if (!line) {
    continue;
  }

  const [command, ...rest] = line.split(/\s+/);

  try {
    if (command === "quit" || command === "exit") {
      break;
    }

    if (command === "help") {
      printHelp();
      continue;
    }

    if (command === "state") {
      printPublicState();
      continue;
    }

    if (command === "log") {
      console.log(game.formatPlayerLog());
      continue;
    }

    if (command === "dev") {
      console.log(game.formatDeveloperLog({ last: 8 }));
      continue;
    }

    if (command === "ask") {
      const target = rest.shift();
      const question = rest.join(" ");
      if (!target || !question) {
        console.log("使い方: ask <npcId|name|alias> <質問文>");
        printAliveNpcs();
        continue;
      }

      game.dispatchPlayerAction({
        type: "ask_npc",
        target,
        input: question,
        logCursor: printedLogIndex
      });
      printNewPlayerLog();
      maybePrintDevTail();
      continue;
    }

    if (command === "vote") {
      game.dispatchPlayerAction({
        type: "advance_vote",
        logCursor: printedLogIndex
      });
      printNewPlayerLog();
      maybePrintDevTail();

      if (!game.state.winner) {
        game.dispatchPlayerAction({
          type: "run_night",
          logCursor: printedLogIndex
        });
        printNewPlayerLog();
        maybePrintDevTail();
      }

      if (game.state.winner) {
        console.log("\nゲーム終了です。dev コマンドで開発者ログを確認できます。");
      }
      continue;
    }

    console.log(`未知のコマンドです: ${command}`);
    printHelp();
  } catch (error) {
    console.error(`Error: ${error.message}`);
  }
}

rl.close();

function printIntro() {
  console.log("LLM人狼 最小プロトタイプ");
  printHelp();
}

function printHelp() {
  console.log([
    "",
    "Commands:",
    "  ask <npcId|name|alias> <質問文>  NPCに自由入力で質問する",
    "  vote                         投票、処刑、夜行動、勝敗判定まで進める",
    "  state                        公開状態を見る",
    "  log                          プレイヤー表示用ログを見る",
    "  dev                          開発者用ログの末尾を見る",
    "  help                         ヘルプ",
    "  quit                         終了"
  ].join("\n"));
  printAliveNpcs();
}

function printPublicState() {
  const snapshot = game.dispatchPlayerAction({ type: "get_state" }).publicSnapshot;
  console.log(`Day ${snapshot.day} / phase=${snapshot.phase} / winner=${snapshot.winner ?? "none"}`);
  printAliveNpcs(snapshot);
  const dead = snapshot.players.filter((player) => !player.alive).map((player) => player.name);
  console.log(`Dead: ${dead.length ? dead.join(", ") : "none"}`);
}

function printAliveNpcs(snapshot = game.getPublicSnapshot()) {
  const alive = snapshot.players.filter((player) => player.alive).map((player) => {
    return `${player.id}:${player.name}(${(player.aliases ?? []).slice(0, 2).join("/")})`;
  });
  console.log(`Alive NPCs: ${alive.join(", ")}`);
}

function printNewPlayerLog() {
  const text = game.formatPlayerLog(printedLogIndex);
  if (text) {
    console.log(`\n${text}`);
  }
  printedLogIndex = game.state.playerLog.length;
}

function maybePrintDevTail() {
  if (!showDev) {
    return;
  }
  console.log("\n--- developer log tail ---");
  console.log(game.formatDeveloperLog({ last: 3 }));
}
