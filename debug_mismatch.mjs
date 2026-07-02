import { normalize } from "./src/textUtils.mjs";

const text = "Beniは人狼ではありません。";
const normalized = normalize(text);
const targetName = normalize("Beni");

const pattern = targetName + "は人狼ではない";
const pattern2 = targetName + "は人狼ではな";

console.log(`text: "${text}"`);
console.log(`normalized: "${normalized}"`);
console.log(`normalized slice: "${normalized.slice(0, pattern.length)}"`);
console.log(`pattern: "${pattern}"`);
console.log(`pattern.length: ${pattern.length}`);
console.log(`normalized.length: ${normalized.length}`);

for (let i = 0; i < Math.min(pattern.length, normalized.length); i++) {
    if (pattern[i] !== normalized[i]) {
        console.log(`Mismatch at index ${i}: pattern='${pattern[i]}' (${pattern.charCodeAt(i)}), normalized='${normalized[i]}' (${normalized.charCodeAt(i)})`);
    }
}
