import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { WerewolfGame } from "./gameEngine.mjs";
import { parseConfig } from "./config.mjs";
import { PseudoInterpreterProvider, createLocalInterpreterHttpProvider } from "./interpreterTransport.mjs";
import { sanitizeTerminalText } from "./playerStructuredConsumer.mjs";
import { consumeLiveActionDisplay, dispatchPlayerActionWithConsumerMode, writeCliPublication } from "./playerDisplaySink.mjs";
import { createNpcReactionCandidateProvider } from "./npcReactionCandidateProvider.mjs";
import { createLocalNpcReactionCandidateTransport } from "./npcReactionCandidateTransport.mjs";
import { createOpenAINpcReactionCandidateInvoker, createPseudoNpcReactionCandidateInvoker } from "./npcReactionCandidateUpstream.mjs";
import { createNpcCliPublicationSink } from "./npcCliPublicationSink.mjs";
import { createProductionNpcStructuredDeliveryIntegration } from "./npcProductionIntegration.mjs";

const showDev = process.argv.includes("--show-dev");
const runtimeConfig = parseConfig(process.env);
const npcCandidateProvider = createNpcReactionCandidateProvider({
  invokeProvider: runtimeConfig.provider === "openai"
    ? createOpenAINpcReactionCandidateInvoker(runtimeConfig.openai)
    : createPseudoNpcReactionCandidateInvoker()
});
let npcServerCorrelationOrder = 0;
const game = WerewolfGame.create({
  seed: Date.now(),
  shuffleRoles: true,
  interpreterProvider: createLocalInterpreterHttpProvider(new PseudoInterpreterProvider(), { createServerCorrelationId: () => `server-cli-interpreter-${globalThis.crypto.randomUUID()}` }),
  interpreterValidationEnabled: runtimeConfig.interpreterValidationMode,
  playerConversationCommitEnabled: runtimeConfig.playerConversationCommitMode,
  playerStructuredConsumerEnabled: runtimeConfig.playerStructuredConsumerMode,
  npcStructuredReactionEnabled: runtimeConfig.npcStructuredReactionMode,
  createNpcStructuredProductionIntegration: ({ gameSessionId, authorityPort, deliveryReadPort }) => {
    const sink = createNpcCliPublicationSink({
      write: async ({ text }) => { if (text) console.log(`\n${text}`); },
      failureGuarantee: "unknown_on_failure"
    });
    return createProductionNpcStructuredDeliveryIntegration({
      gameSessionId,
      authorityPort,
      deliveryReadPort,
      candidateTransport: createLocalNpcReactionCandidateTransport({
        provider: npcCandidateProvider,
        createServerCorrelationId: () => `server-cli-${++npcServerCorrelationOrder}`
      }),
      sink,
      consumer: Object.freeze({ consumerId: "cli-npc-main", sinkType: "cli" }),
      createId: () => globalThis.crypto.randomUUID(),
      nowUtc: () => new Date().toISOString(),
      nowMonotonicMs: () => Math.floor(globalThis.performance.now()),
      scheduleTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      cancelTimer: (handle) => globalThis.clearTimeout(handle),
      createAbortController: () => new AbortController(),
      observer: () => {}
    });
  }
});

let printedLogIndex = 0;
const playerFacingHistory = [];
const cliPublicationBookkeeping = new Map();

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

      const action = await dispatchCommand({
        type: "ask_npc",
        target,
        input: question,
        logCursor: printedLogIndex
      });
      await printNewPlayerLog(action);
      maybePrintDevTail();
      continue;
    }

    if (command === "vote") {
      const voteAction = await dispatchCommand({
        type: "advance_vote",
        logCursor: printedLogIndex
      });
      await printNewPlayerLog(voteAction);
      maybePrintDevTail();

      if (!game.state.winner) {
        const nightAction = await dispatchCommand({
          type: "run_night",
          logCursor: printedLogIndex
        });
        await printNewPlayerLog(nightAction);
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
game.destroy();

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

async function printNewPlayerLog(action = null) {
  const write = writeCliEntry;
  const liveEntries = action?.livePlayerDisplayEntries ?? game.state.playerLog.slice(printedLogIndex).map((entry) => ({ kind: "legacy_display", entry }));
  if (action) await consumeLiveActionDisplay({ game, action, consumerId: "cli-main", sinkType: "cli", bookkeeping: cliPublicationBookkeeping, writeStructured: write, writeLegacy: write });
  else { for (const envelope of liveEntries) await write(envelope.entry); }
  printedLogIndex = game.state.playerLog.length;
}

async function dispatchCommand(action) { return dispatchPlayerActionWithConsumerMode({ game, action, requestedMode: runtimeConfig.playerStructuredConsumerMode ? "structured" : "legacy", consumerId: "cli-main", sinkType: "cli", bookkeeping: cliPublicationBookkeeping, writeStructured: writeCliEntry, writeLegacy: writeCliEntry }); }
async function writeCliEntry(entry) { await writeCliPublication({ entry, write: async (text) => { if (text) console.log(`\n${text}`); } }); playerFacingHistory.push(structuredClone(entry)); return entry; }


function formatEntries(entries) { return entries.map((entry) => `[Day ${entry.day} / ${entry.phase}] ${sanitizeTerminalText(entry.message)}`).join("\n"); }

function maybePrintDevTail() {
  if (!showDev) {
    return;
  }
  console.log("\n--- developer log tail ---");
  console.log(game.formatDeveloperLog({ last: 3 }));
}
