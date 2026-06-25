import { WerewolfGame } from "../src/gameEngine.mjs";

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
  voteList: document.querySelector("#voteList")
};

let game;
let snapshot;
let logCursor = 0;
let canRunNight = false;

startNewGame();

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
  canRunNight = !action.publicSnapshot.winner;
  render(action.publicSnapshot);
});

elements.nightButton.addEventListener("click", async () => {
  if (!canRunNight || snapshot.winner) {
    return;
  }

  canRunNight = false;
  const action = await dispatch({ type: "run_night" });
  render(action.publicSnapshot);
});

function startNewGame() {
  game = WerewolfGame.create({
    seed: Date.now(),
    shuffleRoles: true
  });
  snapshot = game.getPublicSnapshot();
  logCursor = snapshot.playerLog.length;
  canRunNight = false;
  render(snapshot);
}

async function dispatch(action) {
  setBusy(true);
  try {
    const result = await game.dispatchPlayerAction({
      ...action,
      logCursor
    });
    logCursor = result.nextLogCursor;
    render(result.publicSnapshot);
    return result;
  } finally {
    setBusy(false);
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

function renderStatus() {
  const winner = snapshot.winner ? ` / Winner: ${snapshot.winner}` : "";
  elements.statusLine.textContent = `Day ${snapshot.day} / ${formatPhase(snapshot.phase)}${winner}`;
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
