// Builds the downloadable text export of a game: the player-facing log and
// votes, plus — only when developer diagnostics are supplied (Developer Mode
// on) — the developer snapshot (roles and internal state) and event log.
// This is a one-way export for the player's own records; it does not persist
// or restore a session (see D-009 and D-017).

export function buildGameLogFilename(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `werewolf-log-${stamp}.txt`;
}

export function buildGameLogExport({ exportedAt, snapshot, playerLogText, developerSnapshot = null, developerLogText = null }) {
  const lines = [];
  lines.push("LLM Werewolf — Game Log Export");
  lines.push(`Exported: ${exportedAt.toISOString()}`);
  lines.push(`Day: ${snapshot.day} / Phase: ${snapshot.phase} / Winner: ${snapshot.winner || "none"}`);
  const roster = snapshot.players
    .map((player) => `${player.name} (${player.alive ? "alive" : "dead"})`)
    .join(", ");
  lines.push(`Players: ${roster}`);
  lines.push("");
  lines.push("== Player Log ==");
  lines.push(playerLogText || "");
  lines.push("");
  lines.push("== Votes ==");
  if (!snapshot.voteHistory?.length) {
    lines.push("(no votes yet)");
  }
  for (const round of snapshot.voteHistory ?? []) {
    const executed = round.executedId
      ? snapshot.players.find((player) => player.id === round.executedId)?.name ?? round.executedId
      : "none";
    lines.push(`Day ${round.day} / Executed: ${executed}`);
    lines.push(round.votes.map((vote) => `${vote.voterName} -> ${vote.targetName}`).join(", "));
  }

  if (developerSnapshot) {
    lines.push("");
    lines.push("== Developer Snapshot ==");
    for (const player of developerSnapshot.players) {
      lines.push(`${player.name} (${player.id}): role=${player.role} team=${player.team} alive=${player.alive}`);
      for (const field of ["knownInfo", "hiddenInfo", "suspicionScores", "publicClaims", "privateMemory", "voteHistory", "conversationPolicy"]) {
        lines.push(`  ${field}: ${JSON.stringify(player[field] ?? null)}`);
      }
    }
  }

  if (developerLogText) {
    lines.push("");
    lines.push("== Developer Event Log ==");
    lines.push(developerLogText);
  }

  return `${lines.join("\n")}\n`;
}
