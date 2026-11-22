// Read only public claims, public death records, and the scenario's public count.
function resultsFor(player, role) {
  return player.publicClaims.filter((claim) => claim.role === role)
    .flatMap((claim) => claim.results ?? []);
}

export function contestedClaimGroups(state) {
  return ["seer", "medium"].flatMap((role) => {
    const claimants = state.players.filter((p) => p.alive && p.publicClaims.some((c) => c.role === role));
    if (claimants.length < 2) return [];
    const targets = new Map();
    for (const claimant of claimants) {
      for (const { targetId, result } of resultsFor(claimant, role)) {
        if (!["werewolf", "not_werewolf"].includes(result)) continue;
        if (!targets.has(targetId)) targets.set(targetId, {});
        targets.get(targetId)[claimant.id] = result;
      }
    }
    const conflicts = [...targets].filter(([, results]) => new Set(Object.values(results)).size > 1)
      .map(([targetId, resultsByClaimant]) => ({ targetId, resultsByClaimant }));
    return conflicts.length ? [{ role, claimantIds: claimants.map((p) => p.id), conflicts }] : [];
  });
}

export function boardDigestFor(state, group) {
  const executions = state.publicInfo.filter((info) => info.type === "execution");
  const totalWolves = state.config.scenario === "village9" ? 2 : 1;
  return {
    role: group.role,
    claimants: group.claimantIds.map((id) => {
      const claimant = state.players.find((p) => p.id === id);
      const results = resultsFor(claimant, group.role);
      const bankedBlacks = new Set(results.filter((r) => r.result === "werewolf").map((r) => r.targetId)).size;
      return {
        claimantId: id, claimantName: claimant.name,
        publishedResults: results.map(({ targetId, result }) => {
          const target = state.players.find((p) => p.id === targetId);
          const execution = executions.find((info) => info.targetId === targetId);
          const nightKilled = state.publicInfo.some((info) => info.type === "night_death" && info.targetId === targetId);
          return { targetId, targetName: target?.name ?? targetId, result,
            targetStatus: execution ? "executed" : nightKilled ? "night_killed" : target?.alive ? "alive" : "other",
            ...(execution ? { day: execution.day } : {}) };
        }),
        bankedBlacks, wolvesRemainingIfGenuine: Math.max(0, totalWolves - bankedBlacks),
        ...(group.role === "medium" ? { unpublishedExecutions: new Set(executions
          .filter((info) => !results.some((r) => r.targetId === info.targetId)).map((info) => info.targetId)).size } : {})
      };
    })
  };
}
