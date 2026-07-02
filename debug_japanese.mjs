import { normalize } from "./src/textUtils.mjs";

const text = "Beniは人狼ではありません。";
const normalized = normalize(text);
const targetName = normalize("Beni");
const pattern = targetName + "は人狼ではない";

console.log(`text: "${text}"`);
console.log(`normalized: "${normalized}"`);
console.log(`targetName: "${targetName}"`);
console.log(`pattern: "${pattern}"`);
console.log(`includes: ${normalized.includes(pattern)}`);
