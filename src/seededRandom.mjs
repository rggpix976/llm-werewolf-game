export class SeededRandom {
  constructor(seed = Date.now()) {
    this.state = normalizeSeed(seed);
  }

  next() {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  int(maxExclusive) {
    if (maxExclusive <= 0) {
      throw new Error("maxExclusive must be positive");
    }
    return Math.floor(this.next() * maxExclusive);
  }

  choice(items) {
    if (!items.length) {
      return undefined;
    }
    return items[this.int(items.length)];
  }

  shuffle(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}

function normalizeSeed(seed) {
  if (Number.isInteger(seed)) {
    return seed >>> 0;
  }

  const text = String(seed);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
