export function containsAny(text, words) {
  const normalized = normalize(text);
  return words.some((word) => normalized.includes(normalize(word)));
}

export function extractMentionedPlayerIds(text, players) {
  const normalized = normalize(text);
  const matches = [];

  for (const player of players) {
    const labels = [player.id, player.name, ...(player.aliases ?? [])]
      .map((label) => normalize(label))
      .filter((label) => label.length > 0);
    let longest = 0;
    for (const label of labels) {
      if (label.length === 1) {
        // A one-character label (such as the alias "A") only counts when it
        // stands alone. Inside a longer word (the "a" in "hana") it is part
        // of that word, not a mention of this player. Non-letter characters
        // (Japanese kana, punctuation, spaces) act as boundaries, so a
        // standalone "Aはどう？" still matches.
        const pattern = new RegExp(`(?:^|[^a-z])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z])`);
        if (pattern.test(normalized)) {
          longest = Math.max(longest, 1);
        }
      } else if (normalized.includes(label)) {
        longest = Math.max(longest, label.length);
      }
    }
    if (longest > 0) {
      matches.push({ id: player.id, longest });
    }
  }

  // The most specific (longest) mention comes first, so callers that pick
  // the first mentioned player answer about the intended person. Ties keep
  // roster order (Array.prototype.sort is stable).
  matches.sort((a, b) => b.longest - a.longest);
  return [...new Set(matches.map((match) => match.id))];
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
