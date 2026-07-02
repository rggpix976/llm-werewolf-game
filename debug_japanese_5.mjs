import { normalize } from "./src/textUtils.mjs";

const text = "Beniは人狼ではありません。";
const normalized = normalize(text);
const targetName = normalize("Beni");

const patterns = [
  targetName + "は人狼ではない",
  targetName + "は人狼じゃない",
  targetName + "は人狼ではな",
  targetName + "は人狼でな",
  targetName + "は人狼じゃな",
  "人狼ではない",
  "人狼ではありません"
];

console.log(`text: "${text}"`);
console.log(`normalized: "${normalized}"`);

for (const p of patterns) {
    console.log(`pattern: "${p}", includes: ${normalized.includes(p)}`);
}
