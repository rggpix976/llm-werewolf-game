import { WerewolfGame } from "../../src/gameEngine.mjs";
import { PseudoInterpreterProvider, createLocalInterpreterHttpProvider } from "../../src/interpreterTransport.mjs";
import { createNpcReactionCandidateHttpHandler, createNpcReactionCandidateProvider } from "../../src/npcReactionCandidateProvider.mjs";
import { createLocalNpcReactionCandidateTransport } from "../../src/npcReactionCandidateTransport.mjs";
import { createPseudoNpcReactionCandidateInvoker } from "../../src/npcReactionCandidateUpstream.mjs";
import { createNpcCliPublicationSink } from "../../src/npcCliPublicationSink.mjs";
import { createProductionNpcStructuredDeliveryIntegration } from "../../src/npcProductionIntegration.mjs";
import { consumeLiveActionDisplay } from "../../src/playerDisplaySink.mjs";

export function createLifecycleGame(options = {}) {
  const counters = options.counters ?? { candidate: 0, legacy: 0, ids: 0, npcWrites: 0 };
  const pseudoCandidate = createPseudoNpcReactionCandidateInvoker();
  const invokeProvider = options.invokeProvider ?? (async (request, invocationOptions) => {
    counters.candidate += 1;
    return pseudoCandidate(request, invocationOptions);
  });
  const candidateProvider = createNpcReactionCandidateProvider({ invokeProvider });
  const transport = createLocalNpcReactionCandidateTransport({
    provider: candidateProvider,
    createServerCorrelationId: ids("server-candidate")
  });
  const interpreterProvider = options.interpreterProvider ?? createLocalInterpreterHttpProvider(
    new PseudoInterpreterProvider(),
    { createServerCorrelationId: ids("server-interpreter") }
  );
  const createId = () => {
    counters.ids = (counters.ids ?? 0) + 1;
    return `engine-${counters.ids}`;
  };
  const game = WerewolfGame.create({
    seed: 1,
    scenario: "sample",
    shuffleRoles: false,
    createId,
    interpreterValidationEnabled: options.interpreterValidationEnabled ?? true,
    playerConversationCommitEnabled: options.playerConversationCommitEnabled ?? true,
    playerStructuredConsumerEnabled: options.playerStructuredConsumerEnabled ?? false,
    npcStructuredReactionEnabled: options.npcStructuredReactionEnabled ?? true,
    interpreterProvider,
    responseProvider: options.responseProvider ?? {
      async generateResponse() {
        counters.legacy += 1;
        return { text: "legacy", providerName: "legacy", model: "test", usage: null, notes: [] };
      }
    },
    npcAuthorityFaultInjector: options.npcAuthorityFaultInjector,
    createNpcStructuredProductionIntegration: options.createNpcStructuredProductionIntegration
      ?? (({ gameSessionId, authorityPort, deliveryReadPort }) => {
        const sink = createNpcCliPublicationSink({
          write: async () => {
            counters.npcWrites = (counters.npcWrites ?? 0) + 1;
            await options.npcWrite?.();
          },
          failureGuarantee: "unknown_on_failure"
        });
        return createProductionNpcStructuredDeliveryIntegration({
          gameSessionId,
          authorityPort,
          deliveryReadPort,
          candidateTransport: transport,
          sink,
          consumer: { consumerId: "cli-consumer", sinkType: "cli" },
          createId: ids("runtime"),
          nowUtc: () => "2026-07-20T00:00:00.000Z",
          nowMonotonicMs: () => 0,
          scheduleTimer: (callback, delayMs) => ({ callback, delayMs, cancelled: false }),
          cancelTimer: (handle) => { handle.cancelled = true; },
          createAbortController: () => new AbortController(),
          observer: () => {}
        });
      })
  });
  return { game, counters };
}

export async function askAndComplete(game, input, targetId = "npc1") {
  const action = await game.dispatchPlayerAction({ type: "ask_npc", targetId, input });
  if (action.result?.structuredNpc?.deliveryStatus === "pending_player_display") {
    await consumeLiveActionDisplay({
      game,
      action,
      consumerId: "player-consumer",
      sinkType: "cli",
      bookkeeping: new Map(),
      writeStructured: async () => {},
      writeLegacy: async () => {}
    });
    await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
      schemaVersion: 1,
      gameSessionId: game.state.gameSessionId,
      playerPublicationId: action.result.conversationCommitResult.playerPublicationId
    });
  }
  return action;
}

export function ids(prefix) {
  let order = 0;
  return () => `${prefix}-${++order}`;
}

export function createBrowserEnvironment() {
  class FakeNode {
    constructor(tagName) {
      this.tagName = tagName;
      this.nodeType = tagName === "#text" ? 3 : 1;
      this.children = [];
      this.childNodes = this.children;
      this.dataset = {};
      this.listeners = new Map();
      this.parentNode = null;
      this.textContent = "";
      this.value = "";
      this.hidden = false;
      this.disabled = false;
      this.className = "";
      this.scrollTop = 0;
    }
    get firstChild() { return this.children[0] ?? null; }
    get lastChild() { return this.children.at(-1) ?? null; }
    get scrollHeight() { return this.children.length; }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) { node.remove?.(); this.children.push(node); node.parentNode = this; return node; }
    replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.childNodes = this.children; this.append(...nodes); }
    remove() { if (!this.parentNode) return; const parent = this.parentNode; parent.children = parent.children.filter((child) => child !== this); parent.childNodes = parent.children; this.parentNode = null; }
    contains(node) { return this === node || this.children.some((child) => child.contains?.(node)); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    setAttribute(name, value) { this[name] = String(value); }
    querySelectorAll(selector) {
      const field = selector === "[data-publication-id]" ? "publicationId"
        : selector === "[data-npc-publication-id]" ? "npcPublicationId" : null;
      if (!field) return [];
      const found = [];
      const visit = (node) => { for (const child of node.children) { if (Object.hasOwn(child.dataset, field)) found.push(child); visit(child); } };
      visit(this);
      return found;
    }
  }
  const elementIds = [
    "statusLine", "newGameButton", "playerGrid", "askForm", "targetSelect", "questionInput",
    "askButton", "voteButton", "nightButton", "logList", "voteList", "devModeToggle", "developerPanel"
  ];
  const elements = Object.fromEntries(elementIds.map((id) => [id, new FakeNode(id)]));
  const document = {
    querySelector(selector) { return elements[selector.slice(1)]; },
    createElement(tagName) { return new FakeNode(tagName); },
    createTextNode(text) { const node = new FakeNode("#text"); node.nodeType = 3; node.textContent = text; return node; }
  };
  return { document, elements };
}

export function createBrowserTransportHarness(playerStructuredConsumerEnabled) {
  const interpreter = createLocalInterpreterHttpProvider(new PseudoInterpreterProvider(), {
    createServerCorrelationId: ids("browser-interpreter")
  });
  const provider = createNpcReactionCandidateProvider({ invokeProvider: createPseudoNpcReactionCandidateInvoker() });
  const handler = createNpcReactionCandidateHttpHandler({
    provider,
    createServerCorrelationId: ids("browser-candidate")
  });
  let candidateCalls = 0;
  return {
    get candidateCalls() { return candidateCalls; },
    async fetch(url, options = {}) {
      if (url === "/api/runtime-config") {
        return new Response(JSON.stringify({
          provider: "pseudo",
          interpreterShadowMode: false,
          interpreterValidationMode: true,
          playerConversationCommitMode: true,
          playerStructuredConsumerMode: playerStructuredConsumerEnabled,
          npcStructuredReactionMode: true
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/interpret-player-input") {
        const request = JSON.parse(options.body);
        const response = await interpreter.interpretPlayerInput(request, { signal: options.signal });
        return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      if (url === "/api/generate-npc-reaction-candidate") {
        candidateCalls += 1;
        const response = await handler.handle({
          method: "POST",
          path: "/api/generate-npc-reaction-candidate",
          contentTypeHeader: "application/json; charset=utf-8",
          contentEncodingHeader: null,
          bodyBytes: new TextEncoder().encode(options.body)
        }, { signal: options.signal });
        return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
      }
      throw new Error(`Unexpected browser test URL: ${url}`);
    }
  };
}
