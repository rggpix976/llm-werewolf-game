import { normalize } from "./src/textUtils.mjs";

const text = "Beniは人狼ではありません。";
const normalized = normalize(text);
const targetName = normalize("Beni");

const patterns = [
  targetName + "は人狼ではな",
  targetName + "は人狼ではない",
];

console.log(`text: "${text}"`);
console.log(`normalized: "${normalized}"`);
console.log(`targetName: "${targetName}"`);

for (const p of patterns) {
  console.log(`pattern: "${p}", includes: ${normalized.includes(p)}`);
}
