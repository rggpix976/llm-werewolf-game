export function containsAny(text, words) {
  const normalized = normalize(text);
  return words.some((word) => normalized.includes(normalize(word)));
}

export function extractMentionedPlayerIds(text, players) {
  const normalized = normalize(text);
  const matches = [];

  for (const player of players) {
    const labels = [player.id, player.name, ...(player.aliases ?? [])];
    if (labels.some((label) => normalized.includes(normalize(label)))) {
      matches.push(player.id);
    }
  }

  return [...new Set(matches)];
}

export function normalize(text) {
  return String(text ?? "").trim().toLowerCase();
}

export function formatList(items) {
  if (items.length === 0) {
    return "なし";
  }
  return items.join("、");
}
