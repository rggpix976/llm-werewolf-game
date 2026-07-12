import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { WerewolfGame } from "./gameEngine.mjs";
import { parseConfig } from "./config.mjs";
import { PseudoInterpreterProvider } from "./interpreterTransport.mjs";
import { sanitizeTerminalText } from "./playerStructuredConsumer.mjs";
import { deliverProjectedEntries, retryPlayerPublicationAcknowledgement, writeCliPublication } from "./playerDisplaySink.mjs";

const showDev = process.argv.includes("--show-dev");
const runtimeConfig = parseConfig(process.env);
const game = WerewolfGame.create({
  seed: Date.now(),
  shuffleRoles: true,
  interpreterProvider: new PseudoInterpreterProvider(),
  interpreterValidationEnabled: runtimeConfig.interpreterValidationMode,
  playerConversationCommitEnabled: runtimeConfig.playerConversationCommitMode,
  playerStructuredConsumerEnabled: runtimeConfig.playerStructuredConsumerMode
});

let printedLogIndex = 0;
const playerFacingHistory = [];
const cliPublicationBookkeeping = new Set();

const rl = readline.createInterface({ input, output });

printIntro();
await printNewPlayerLog();

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
      await printPublicState();
      continue;
    }

    if (command === "log") {
      console.log(formatEntries(playerFacingHistory));
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

      const action = await game.dispatchPlayerAction({
        type: "ask_npc",
        target,
        input: question,
        logCursor: printedLogIndex
      });
      await printNewPlayerLog(action.playerFacingEntries, action.structuredPlayerEntries);
      maybePrintDevTail();
      continue;
    }

    if (command === "vote") {
      const voteAction = await game.dispatchPlayerAction({
        type: "advance_vote",
        logCursor: printedLogIndex
      });
      await printNewPlayerLog(voteAction.playerFacingEntries, voteAction.structuredPlayerEntries);
      maybePrintDevTail();

      if (!game.state.winner) {
        const nightAction = await game.dispatchPlayerAction({
          type: "run_night",
          logCursor: printedLogIndex
        });
        await printNewPlayerLog(nightAction.playerFacingEntries, nightAction.structuredPlayerEntries);
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

async function printPublicState() {
  const snapshot = (await game.dispatchPlayerAction({ type: "get_state" })).publicSnapshot;
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

async function printNewPlayerLog(entries = game.state.playerLog.slice(printedLogIndex), structuredEntries = []) {
  const write = async (entry) => { await writeCliPublication({ entry, write: async (text) => { if (text) console.log(`\n${text}`); } }); playerFacingHistory.push(structuredClone(entry)); };
  if (runtimeConfig.playerStructuredConsumerMode) {
    const represented = new Set(entries.filter((entry) => entry.structured).map((entry) => entry.publicationId)), deliveryEntries = [...structuredEntries.filter((entry) => !represented.has(entry.publicationId)), ...entries];
    try { await deliverProjectedEntries({ game, entries: deliveryEntries, consumerId: "cli-main", sinkType: "cli", writeStructured: async (entry) => { if (cliPublicationBookkeeping.has(entry.publicationId)) throw new Error("duplicate_cli_publication"); await write(entry); cliPublicationBookkeeping.add(entry.publicationId); }, writeLegacy: write }); }
    catch (error) { if (error.acknowledgementOnlyRetry && cliPublicationBookkeeping.has(error.publicationId)) retryPlayerPublicationAcknowledgement({ game, publicationId: error.publicationId }); else throw error; }
  } else { for (const entry of entries) await write(entry); }
  printedLogIndex = game.state.playerLog.length;
}

function formatEntries(entries) { return entries.map((entry) => `[Day ${entry.day} / ${entry.phase}] ${sanitizeTerminalText(entry.message)}`).join("\n"); }

function maybePrintDevTail() {
  if (!showDev) {
    return;
  }
  console.log("\n--- developer log tail ---");
  console.log(game.formatDeveloperLog({ last: 3 }));
}
