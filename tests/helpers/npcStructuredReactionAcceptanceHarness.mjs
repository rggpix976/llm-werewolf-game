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
const STATIC_PRIVACY_MARKERS = Object.freeze(["LIFECYCLE_SETTLEMENT_MARKER_DO_NOT_LEAK"]);

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

export function createPrivateFailureEvidence(label) {
  const normalized = String(label).replace(/[^A-Z0-9_]/gu, "_").toUpperCase();
  const markers = Object.freeze({
    rawProvider: `${normalized}_RAW_PROVIDER_MARKER_DO_NOT_LEAK`,
    authorization: `${normalized}_AUTHORIZATION_MARKER_DO_NOT_LEAK`,
    stackCause: `${normalized}_STACK_CAUSE_MARKER_DO_NOT_LEAK`,
    localPath: `${normalized}_LOCAL_PATH_MARKER_DO_NOT_LEAK`,
    settlement: `${normalized}_SETTLEMENT_MARKER_DO_NOT_LEAK`
  });
  const error = Object.assign(new Error(markers.rawProvider), {
    authorizationMetadata: markers.authorization,
    stack: `Error: ${markers.stackCause} at C:\\${markers.localPath}`,
    cause: new Error(markers.stackCause),
    settlementMarker: markers.settlement,
    code: "provider_unavailable",
    retryable: false
  });
  return Object.freeze({ error, markers });
}

export function assertPrivateFailureSource(evidence) {
  const serialized = JSON.stringify(evidence.error, Object.getOwnPropertyNames(evidence.error));
  for (const marker of Object.values(evidence.markers)) {
    assert.ok(serialized.includes(marker), `missing private failure source: ${marker}`);
  }
}

export function assertPrivateProjectionSource(request) {
  const projection = request?.knownInformation;
  const actorPrivate = projection?.actorPrivate;
  assert.equal(projection?.projectionType, "npc_known_information");
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(actorPrivate), true);
  assert.equal(typeof actorPrivate?.ownRole, "string");
  assert.ok(actorPrivate.ownRole.length > 0);
  assert.equal(typeof actorPrivate.ownTeam, "string");
  assert.ok(actorPrivate.ownTeam.length > 0);
  for (const field of ["investigationResults", "voteHistory", "suspicionScores"]) {
    assert.equal(Array.isArray(actorPrivate[field]), true, field);
    assert.equal(Object.isFrozen(actorPrivate[field]), true, field);
  }
  const privateFragment = actorPrivate.investigationResults[0]
    ?? actorPrivate.suspicionScores[0]
    ?? actorPrivate.voteHistory[0];
  assert.ok(privateFragment, "expected a private-only projection fragment");
  assert.equal(Object.isFrozen(privateFragment), true);
  const source = JSON.stringify({ actorPrivate });
  for (const field of ["actorPrivate", "ownRole", "ownTeam", "investigationResults", "suspicionScores"]) {
    assert.ok(source.includes(`\"${field}\"`), `missing private projection source: ${field}`);
  }
  return Object.freeze({ actorPrivate, privateFragment });
}

export function assertPrivateProjectionAbsent(value, evidence) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const field of ["actorPrivate", "ownRole", "ownTeam", "investigationResults", "suspicionScores"]) {
    assert.equal(serialized.includes(field), false, `private projection field leaked: ${field}`);
  }
  assert.equal(serialized.includes(JSON.stringify(evidence.actorPrivate)), false, "actorPrivate object leaked");
  assert.equal(serialized.includes(JSON.stringify(evidence.privateFragment)), false, "private projection fragment leaked");
}

export function assertCandidatePrivateProjectionAbsentFromDeveloperOutput(value, evidence) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const field of ["actorPrivate", "ownRole", "ownTeam"]) {
    assert.equal(serialized.includes(field), false, `candidate private projection field leaked: ${field}`);
  }
  assert.equal(serialized.includes(JSON.stringify(evidence.actorPrivate)), false, "candidate actorPrivate object leaked");
  assert.equal(serialized.includes(JSON.stringify(evidence.privateFragment)), false, "candidate private projection fragment leaked");
}

export function assertPrivacySafe(value, extraMarkers = []) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const marker of [...STATIC_PRIVACY_MARKERS, ...extraMarkers]) {
    assert.equal(serialized.includes(marker), false, marker);
  }
  for (const forbidden of [AUTH_HEADER_NAME, "retryToken", "receipt capability", "rawResponse", "stack\"", "cause\""]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
}

export function assertUnique(values, label) {
  assert.equal(values.length, new Set(values).size, `${label} must be unique`);
}

export function assertSafeIdentityShape(state) {
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

export async function withBrowserApp(playerStructuredConsumerEnabled, callback, transportOptions = {}) {
  const browser = createBrowserEnvironment();
  const transport = createBrowserTransportHarness(playerStructuredConsumerEnabled, transportOptions);
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

export function installOneShotAcknowledgementPublicationFault() {
  const original = Reflect.ownKeys;
  const failureEvidence = createPrivateFailureEvidence("LIFECYCLE_SETTLEMENT");
  const seenAcknowledgements = new WeakSet();
  let acknowledgementAttempts = 0;
  let restored = false;
  Reflect.ownKeys = (value) => {
    if (value && typeof value === "object"
        && value.acknowledgementType === "npc_publication_acknowledged"
        && !seenAcknowledgements.has(value)) {
      seenAcknowledgements.add(value);
      acknowledgementAttempts += 1;
      if (acknowledgementAttempts === 1) {
        throw failureEvidence.error;
      }
    }
    return original(value);
  };
  return Object.freeze({
    get acknowledgementAttempts() { return acknowledgementAttempts; },
    failureEvidence,
    restore() {
      if (restored) return;
      restored = true;
      Reflect.ownKeys = original;
    }
  });
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
