import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";

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

export async function runCli(options = {}) {
  const runtimeConfig = options.runtimeConfig ?? parseConfig(options.environment ?? process.env);
  const showDev = options.showDev ?? (options.arguments ?? process.argv).includes("--show-dev");
  const writeLine = options.writeLine ?? ((text) => console.log(text));
  const writeError = options.writeError ?? ((text) => console.error(text));
  const writePublicationText = options.writePublicationText ?? (async (text) => { if (text) writeLine(`\n${text}`); });
  const game = options.game ?? createCliGame(runtimeConfig, writeLine);
  const rl = options.readlineInterface ?? readline.createInterface({ input, output });
  const destroyOnExit = options.destroyOnExit !== false;
  let printedLogIndex = 0;
  const playerFacingHistory = [];
  const cliPublicationBookkeeping = new Map();
  let pendingCliDisplayHandoff = null;

  function printAliveNpcs(snapshot = game.getPublicSnapshot()) {
    const alive = snapshot.players.filter((player) => player.alive).map((player) => {
      return `${player.id}:${player.name}(${(player.aliases ?? []).slice(0, 2).join("/")})`;
    });
    writeLine(`Alive NPCs: ${alive.join(", ")}`);
  }

  function printHelp() {
    writeLine([
      "",
      "Commands:",
      "  ask <npcId|name|alias> <質問文>  NPCに自由入力で質問する",
      "  retry                        失敗したPlayer表示またはNPC Deliveryを再試行する",
      "  vote                         投票、処刑、夜行動、勝敗判定まで進める",
      "  state                        公開状態を見る",
      "  log                          プレイヤー表示用ログを見る",
      "  dev                          開発者用ログの末尾を見る",
      "  help                         ヘルプ",
      "  quit                         終了"
    ].join("\n"));
    printAliveNpcs();
  }

  async function writeCliEntry(entry) {
    await writeCliPublication({ entry, write: writePublicationText });
    playerFacingHistory.push(structuredClone(entry));
    return entry;
  }

  async function dispatchCommand(action) {
    return dispatchPlayerActionWithConsumerMode({
      game,
      action,
      requestedMode: runtimeConfig.playerStructuredConsumerMode ? "structured" : "legacy",
      consumerId: "cli-main",
      sinkType: "cli",
      bookkeeping: cliPublicationBookkeeping,
      writeStructured: writeCliEntry,
      writeLegacy: writeCliEntry
    });
  }

  async function continuePendingCliDisplay(handoff) {
    if (pendingCliDisplayHandoff !== handoff) return Object.freeze({ status: "stale" });
    if (!handoff.playerDisplayed) {
      await consumeLiveActionDisplay({
        game,
        action: handoff.action,
        consumerId: "cli-main",
        sinkType: "cli",
        bookkeeping: cliPublicationBookkeeping,
        writeStructured: writeCliEntry,
        writeLegacy: writeCliEntry
      });
      if (pendingCliDisplayHandoff !== handoff) return Object.freeze({ status: "stale" });
      handoff.playerDisplayed = true;
      printedLogIndex = handoff.action.nextLogCursor;
    }
    const completion = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
      schemaVersion: 1,
      gameSessionId: game.state.gameSessionId,
      playerPublicationId: handoff.playerPublicationId
    });
    if (pendingCliDisplayHandoff !== handoff) return Object.freeze({ status: "stale" });
    if (isTerminalNpcDelivery(completion.deliveryStatus)) pendingCliDisplayHandoff = null;
    else writeLine("NPC Deliveryは未完了です。retry で同じhandoffを再試行できます。");
    return completion;
  }

  async function printNewPlayerLog(action = null) {
    if (action?.result?.structuredNpc?.deliveryStatus === "pending_player_display") {
      if (pendingCliDisplayHandoff) throw new Error("input_in_progress");
      pendingCliDisplayHandoff = {
        action: frozenClone(action),
        playerPublicationId: action.result.conversationCommitResult.playerPublicationId,
        playerDisplayed: false
      };
      return continuePendingCliDisplay(pendingCliDisplayHandoff);
    }
    if (action) {
      await consumeLiveActionDisplay({
        game,
        action,
        consumerId: "cli-main",
        sinkType: "cli",
        bookkeeping: cliPublicationBookkeeping,
        writeStructured: writeCliEntry,
        writeLegacy: writeCliEntry
      });
    } else {
      for (const entry of game.state.playerLog.slice(printedLogIndex)) await writeCliEntry(entry);
    }
    printedLogIndex = game.state.playerLog.length;
    return null;
  }

  function maybePrintDevTail() {
    if (showDev) writeLine(`\n--- developer log tail ---\n${game.formatDeveloperLog({ last: 3 })}`);
  }

  function printIntro() {
    writeLine("LLM人狼 最小プロトタイプ");
    printHelp();
  }

  try {
    printIntro();
    await printNewPlayerLog();
    while (true) {
      const line = (await rl.question("\n> ")).trim();
      if (!line) continue;
      const [command, ...rest] = line.split(/\s+/);
      try {
        if (command === "quit" || command === "exit") break;
        if (command === "help") { printHelp(); continue; }
        if (command === "state") {
          const current = (await game.dispatchPlayerAction({ type: "get_state" })).publicSnapshot;
          writeLine(`Day ${current.day} / phase=${current.phase} / winner=${current.winner ?? "none"}`);
          printAliveNpcs(current);
          const dead = current.players.filter((player) => !player.alive).map((player) => player.name);
          writeLine(`Dead: ${dead.length ? dead.join(", ") : "none"}`);
          continue;
        }
        if (command === "log") { writeLine(formatEntries(playerFacingHistory)); continue; }
        if (command === "dev") { writeLine(game.formatDeveloperLog({ last: 8 })); continue; }
        if (command === "retry") {
          if (!pendingCliDisplayHandoff) writeLine("再試行対象の表示はありません。");
          else await continuePendingCliDisplay(pendingCliDisplayHandoff);
          continue;
        }
        if (command === "ask") {
          const target = rest.shift();
          const question = rest.join(" ");
          if (!target || !question) {
            writeLine("使い方: ask <npcId|name|alias> <質問文>");
            printAliveNpcs();
            continue;
          }
          const action = await dispatchCommand({ type: "ask_npc", target, input: question, logCursor: printedLogIndex });
          await printNewPlayerLog(action);
          maybePrintDevTail();
          continue;
        }
        if (command === "vote") {
          const voteAction = await dispatchCommand({ type: "advance_vote", logCursor: printedLogIndex });
          await printNewPlayerLog(voteAction);
          maybePrintDevTail();
          if (!game.state.winner) {
            const nightAction = await dispatchCommand({ type: "run_night", logCursor: printedLogIndex });
            await printNewPlayerLog(nightAction);
            maybePrintDevTail();
          }
          if (game.state.winner) writeLine("\nゲーム終了です。dev コマンドで開発者ログを確認できます。");
          continue;
        }
        writeLine(`未知のコマンドです: ${command}`);
        printHelp();
      } catch (error) {
        writeError(`Error: ${error.message}`);
      }
    }
  } finally {
    pendingCliDisplayHandoff = null;
    rl.close();
    if (destroyOnExit) game.destroy();
  }

  return Object.freeze({ printedLogIndex, playerFacingEntryCount: playerFacingHistory.length });
}

function createCliGame(runtimeConfig, writeLine) {
  const npcCandidateProvider = createNpcReactionCandidateProvider({
    invokeProvider: runtimeConfig.provider === "openai"
      ? createOpenAINpcReactionCandidateInvoker(runtimeConfig.openai)
      : createPseudoNpcReactionCandidateInvoker()
  });
  let npcServerCorrelationOrder = 0;
  return WerewolfGame.create({
    seed: Date.now(),
    shuffleRoles: true,
    interpreterProvider: createLocalInterpreterHttpProvider(new PseudoInterpreterProvider(), { createServerCorrelationId: () => `server-cli-interpreter-${globalThis.crypto.randomUUID()}` }),
    interpreterValidationEnabled: runtimeConfig.interpreterValidationMode,
    playerConversationCommitEnabled: runtimeConfig.playerConversationCommitMode,
    playerStructuredConsumerEnabled: runtimeConfig.playerStructuredConsumerMode,
    npcStructuredReactionEnabled: runtimeConfig.npcStructuredReactionMode,
    createNpcStructuredProductionIntegration: ({ gameSessionId, authorityPort, deliveryReadPort }) => {
      const sink = createNpcCliPublicationSink({
        write: async ({ text }) => { if (text) writeLine(`\n${text}`); },
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
}

function isTerminalNpcDelivery(status) {
  return ["delivered", "acknowledged_existing", "failed_terminal", "pending_none", "reset"].includes(status);
}

function frozenClone(value) {
  const clone = structuredClone(value);
  const freeze = (entry) => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return entry;
    for (const key of Reflect.ownKeys(entry)) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (descriptor && Object.hasOwn(descriptor, "value")) freeze(descriptor.value);
    }
    return Object.freeze(entry);
  };
  return freeze(clone);
}

function formatEntries(entries) {
  return entries.map((entry) => `[Day ${entry.day} / ${entry.phase}] ${sanitizeTerminalText(entry.message)}`).join("\n");
}

const entryPath = process.argv[1];
if (entryPath && pathToFileURL(entryPath).href === import.meta.url) await runCli();
