import assert from "node:assert/strict";

import { WerewolfGame } from "../../src/gameEngine.mjs";
import { PseudoInterpreterProvider, createLocalInterpreterHttpProvider } from "../../src/interpreterTransport.mjs";
import { createNpcBrowserPublicationSink } from "../../src/npcBrowserPublicationSink.mjs";
import { createNpcReactionCandidateProvider } from "../../src/npcReactionCandidateProvider.mjs";
import { createLocalNpcReactionCandidateTransport } from "../../src/npcReactionCandidateTransport.mjs";
import { createPseudoNpcReactionCandidateInvoker } from "../../src/npcReactionCandidateUpstream.mjs";
import { createNpcCliPublicationSink } from "../../src/npcCliPublicationSink.mjs";
import { createProductionNpcStructuredDeliveryIntegration } from "../../src/npcProductionIntegration.mjs";
import { consumeLiveActionDisplay } from "../../src/playerDisplaySink.mjs";
import {
  createBrowserEnvironment,
  createBrowserTransportHarness,
  createLifecycleGame,
  ids
} from "./npcStructuredReactionLifecycleCorrectionHarness.mjs";

let browserImportOrder = 0;
const AUTH_HEADER_NAME = ["Author", "ization"].join("");

export const PRIVACY_MARKERS = Object.freeze([
  "PRIVATE_ROLE_MARKER_DO_NOT_LEAK",
  "PRIVATE_TEAM_MARKER_DO_NOT_LEAK",
  "PRIVATE_KNOWLEDGE_MARKER_DO_NOT_LEAK",
  "RAW_PROVIDER_MARKER_DO_NOT_LEAK",
  "AUTHORIZATION_MARKER_DO_NOT_LEAK",
  "STACK_CAUSE_MARKER_DO_NOT_LEAK",
  "LOCAL_PATH_MARKER_DO_NOT_LEAK",
  "LIFECYCLE_SETTLEMENT_MARKER_DO_NOT_LEAK"
]);

export function createAcceptanceGame(options = {}) {
  const counters = options.counters ?? {
    candidate: 0,
    legacy: 0,
    ids: 0,
    npcWrites: 0,
    playerWrites: 0
  };
  const created = createLifecycleGame({ ...options, counters });
  return { ...created, counters };
}

export function createDeliveryAcceptanceGame(options = {}) {
  const counters = options.counters ?? {
    candidate: 0,
    legacy: 0,
    npcWrites: 0,
    playerWrites: 0
  };
  const pseudoCandidate = createPseudoNpcReactionCandidateInvoker();
  const invokeProvider = options.invokeProvider ?? (async (request, invocationOptions) => {
    counters.candidate += 1;
    return pseudoCandidate(request, invocationOptions);
  });
  const provider = createNpcReactionCandidateProvider({ invokeProvider });
  const candidateTransport = options.candidateTransport ?? createLocalNpcReactionCandidateTransport({
    provider,
    createServerCorrelationId: ids("acceptance-server-candidate")
  });
  const interpreterProvider = createLocalInterpreterHttpProvider(new PseudoInterpreterProvider(), {
    createServerCorrelationId: ids("acceptance-server-interpreter")
  });
  const game = WerewolfGame.create({
    seed: 1,
    scenario: "sample",
    shuffleRoles: false,
    createId: ids(options.idPrefix ?? "acceptance-game"),
    interpreterValidationEnabled: true,
    playerConversationCommitEnabled: true,
    playerStructuredConsumerEnabled: options.playerStructuredConsumerEnabled ?? true,
    npcStructuredReactionEnabled: options.npcStructuredReactionEnabled ?? true,
    interpreterProvider,
    responseProvider: {
      async generateResponse() {
        counters.legacy += 1;
        return { text: "legacy", providerName: "legacy", model: "test", usage: null, notes: [] };
      }
    },
    createNpcStructuredProductionIntegration: ({ gameSessionId, authorityPort, deliveryReadPort }) => {
      const sink = options.npcDom
        ? createNpcBrowserPublicationSink({
            getConversationContainer: options.npcDom.getConversationContainer,
            createTextNode: options.npcDom.createTextNode,
            createMessageNode: options.npcDom.createMessageNode
          })
        : createNpcCliPublicationSink({
            write: async ({ text }) => {
              counters.npcWrites += 1;
              await options.npcWrite?.(text);
            },
            failureGuarantee: options.failureGuarantee ?? "unknown_on_failure"
          });
      return createProductionNpcStructuredDeliveryIntegration({
        gameSessionId,
        authorityPort,
        deliveryReadPort,
        candidateTransport,
        sink,
        consumer: {
          consumerId: options.npcDom ? "acceptance-browser-npc" : "acceptance-cli-npc",
          sinkType: options.npcDom ? "browser" : "cli"
        },
        createId: ids("acceptance-runtime"),
        nowUtc: () => "2026-07-21T00:00:00.000Z",
        nowMonotonicMs: () => 0,
        scheduleTimer: options.scheduleTimer ?? ((callback, delayMs) => ({ callback, delayMs, cancelled: false })),
        cancelTimer: options.cancelTimer ?? ((handle) => { handle.cancelled = true; }),
        createAbortController: () => new AbortController(),
        observer: options.observer ?? (() => {})
      });
    }
  });
  return { game, counters };
}

export function createFailingNpcDom(failureCount) {
  let remainingFailures = failureCount;
  const container = {
    children: [],
    appendAttempts: 0,
    appendChild(node) {
      this.appendAttempts += 1;
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("acceptance browser append failed");
      }
      this.children.push(node);
      node.parentNode = this;
      return node;
    },
    contains(node) { return this.children.includes(node); },
    removeChild(node) {
      this.children = this.children.filter((candidate) => candidate !== node);
      node.parentNode = null;
    }
  };
  return {
    container,
    get appendAttempts() { return container.appendAttempts; },
    getConversationContainer: () => container,
    createTextNode: (text) => ({ nodeType: 3, textContent: text, parentNode: null }),
    createMessageNode: ({ textNode }) => {
      const node = {
        nodeType: 1,
        childNodes: [textNode],
        firstChild: textNode,
        lastChild: textNode,
        parentNode: null,
        remove() { this.parentNode?.removeChild(this); }
      };
      textNode.parentNode = node;
      return node;
    }
  };
}

export async function completePlayerAndNpc(game, action, options = {}) {
  const order = options.order ?? [];
  const bookkeeping = options.bookkeeping ?? new Map();
  await consumeLiveActionDisplay({
    game,
    action,
    consumerId: options.consumerId ?? "acceptance-player-consumer",
    sinkType: "cli",
    bookkeeping,
    writeStructured: async () => {
      options.counters && (options.counters.playerWrites += 1);
      order.push(options.playerLabel ?? "player");
      await options.writePlayer?.();
    },
    writeLegacy: async () => {
      options.counters && (options.counters.playerWrites += 1);
      order.push(options.playerLabel ?? "player");
      await options.writePlayer?.();
    }
  });
  const delivery = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId: action.result.conversationCommitResult.playerPublicationId
  });
  return { delivery, bookkeeping, order };
}

export function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

export function authoritativeSnapshot(game) {
  const { rng, ...state } = game.state;
  return structuredClone({ ...state, rngState: rng.state });
}

export function assertPrivacySafe(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const marker of PRIVACY_MARKERS) assert.equal(serialized.includes(marker), false, marker);
  for (const forbidden of [AUTH_HEADER_NAME, "retryToken", "receipt capability", "rawResponse", "stack\"", "cause\""]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
}

export function assertUnique(values, label) {
  assert.equal(values.length, new Set(values).size, `${label} must be unique`);
}

export function assertSafeMonotonicIdentityState(state) {
  assert.equal(Number.isSafeInteger(state.stateVersion), true);
  assert.equal(Number.isSafeInteger(state.turnOrder), true);
  assert.ok(state.stateVersion >= 0);
  assert.ok(state.turnOrder >= 0);
  assert.equal(typeof state.turnId, "string");
  assert.ok(state.turnId.length > 0);
  assert.equal(typeof state.gameSessionId, "string");
  assert.ok(state.gameSessionId.length > 0);
  assertUnique(state.conversation.reactionPlans.map((entry) => entry.reactionPlanId), "reactionPlanId");
  assertUnique(
    state.conversation.npcReactionCommitIdempotencyRecords.map((entry) => entry.successfulAttemptId),
    "successfulAttemptId"
  );
  assertUnique(
    state.conversation.publications.map((entry) => entry.publicationId),
    "publicationId"
  );
}

export async function withBrowserApp(playerStructuredConsumerEnabled, callback) {
  const browser = createBrowserEnvironment();
  const transport = createBrowserTransportHarness(playerStructuredConsumerEnabled);
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalAlert = globalThis.alert;
  globalThis.document = browser.document;
  globalThis.fetch = transport.fetch;
  globalThis.alert = (message) => { throw new Error(`unexpected Browser alert: ${message}`); };
  try {
    browserImportOrder += 1;
    await import(`../../public/browserApp.mjs?f06-acceptance-${playerStructuredConsumerEnabled}-${browserImportOrder}`);
    await settleMicrotasks();
    return await callback({ browser, transport });
  } finally {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.alert = originalAlert;
  }
}

export async function submitBrowserQuestion(browser, targetId, input) {
  browser.elements.targetSelect.value = targetId;
  browser.elements.questionInput.value = input;
  return browser.elements.askForm.listeners.get("submit")({ preventDefault() {} });
}

export function browserPublicationOrder(browser) {
  return browser.elements.logList.children
    .filter((node) => node.dataset?.publicationId || node.dataset?.npcPublicationId)
    .map((node) => node.dataset.publicationId ? "player" : "npc");
}

export async function settleMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

export { ids };
