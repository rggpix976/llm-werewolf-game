import { WerewolfGame } from "../src/gameEngine.mjs";
import { HttpResponseProvider, SessionManager } from "./httpResponseProvider.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";
import { InterpreterShadowClient, shouldObserveInterpreterShadow } from "./interpreterShadowClient.mjs";
import { appendBrowserPublicationNode, consumeLiveActionDisplay, dispatchPlayerActionWithConsumerMode, reconcileBrowserPublicationNodes } from "../src/playerDisplaySink.mjs";
import { createNpcBrowserPublicationSink } from "../src/npcBrowserPublicationSink.mjs";
import { createProductionNpcStructuredDeliveryIntegration } from "../src/npcProductionIntegration.mjs";
import { createNpcProductionObservationLedger, formatNpcProductionObservationRecord } from "../src/npcProductionObservationLedger.mjs";
import { PseudoInterpreterProvider, createLocalInterpreterHttpProvider } from "../src/interpreterTransport.mjs";

const elements = {
  statusLine: document.querySelector("#statusLine"),
  newGameButton: document.querySelector("#newGameButton"),
  playerGrid: document.querySelector("#playerGrid"),
  askForm: document.querySelector("#askForm"),
  targetSelect: document.querySelector("#targetSelect"),
  questionInput: document.querySelector("#questionInput"),
  askButton: document.querySelector("#askButton"),
  voteButton: document.querySelector("#voteButton"),
  nightButton: document.querySelector("#nightButton"),
  logList: document.querySelector("#logList"),
  voteList: document.querySelector("#voteList"),
  devModeToggle: document.querySelector("#devModeToggle"),
  developerPanel: document.querySelector("#developerPanel")
};

let game;
let snapshot;
let logCursor = 0;
let devLogCursor = 0;
let canRunNight = false;
let isDevMode = false;
let devLogEntries = [];
let devLogFilterKind = "";
let devLogFilterNpc = "";
let runtimeConfig = null;
let sessionManager = new SessionManager();
let currentGameId = 0;
let interpreterShadowClient = null;
let shadowObservations = [];
let playerFacingLog = [];
let playerPublicationDomBookkeeping = new Map();
let npcPublicationDomBookkeeping = new Map();
let pendingBrowserDisplayHandoff = null;
let npcProductionObservationLedger = null;

initializeApp();

async function initializeApp() {
  try {
    const res = await fetch("/api/runtime-config");
    if (!res.ok) throw new Error("Failed to fetch runtime config");
    runtimeConfig = await res.json();
    startNewGame();
  } catch (error) {
    console.error("Initialization error:", error);
    elements.statusLine.textContent = "Error: Could not connect to server.";
    alert("初期化エラー: サーバーに接続できません。");
  }
}

elements.devModeToggle.addEventListener("click", () => {
  isDevMode = !isDevMode;
  elements.devModeToggle.setAttribute("aria-pressed", isDevMode);
  elements.devModeToggle.setAttribute("aria-expanded", isDevMode);
  elements.devModeToggle.textContent = `Developer Mode: ${isDevMode ? "ON" : "OFF"}`;
  elements.developerPanel.hidden = !isDevMode;

  if (isDevMode) {
    refreshDiagnosticsSafely();
  } else {
    try { elements.developerPanel.replaceChildren(); } catch { /* diagnostic isolation */ }
  }
});

elements.newGameButton.addEventListener("click", () => {
  startNewGame();
});

elements.askForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pendingBrowserDisplayHandoff) {
    const retried = await retryPendingBrowserDisplay();
    if (retried) elements.questionInput.value = "";
    return;
  }
  const target = elements.targetSelect.value;
  const input = elements.questionInput.value.trim();
  if (!target || !input || snapshot.winner) {
    return;
  }

  const gameIdAtSubmit = currentGameId;
  if (shouldObserveInterpreterShadow(runtimeConfig) && interpreterShadowClient) interpreterShadowClient.observe({ snapshot, rawText: input, gameId: gameIdAtSubmit, targetNpcId: target });
  const result = await dispatch({
    type: "ask_npc",
    target,
    input
  });

  if (result && sessionManager.isCurrentGame(gameIdAtSubmit)) {
    elements.questionInput.value = "";
  }
});

elements.voteButton.addEventListener("click", async () => {
  if (snapshot.winner || canRunNight) {
    return;
  }

  const action = await dispatch({ type: "advance_vote" });
  if (action) {
    canRunNight = !action.publicSnapshot.winner;
    render(action.publicSnapshot);
  }
});

elements.nightButton.addEventListener("click", async () => {
  if (!canRunNight || snapshot.winner) {
    return;
  }

  canRunNight = false;
  const action = await dispatch({ type: "run_night" });
  if (action) {
    render(action.publicSnapshot);
  }
});

function startNewGame() {
  const nextGameId = sessionManager.startNewGame();
  game?.destroy?.();
  npcProductionObservationLedger?.reset();
  npcProductionObservationLedger = null;
  pendingBrowserDisplayHandoff = null;
  elements.questionInput.value = "";
  for (const node of elements.logList.querySelectorAll("[data-npc-publication-id]")) node.remove();
  npcPublicationDomBookkeeping.clear();
  playerPublicationDomBookkeeping.clear();
  currentGameId = nextGameId;

  // Always use HttpResponseProvider, delegate selection to server
  const responseProvider = new HttpResponseProvider({
    sessionManager
  });
  interpreterShadowClient = shouldObserveInterpreterShadow(runtimeConfig) ? new InterpreterShadowClient({ provider: responseProvider, sessionManager, observer: (entry) => { shadowObservations = [...shadowObservations.slice(-99), Object.freeze({ ...entry })]; } }) : null;
  shadowObservations = [];

  const capturedGameId = currentGameId;
  game = WerewolfGame.create({
    seed: Date.now(),
    shuffleRoles: true,
    responseProvider,
    interpreterProvider: runtimeConfig?.provider === "pseudo"
      ? createLocalInterpreterHttpProvider(new PseudoInterpreterProvider(), { createServerCorrelationId: () => `server-browser-${globalThis.crypto.randomUUID()}` })
      : responseProvider,
    interpreterValidationEnabled: runtimeConfig?.interpreterValidationMode === true,
    playerConversationCommitEnabled: runtimeConfig?.playerConversationCommitMode === true,
    playerStructuredConsumerEnabled: runtimeConfig?.playerStructuredConsumerMode === true,
    npcStructuredReactionEnabled: runtimeConfig?.npcStructuredReactionMode === true,
    createNpcStructuredProductionIntegration: ({ gameSessionId, authorityPort, deliveryReadPort }) => {
      const observationLedger = createNpcProductionObservationLedger({ gameSessionId, capacity: 200 });
      const sink = createNpcBrowserPublicationSink({
        getConversationContainer: () => sessionManager.isCurrentGame(capturedGameId) ? elements.logList : null,
        createTextNode: (text) => document.createTextNode(text),
        createMessageNode: ({ textNode, publicationId, deliveryAttemptId }) => {
          const node = document.createElement("div");
          node.className = "log-entry npc-canonical-publication";
          node.dataset.npcPublicationId = publicationId;
          node.dataset.deliveryAttemptId = deliveryAttemptId;
          node.dataset.browserGameId = String(capturedGameId);
          node.append(textNode);
          return node;
        }
      });
      try {
        const integration = createProductionNpcStructuredDeliveryIntegration({
          gameSessionId,
          authorityPort,
          deliveryReadPort,
          candidateTransport: Object.freeze({ generateCandidateTransport: responseProvider.generateCandidateTransport.bind(responseProvider) }),
          sink,
          consumer: Object.freeze({ consumerId: "browser-npc-main", sinkType: "browser" }),
          createId: () => globalThis.crypto.randomUUID(),
          nowUtc: () => new Date().toISOString(),
          nowMonotonicMs: () => Math.floor(globalThis.performance.now()),
          scheduleTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
          cancelTimer: (handle) => globalThis.clearTimeout(handle),
          createAbortController: () => new AbortController(),
          observer: observationLedger.observe
        });
        npcProductionObservationLedger = observationLedger;
        return integration;
      } catch (error) {
        observationLedger.reset();
        throw error;
      }
    },
    interpreterObserver: (entry) => { shadowObservations = [...shadowObservations.slice(-99), entry]; }
  });
  snapshot = game.getPublicSnapshot();
  logCursor = snapshot.playerLog.length;
  playerFacingLog = structuredClone(snapshot.playerLog);
  devLogCursor = 0;
  devLogEntries = [];
  devLogFilterKind = "";
  devLogFilterNpc = "";
  canRunNight = false;
  render(snapshot);
  if (isDevMode) {
    refreshDiagnosticsSafely();
  }
}

async function dispatch(action) {
  const gameIdAtStart = currentGameId;
  setBusy(true);
  try {
    const result = await dispatchPlayerActionWithConsumerMode({ game, action: { ...action, logCursor }, requestedMode: runtimeConfig?.playerStructuredConsumerMode === true ? "structured" : "legacy", consumerId: "browser-main", sinkType: "browser", bookkeeping: playerPublicationDomBookkeeping, writeStructured: writeStructuredPlayerEntry, writeLegacy: writeLegacyPlayerEntry });

    if (!sessionManager.isCurrentGame(gameIdAtStart)) {
      return null;
    }

    render(result.publicSnapshot);
    if (result.result?.structuredNpc?.deliveryStatus === "pending_player_display") {
      pendingBrowserDisplayHandoff = {
        generation: gameIdAtStart,
        action: frozenClone(result),
        playerPublicationId: result.result.conversationCommitResult.playerPublicationId,
        playerDisplayed: false
      };
      await continuePendingBrowserDisplay(pendingBrowserDisplayHandoff);
    } else if (result.livePlayerDisplayEntries.length) {
      await consumeLiveActionDisplay({ game, action: result, consumerId: "browser-main", sinkType: "browser", bookkeeping: playerPublicationDomBookkeeping, writeStructured: writeStructuredPlayerEntry, writeLegacy: writeLegacyPlayerEntry });
    }
    if (!sessionManager.isCurrentGame(gameIdAtStart)) return null;
    captureNpcPublicationNodes();
    renderLogs();
    logCursor = result.nextLogCursor;
    if (isDevMode) {
      refreshDiagnosticsSafely();
    }
    return result;
  } catch (error) {
    if (error.name === "AbortError" || !sessionManager.isCurrentGame(gameIdAtStart)) {
      return null;
    }
    throw error;
  } finally {
    if (sessionManager.isCurrentGame(gameIdAtStart)) {
      setBusy(false);
    }
  }
}

async function retryPendingBrowserDisplay() {
  const handoff = pendingBrowserDisplayHandoff;
  if (!handoff || !sessionManager.isCurrentGame(handoff.generation)) return null;
  setBusy(true);
  try { return await continuePendingBrowserDisplay(handoff); }
  finally {
    if (sessionManager.isCurrentGame(handoff.generation)) {
      setBusy(false);
      refreshDiagnosticsSafely();
    }
  }
}

async function continuePendingBrowserDisplay(handoff) {
  if (pendingBrowserDisplayHandoff !== handoff || !sessionManager.isCurrentGame(handoff.generation)) return null;
  if (!handoff.playerDisplayed) {
    await consumeLiveActionDisplay({
      game,
      action: handoff.action,
      consumerId: "browser-main",
      sinkType: "browser",
      bookkeeping: playerPublicationDomBookkeeping,
      writeStructured: writeStructuredPlayerEntry,
      writeLegacy: writeLegacyPlayerEntry
    });
    if (pendingBrowserDisplayHandoff !== handoff || !sessionManager.isCurrentGame(handoff.generation)) return null;
    handoff.playerDisplayed = true;
    logCursor = handoff.action.nextLogCursor;
  }
  const completion = await game.completeNpcStructuredReactionDeliveryAfterPlayerDisplay({
    schemaVersion: 1,
    gameSessionId: game.state.gameSessionId,
    playerPublicationId: handoff.playerPublicationId
  });
  if (pendingBrowserDisplayHandoff !== handoff || !sessionManager.isCurrentGame(handoff.generation)) return null;
  if (isTerminalNpcDelivery(completion.deliveryStatus)) pendingBrowserDisplayHandoff = null;
  captureNpcPublicationNodes();
  renderLogs();
  updateControls();
  return handoff.action;
}

async function writeStructuredPlayerEntry(entry, attempt) {
  const node = appendBrowserLogEntry(entry);
  bindBrowserDeliveryNode(node, attempt);
  return stagePlayerFacingEntry(entry, node);
}

async function writeLegacyPlayerEntry(entry, attempt) {
  if (attempt) return appendLegacyPlayerPublication(entry, attempt);
  const node = appendBrowserLogEntry(entry);
  playerFacingLog.push(structuredClone(entry));
  return node;
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

function render(nextSnapshot) {
  snapshot = nextSnapshot;
  renderStatus();
  renderPlayers();
  renderTargetOptions();
  renderLogs();
  renderVotes();
  updateControls();
}

function refreshDiagnostics() {
  if (!isDevMode) return;

  const diagnostics = game.getDeveloperDiagnostics({ logCursor: devLogCursor });
  devLogCursor = diagnostics.nextLogCursor;
  devLogEntries.push(...diagnostics.developerLogEntries);

  renderDeveloperPanel(diagnostics.snapshot);
}

function refreshDiagnosticsSafely() {
  if (!isDevMode) return;
  try {
    refreshDiagnostics();
  } catch {
    try { renderDeveloperPanelUnavailable(); } catch { /* diagnostic isolation */ }
  }
}

function renderDeveloperPanelUnavailable() {
  const section = document.createElement("div");
  section.className = "dev-section";
  const title = document.createElement("div");
  title.className = "dev-section-title";
  title.textContent = "Developer Diagnostics";
  const unavailable = document.createElement("div");
  unavailable.className = "empty-state";
  unavailable.textContent = "Developer diagnostics unavailable";
  section.append(title, unavailable);
  elements.developerPanel.replaceChildren(section);
}

function renderDeveloperPanel(devSnapshot) {
  elements.developerPanel.replaceChildren();

  elements.developerPanel.append(
    renderDevSummary(devSnapshot),
    renderNpcInternalStates(devSnapshot),
    renderDevEventLog(),
    renderResponseDiagnostics(),
    renderNpcStructuredObservations()
  );
}

function renderDevSummary(devSnapshot) {
  const section = document.createElement("div");
  section.className = "dev-section";

  const title = document.createElement("div");
  title.className = "dev-section-title";
  title.textContent = "1. Game Diagnostics Summary";

  const grid = document.createElement("div");
  grid.className = "dev-grid";

  const data = {
    day: devSnapshot.day,
    phase: devSnapshot.phase,
    winner: devSnapshot.winner || "none",
    alivePlayers: devSnapshot.alivePlayers.join(", "),
    deadPlayers: devSnapshot.deadPlayers.join(", ") || "none",
    developerLogCount: devLogEntries.length
  };

  for (const [key, value] of Object.entries(data)) {
    grid.append(createDevCard(key, value));
  }

  section.append(title, grid);
  return section;
}

function renderNpcInternalStates(devSnapshot) {
  const section = document.createElement("div");
  section.className = "dev-section";

  const title = document.createElement("div");
  title.className = "dev-section-title";
  title.textContent = "2. NPC Internal State";

  const grid = document.createElement("div");
  grid.className = "dev-grid";

  for (const player of devSnapshot.players) {
    const card = document.createElement("div");
    card.className = "dev-card";

    const name = document.createElement("div");
    name.className = "dev-card-title";
    name.textContent = `${player.name} (${player.id})`;

    card.append(name);

    const fields = [
      "role", "team", "alive", "knownInfo", "hiddenInfo",
      "suspicionScores", "publicClaims", "privateMemory",
      "voteHistory", "conversationPolicy"
    ];

    for (const field of fields) {
      card.append(createDevLabel(field));
      const value = player[field];
      if (typeof value === "object") {
        card.append(createDevDetails(value));
      } else {
        card.append(createDevValue(value));
      }
    }

    grid.append(card);
  }

  section.append(title, grid);
  return section;
}

function renderDevEventLog() {
  const section = document.createElement("div");
  section.className = "dev-section";

  const title = document.createElement("div");
  title.className = "dev-section-title";
  title.textContent = "3. Developer Event Log";

  const filters = document.createElement("div");
  filters.className = "dev-log-filters";

  const kindFilter = document.createElement("select");
  const kinds = ["", ...new Set(devLogEntries.map(e => e.kind))].sort();
  kinds.forEach(k => {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k || "All kinds";
    kindFilter.append(opt);
  });
  kindFilter.value = devLogFilterKind;
  kindFilter.addEventListener("change", (e) => {
    devLogFilterKind = e.target.value;
    refreshDiagnosticsSafely();
  });

  const kindLabel = document.createElement("label");
  kindLabel.className = "dev-label";
  kindLabel.textContent = "Filter by kind:";
  kindLabel.setAttribute("for", "devLogKindFilter");
  kindFilter.id = "devLogKindFilter";

  const npcFilter = document.createElement("select");
  npcFilter.id = "devLogNpcFilter";
  const npcs = ["", ...snapshot.players.map(p => p.id)].sort();
  npcs.forEach(n => {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n || "All NPCs";
    npcFilter.append(opt);
  });
  npcFilter.value = devLogFilterNpc;
  npcFilter.addEventListener("change", (e) => {
    devLogFilterNpc = e.target.value;
    refreshDiagnosticsSafely();
  });

  const npcLabel = document.createElement("label");
  npcLabel.className = "dev-label";
  npcLabel.textContent = "Filter by NPC:";
  npcLabel.setAttribute("for", "devLogNpcFilter");

  filters.append(kindLabel, kindFilter, npcLabel, npcFilter);

  const tableContainer = document.createElement("div");
  tableContainer.className = "dev-log-table-container";

  const table = document.createElement("table");
  table.className = "dev-log-table";

  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Day</th><th>Phase</th><th>Kind</th><th>Detail</th></tr>";
  table.append(thead);

  const tbody = document.createElement("tbody");
  const filtered = devLogEntries.filter(e => {
    if (devLogFilterKind && e.kind !== devLogFilterKind) return false;
    if (devLogFilterNpc && !developerLogReferencesNpc(e, devLogFilterNpc)) return false;
    return true;
  });

  if (filtered.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td colspan='4' class='empty-state'>No logs matching filter</td>";
    tbody.append(tr);
  } else {
    for (const entry of filtered) {
      const tr = document.createElement("tr");

      const day = document.createElement("td");
      day.textContent = entry.day;

      const phase = document.createElement("td");
      phase.textContent = formatPhase(entry.phase);

      const kind = document.createElement("td");
      kind.className = "dev-log-entry-kind";
      kind.textContent = entry.kind;

      const detail = document.createElement("td");
      detail.append(createDevDetails(entry.detail));

      tr.append(day, phase, kind, detail);
      tbody.append(tr);
    }
  }

  table.append(tbody);
  tableContainer.append(table);
  section.append(title, filters, tableContainer);
  return section;
}

function renderResponseDiagnostics() {
  const section = document.createElement("div");
  section.className = "dev-section";

  const title = document.createElement("div");
  title.className = "dev-section-title";
  title.textContent = "4. LLM / Provider Diagnostics";

  const grid = document.createElement("div");
  grid.className = "dev-grid";

  const responseLogs = devLogEntries.filter(e =>
    e.kind === "npc_response_generated" || e.kind === "npc_response_provider_error"
  ).reverse();

  if (responseLogs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No response diagnostics yet";
    section.append(title, empty);
    return section;
  }

  for (const entry of responseLogs) {
    const card = document.createElement("div");
    card.className = "dev-card";

    const name = document.createElement("div");
    name.className = "dev-card-title";
    name.textContent = `${entry.detail.npcName} (${entry.detail.npcId}) - Day ${entry.day}`;

    card.append(name);

    if (entry.kind === "npc_response_generated") {
      card.append(createDevLabel("playerInput"), createDevValue(entry.detail.playerInput));
      card.append(createDevLabel("response"), createDevValue(entry.detail.response));
      card.append(createDevLabel("evidenceUsed"), createDevDetails(entry.detail.evidenceUsed));
      card.append(createDevLabel("disclosedHiddenInfo"), createDevValue(entry.detail.disclosedHiddenInfo));
      card.append(createDevLabel("promptPreview"), createDevDetails(entry.detail.promptPreview));

      const provider = entry.detail.provider || {};
      card.append(createDevLabel("providerName"), createDevValue(provider.providerName));
      card.append(createDevLabel("model"), createDevValue(provider.model));
      card.append(createDevLabel("usage"), createDevDetails(provider.usage));
      card.append(createDevLabel("notes"), createDevDetails(provider.notes));
      if (provider.diagnostics) {
        card.append(createDevLabel("diagnostics"), createDevDetails(provider.diagnostics));
      }
    } else {
      // Error
      card.append(createDevLabel("STATUS"), createDevValue("ERROR", "danger"));
      card.append(createDevLabel("playerInput"), createDevValue(entry.detail.playerInput));
      card.append(createDevLabel("providerName"), createDevValue(entry.detail.providerName));
      card.append(createDevLabel("errorType"), createDevValue(entry.detail.errorType));
      card.append(createDevLabel("message"), createDevValue(entry.detail.message));
      if (entry.detail.diagnostics) {
        card.append(createDevLabel("diagnostics"), createDevDetails(entry.detail.diagnostics));
      }
      card.append(createDevLabel("evidenceUsed"), createDevDetails(entry.detail.evidenceUsed));
      card.append(createDevLabel("promptPreview"), createDevDetails(entry.detail.promptPreview));
    }

    grid.append(card);
  }

  section.append(title, grid);
  return section;
}

function renderNpcStructuredObservations() {
  const section = document.createElement("div");
  section.className = "dev-section";
  const title = document.createElement("div");
  title.className = "dev-section-title";
  title.textContent = "5. NPC Structured Observations";
  section.append(title);

  if (!npcProductionObservationLedger) {
    const unavailable = document.createElement("div");
    unavailable.className = "empty-state";
    unavailable.textContent = "NPC structured observations unavailable";
    section.append(unavailable);
    return section;
  }

  try {
    const observationSnapshot = npcProductionObservationLedger.getSnapshot({
      schemaVersion: 1,
      gameSessionId: game.state.gameSessionId,
      limit: 100
    });
    const summary = document.createElement("div");
    summary.className = "dev-value";
    summary.textContent = `status=${observationSnapshot.status} retained=${observationSnapshot.records.length}/${observationSnapshot.capacity} accepted=${observationSnapshot.acceptedCount} rejected=${observationSnapshot.rejectedCount} evicted=${observationSnapshot.evictedCount}`;
    section.append(summary);
    if (observationSnapshot.records.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No NPC structured observations yet";
      section.append(empty);
    } else {
      for (const record of observationSnapshot.records) {
        const line = document.createElement("div");
        line.className = "dev-value";
        line.textContent = formatNpcProductionObservationRecord(record);
        section.append(line);
      }
    }
  } catch {
    const unavailable = document.createElement("div");
    unavailable.className = "empty-state";
    unavailable.textContent = "NPC structured observations unavailable";
    section.append(unavailable);
  }
  return section;
}

function createDevCard(label, value) {
  const card = document.createElement("div");
  card.className = "dev-card";
  card.append(createDevLabel(label), createDevValue(value));
  return card;
}

function createDevLabel(text) {
  const label = document.createElement("div");
  label.className = "dev-label";
  label.textContent = text;
  return label;
}

function createDevValue(value, type = "") {
  const div = document.createElement("div");
  div.className = "dev-value";
  if (type === "danger") div.style.color = "#ef4444";
  div.textContent = typeof value === "string" ? value : JSON.stringify(value);
  return div;
}

function createDevDetails(obj) {
  const details = document.createElement("details");
  details.className = "dev-details";
  const summary = document.createElement("summary");
  summary.textContent = "View details";
  const pre = document.createElement("pre");
  pre.className = "dev-pre";
  pre.textContent = JSON.stringify(obj, null, 2);
  details.append(summary, pre);
  return details;
}

function developerLogReferencesNpc(entry, npcId) {
  if (!npcId) return true;
  const d = entry.detail || {};

  if (d.npcId === npcId) return true;
  if (d.targetId === npcId) return true;
  if (d.actorId === npcId) return true;
  if (d.seerId === npcId) return true;
  if (d.werewolfId === npcId) return true;
  if (d.executedId === npcId) return true;

  if (Array.isArray(d.mentionedIds) && d.mentionedIds.includes(npcId)) return true;
  if (Array.isArray(d.roles) && d.roles.some(p => p.id === npcId)) return true;
  if (Array.isArray(d.votes) && d.votes.some(v => v.voterId === npcId || v.targetId === npcId)) return true;

  // snapshot.players check if the detail IS the snapshot
  if (Array.isArray(d.players) && d.players.some(p => p.id === npcId)) return true;

  return false;
}

function renderStatus() {
  const winner = snapshot.winner ? ` / Winner: ${snapshot.winner}` : "";
  const providerInfo = runtimeConfig
    ? ` (Provider: ${runtimeConfig.provider}${runtimeConfig.model ? " / " + runtimeConfig.model : ""})`
    : "";
  elements.statusLine.textContent = `Day ${snapshot.day} / ${formatPhase(snapshot.phase)}${winner}${providerInfo}`;
}

function renderPlayers() {
  elements.playerGrid.replaceChildren(
    ...snapshot.players.map((player) => {
      const card = document.createElement("article");
      card.className = `player-card${player.alive ? "" : " dead"}`;

      const nameRow = document.createElement("div");
      nameRow.className = "player-name-row";

      const name = document.createElement("div");
      name.className = "player-name";
      name.textContent = player.name;

      const badge = document.createElement("span");
      badge.className = `badge${player.alive ? "" : " dead"}`;
      badge.textContent = player.alive ? "Alive" : "Dead";

      nameRow.append(name, badge);

      const meta = document.createElement("div");
      meta.className = "player-meta";
      meta.textContent = `${player.id} / ${player.speechStyle}`;

      card.append(nameRow, meta, renderClaims(player));
      return card;
    })
  );
}

function renderClaims(player) {
  const claims = document.createElement("div");
  claims.className = "claim-list";

  if (!player.publicClaims.length) {
    const empty = document.createElement("span");
    empty.className = "player-meta";
    empty.textContent = "No public claim";
    claims.append(empty);
    return claims;
  }

  for (const claim of player.publicClaims) {
    const item = document.createElement("span");
    const results = (claim.results ?? [])
      .map((result) => `${result.targetId}: ${result.result}`)
      .join(", ");
    item.textContent = results ? `Claim: ${claim.role} (${results})` : `Claim: ${claim.role}`;
    claims.append(item);
  }

  return claims;
}

function renderTargetOptions() {
  const previousTarget = elements.targetSelect.value;
  elements.targetSelect.replaceChildren(
    ...snapshot.players.map((player) => {
      const option = document.createElement("option");
      option.value = player.id;
      option.textContent = `${player.name} (${player.id}, ${player.alive ? "Alive" : "Dead"})`;
      return option;
    })
  );

  if (snapshot.players.some((player) => player.id === previousTarget)) {
    elements.targetSelect.value = previousTarget;
  }
}

function renderLogs() {
  const entries = playerFacingLog;
  const npcNodes = [...elements.logList.querySelectorAll("[data-npc-publication-id]")];
  const currentNpcNodes = npcNodes.filter((node) => {
    const stored = npcPublicationDomBookkeeping.get(node.dataset.npcPublicationId);
    const current = node.dataset.browserGameId === String(currentGameId) && stored?.node === node;
    if (!current) node.remove();
    return current;
  });
  if (!entries.length) {
    elements.logList.replaceChildren(...(currentNpcNodes.length ? currentNpcNodes : [createEmptyState("No log entries")]));
    return;
  }

  reconcileBrowserPublicationNodes({ document, container: elements.logList, entries, formatPhase });
  const playerNodes = [...elements.logList.querySelectorAll("[data-publication-id]")];
  const merged = [];
  appendNpcNodesAfterPlayerCount(merged, 0);
  playerNodes.forEach((node, index) => {
    merged.push(node);
    appendNpcNodesAfterPlayerCount(merged, index + 1);
  });
  elements.logList.replaceChildren(...merged);
  elements.logList.scrollTop = elements.logList.scrollHeight;
  const nodesByPublication = new Map([...elements.logList.querySelectorAll("[data-publication-id]")].map((node) => [node.dataset.publicationId, node]));
  for (const stored of playerPublicationDomBookkeeping.values()) {
    const identity = stored.identity, node = identity && nodesByPublication.get(identity.publicationId); if (!node) continue;
    node.dataset.gameSessionId = identity.gameSessionId; node.dataset.consumerId = identity.consumerId; node.dataset.consumerGeneration = String(identity.consumerGeneration); node.dataset.deliveryAttemptId = identity.deliveryAttemptId; node.dataset.sinkType = identity.sinkType; node.dataset.deliveryMode = identity.deliveryMode; node.dataset.receiptId = identity.receiptId; stored.value = node;
  }
}

function captureNpcPublicationNodes() {
  for (const node of elements.logList.querySelectorAll("[data-npc-publication-id]")) {
    if (node.dataset.browserGameId !== String(currentGameId)) {
      node.remove();
      continue;
    }
    const publicationId = node.dataset.npcPublicationId;
    if (!npcPublicationDomBookkeeping.has(publicationId)) {
      npcPublicationDomBookkeeping.set(publicationId, {
        node,
        afterPlayerCount: elements.logList.querySelectorAll("[data-publication-id]").length
      });
    }
  }
}

function appendNpcNodesAfterPlayerCount(output, playerCount) {
  for (const value of npcPublicationDomBookkeeping.values()) {
    if (value.afterPlayerCount === playerCount) output.push(value.node);
  }
}


function appendBrowserLogEntry(entry) {
  return appendBrowserPublicationNode({ document, container: elements.logList, entry, formatPhase });
}

function bindBrowserDeliveryNode(node, attempt) { node.dataset.publicationId = attempt.publicationId; node.dataset.gameSessionId = attempt.gameSessionId; node.dataset.consumerId = attempt.consumerId; node.dataset.consumerGeneration = String(attempt.consumerGeneration); node.dataset.deliveryAttemptId = attempt.deliveryAttemptId; node.dataset.sinkType = attempt.sinkType; node.dataset.deliveryMode = attempt.deliveryMode; if (attempt.modeTransitionId) node.dataset.modeTransitionId = attempt.modeTransitionId; }
function appendLegacyPlayerPublication(entry, attempt) { const node = appendBrowserLogEntry(entry); bindBrowserDeliveryNode(node, attempt); return stagePlayerFacingEntry({ ...structuredClone(entry), publicationId: attempt.publicationId }, node); }
function stagePlayerFacingEntry(entry, node) { const modelEntry = structuredClone(entry); playerFacingLog.push(modelEntry); node.rollbackDeliveryModel = () => { const index = playerFacingLog.indexOf(modelEntry); if (index >= 0) playerFacingLog.splice(index, 1); }; return node; }

function renderVotes() {
  if (!snapshot.voteHistory.length) {
    elements.voteList.replaceChildren(createEmptyState("No votes yet"));
    return;
  }

  elements.voteList.replaceChildren(
    ...snapshot.voteHistory.map((round) => {
      const row = document.createElement("div");
      row.className = "vote-round";

      const meta = document.createElement("div");
      meta.className = "vote-meta";
      meta.textContent = `Day ${round.day} / Executed: ${nameFor(round.executedId)}${round.tie ? " / Tie" : ""}`;

      const votes = document.createElement("div");
      votes.className = "vote-items";
      votes.textContent = round.votes
        .map((vote) => `${vote.voterName} -> ${vote.targetName}`)
        .join(", ");

      row.append(meta, votes);
      return row;
    })
  );
}

function updateControls() {
  const gameOver = Boolean(snapshot.winner);
  const noAlivePlayers = snapshot.players.every((player) => !player.alive);
  const questionAvailable = !gameOver && !noAlivePlayers;

  elements.targetSelect.disabled = !questionAvailable;
  elements.questionInput.disabled = !questionAvailable;
  elements.askButton.textContent = pendingBrowserDisplayHandoff ? "Retry Display" : "Ask";
  elements.askButton.disabled = !questionAvailable || (!pendingBrowserDisplayHandoff && !elements.questionInput.value.trim());
  elements.voteButton.disabled = gameOver || canRunNight;
  elements.nightButton.disabled = gameOver || !canRunNight;
}

function setBusy(isBusy) {
  elements.askButton.textContent = pendingBrowserDisplayHandoff ? "Retry Display" : "Ask";
  elements.askButton.disabled = isBusy || (!pendingBrowserDisplayHandoff && !elements.questionInput.value.trim());
  elements.voteButton.disabled = isBusy || Boolean(snapshot?.winner) || canRunNight;
  elements.nightButton.disabled = isBusy || Boolean(snapshot?.winner) || !canRunNight;
}

function createEmptyState(text) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = text;
  return empty;
}

function nameFor(playerId) {
  return snapshot.players.find((player) => player.id === playerId)?.name ?? playerId ?? "none";
}

function formatPhase(phase) {
  return String(phase ?? "unknown").replaceAll("_", " ");
}

elements.questionInput.addEventListener("input", updateControls);
