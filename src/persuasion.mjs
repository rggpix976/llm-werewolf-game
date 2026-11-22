import { containsAny, extractMentionedPlayerIds } from "./textUtils.mjs";

export function assertionFor(text, players) {
  const ids = extractMentionedPlayerIds(text, players);
  if (ids.length !== 1) return null;
  const white = containsAny(text, ["確白", "白い", "白っぽい", "吊るな", "吊らない", "信じて", "味方", "村人だ", "無実"]);
  const black = containsAny(text, ["確黒", "破綻", "吊ろう", "吊るべき", "黒い"]);
  return white === black ? null : { targetId: ids[0], direction: white ? "white" : "black" };
}

export function persuasionShiftFor(direction, sourceKind) {
  return sourceKind === "npc" ? 1 : direction === "white" ? -2 : 2;
}
