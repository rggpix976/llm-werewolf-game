import { normalize } from "./src/textUtils.mjs";

const text = "Beniは人狼ではありません。";
const normalized = normalize(text);
const targetName = normalize("Beni");

const pattern = targetName + "は人狼ではな";

console.log(`text: "${text}"`);
console.log(`normalized: "${normalized}"`);
console.log(`pattern: "${pattern}"`);
console.log(`includes: ${normalized.includes(pattern)}`);

for (let i = 0; i < normalized.length; i++) {
    console.log(`${i}: ${normalized[i]} (${normalized.charCodeAt(i)})`);
}

for (let i = 0; i < pattern.length; i++) {
    console.log(`P${i}: ${pattern[i]} (${pattern.charCodeAt(i)})`);
}
