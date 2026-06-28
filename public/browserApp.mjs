import { WerewolfGame } from "../src/gameEngine.mjs";
import { HttpResponseProvider, SessionManager } from "./httpResponseProvider.mjs";
import { PseudoResponseProvider } from "../src/responseProvider.mjs";

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
    refreshDiagnostics();
  } else {
    elements.developerPanel.replaceChildren();
  }
});

elements.newGameButton.addEventListener("click", () => {
  startNewGame();
});

elements.askForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = elements.targetSelect.value;
  const input = elements.questionInput.value.trim();
  if (!target || !input || snapshot.winner) {
    return;
  }

  await dispatch({
    type: "ask_npc",
    target,
    input
  });
  elements.questionInput.value = "";
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
  currentGameId = sessionManager.startNewGame();

  let responseProvider;
  if (runtimeConfig.provider === "openai") {
    responseProvider = new HttpResponseProvider({
      model: runtimeConfig.model,
      sessionManager
    });
  } else {
    responseProvider = new PseudoResponseProvider();
  }

  game = WerewolfGame.create({
    seed: Date.now(),
    shuffleRoles: true,
    responseProvider
  });
  snapshot = game.getPublicSnapshot();
  logCursor = snapshot.playerLog.length;
  devLogCursor = 0;
  devLogEntries = [];
  devLogFilterKind = "";
  devLogFilterNpc = "";
  canRunNight = false;
  render(snapshot);
  if (isDevMode) {
    refreshDiagnostics();
  }
}

async function dispatch(action) {
  const gameIdAtStart = currentGameId;
  setBusy(true);
  try {
    const result = await game.dispatchPlayerAction({
      ...action,
      logCursor
    });

    if (!sessionManager.isCurrentGame(gameIdAtStart)) {
      return null;
    }

    logCursor = result.nextLogCursor;
    render(result.publicSnapshot);
    if (isDevMode) {
      refreshDiagnostics();
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

function renderDeveloperPanel(devSnapshot) {
  elements.developerPanel.replaceChildren();

  elements.developerPanel.append(
    renderDevSummary(devSnapshot),
    renderNpcInternalStates(devSnapshot),
    renderDevEventLog(),
    renderResponseDiagnostics()
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
    refreshDiagnostics();
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
    refreshDiagnostics();
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
      card.append(createDevLabel("evidenceUsed"), createDevDetails(entry.detail.evidenceUsed));
      card.append(createDevLabel("promptPreview"), createDevDetails(entry.detail.promptPreview));
    }

    grid.append(card);
  }

  section.append(title, grid);
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
  if (!snapshot.playerLog.length) {
    elements.logList.replaceChildren(createEmptyState("No log entries"));
    return;
  }

  elements.logList.replaceChildren(
    ...snapshot.playerLog.map((entry) => {
      const row = document.createElement("div");
      row.className = "log-entry";

      const meta = document.createElement("div");
      meta.className = "log-meta";
      meta.textContent = `Day ${entry.day} / ${formatPhase(entry.phase)}`;

      const message = document.createElement("div");
      message.className = "log-message";
      message.textContent = entry.message;

      row.append(meta, message);
      return row;
    })
  );
  elements.logList.scrollTop = elements.logList.scrollHeight;
}

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
  elements.askButton.disabled = !questionAvailable || !elements.questionInput.value.trim();
  elements.voteButton.disabled = gameOver || canRunNight;
  elements.nightButton.disabled = gameOver || !canRunNight;
}

function setBusy(isBusy) {
  elements.askButton.disabled = isBusy || !elements.questionInput.value.trim();
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
