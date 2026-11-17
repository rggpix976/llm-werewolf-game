// The source of strategy preferences is deliberately confined to this accessor.
export function strategyLeanFor(npc) {
  return npc.strategyLean ?? "neutral";
}

export function strategySideFor(player, gameState) {
  if (player.publicClaims.length > 0) return "roller";
  const blacked = gameState.players.some((claimant) => claimant.publicClaims.some((claim) =>
    ["seer", "medium"].includes(claim.role) && (claim.results ?? []).some((result) =>
      result.targetId === player.id && result.result === "werewolf")));
  return blacked ? null : "gray";
}

export function chooseTopSuspect(npc, gameState) {
  const ranked = gameState.players
    .filter((player) => player.alive && player.id !== npc.id)
    .map((player) => ({ id: player.id, player, score: npc.suspicionScores[player.id] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.player.name.localeCompare(b.player.name));
  const top = ranked[0] ?? null;
  if (!top || gameState.config.scenario !== "village9") return top;
  const lean = strategyLeanFor(npc);
  const side = strategySideFor(top.player, gameState);
  if (lean === "neutral" || !side || side === lean) return top;
  const preferred = ranked.find(({ player }) => strategySideFor(player, gameState) === lean);
  return preferred && top.score - preferred.score <= 4 ? preferred : top;
}

export function strategyProposalFor(input) {
  const roller = /ローラー|両方(?:を)?吊る|CO者から吊る/i.test(input);
  const gray = /グレー/.test(input)
    || (/(?:CO者|占い師|霊媒師|騎士)/i.test(input) && /ほっとく|放置/.test(input));
  return roller === gray ? null : roller ? "roller" : "gray";
}

export function strategyReply(npc, gameState, proposal, top) {
  const agrees = strategyLeanFor(npc) === proposal || strategySideFor(top.player, gameState) === proposal;
  const policy = proposal === "gray" ? "グレーから詰める方針" : "CO者から吊る方針";
  return `${policy}には${agrees ? "賛成" : "反対"}です。今日は${top.player.name}に投票したいです。`;
}
