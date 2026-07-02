import { normalize } from "./src/textUtils.mjs";

const text = "Beniは人狼ではありません。";
const normalized = normalize(text);

for (let i = 0; i < normalized.length; i++) {
  console.log(`${i}: ${normalized[i]} (${normalized.charCodeAt(i)})`);
}
