import { ROLES, TEAMS } from "./constants.mjs";

export function auditGameState(state) {
  const findings = [];

  const deadNpcBlocked = state.developerLog.some((entry) => entry.kind === "dead_npc_blocked");
  findings.push({
    check: "死亡者が発言していない",
    ok: deadNpcBlocked && noDeadNpcResponseAfterDeath(state),
    detail: deadNpcBlocked ? "死亡NPCへの質問はブロックされました。" : "死亡NPCへの質問ケースは未実行です。"
  });

  const responseLogs = state.developerLog.filter((entry) => entry.kind === "npc_response_generated");
  findings.push({
    check: "NPCが知らない情報を話していない",
    ok: responseLogs.every((entry) => Array.isArray(entry.detail.evidenceUsed)),
    detail: "各応答ログに evidenceUsed と promptPreview を保存しています。"
  });

  const wolf = state.players.find((player) => player.role === ROLES.WEREWOLF);
  const wolfResponses = responseLogs.filter((entry) => entry.detail.npcId === wolf?.id);
  findings.push({
    check: "人狼が自分の正体を不用意に漏らしていない",
    ok: wolfResponses.every((entry) => !entry.detail.response.includes("私は人狼です")),
    detail: `${wolf?.name ?? "unknown"}の応答件数: ${wolfResponses.length}`
  });

  const seer = state.players.find((player) => player.role === ROLES.SEER);
  const seerResults = seer?.knownInfo.filter((info) => info.type === "seer_result") ?? [];
  findings.push({
    check: "占い結果が占い師の内部情報として保存されている",
    ok: seerResults.length > 0 && !state.publicInfo.some((info) => info.type === "seer_action"),
    detail: `seer=${seer?.name ?? "unknown"}, knownInfo.seer_result=${seerResults.length}`
  });

  const latestVote = state.voteHistory.at(-1);
  findings.push({
    check: "投票と処刑が正しく処理されている",
    ok: state.voteHistory.length > 0 && latestVote && state.deadPlayers.includes(latestVote.executedId),
    detail: `voteRounds=${state.voteHistory.length}, latestExecuted=${latestVote?.executedId ?? "none"}`
  });

  findings.push({
    check: "勝敗判定が正しい",
    ok: isWinnerConsistent(state),
    detail: `winner=${state.winner ?? "none"}`
  });

  return findings;
}

export function formatAudit(findings) {
  return findings.map((finding) => {
    return `${finding.ok ? "OK" : "NG"} ${finding.check}: ${finding.detail}`;
  }).join("\n");
}

function noDeadNpcResponseAfterDeath(state) {
  const deathDayById = new Map();
  for (const player of state.players) {
    const death = player.privateMemory.find((memory) => memory.type === "death");
    if (death) {
      deathDayById.set(player.id, death.day);
    }
  }

  return state.developerLog
    .filter((entry) => entry.kind === "npc_response_generated")
    .every((entry) => {
      const deathDay = deathDayById.get(entry.detail.npcId);
      return deathDay === undefined || entry.day < deathDay;
    });
}

function isWinnerConsistent(state) {
  if (!state.winner) {
    return true;
  }

  const alive = state.players.filter((player) => player.alive);
  const werewolfCount = alive.filter((player) => player.team === TEAMS.WEREWOLF).length;
  const villageCount = alive.filter((player) => player.team === TEAMS.VILLAGE).length;

  if (state.winner === TEAMS.VILLAGE) {
    return werewolfCount === 0;
  }

  if (state.winner === TEAMS.WEREWOLF) {
    return werewolfCount >= villageCount;
  }

  return false;
}
