import test from "node:test";
import assert from "node:assert/strict";
import { validateNpcUtteranceStructure, MAX_NPC_UTTERANCE_CHARS } from "../src/utteranceGuard.mjs";

test("validateNpcUtteranceStructure: normal Japanese utterance accepted unchanged", () => {
  const text = "こんにちは、私は村人です。";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.normalizedText, text);
  assert.deepEqual(result.violations, []);
  assert.equal(result.metrics.characterCount, 13);
});

test("validateNpcUtteranceStructure: leading and trailing spaces trimmed", () => {
  const text = "  前後の空白を消してください  ";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.normalizedText, "前後の空白を消してください");
});

test("validateNpcUtteranceStructure: Unicode NFKC normalization", () => {
  const text = "ＡＢＣ１２３";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.normalizedText, "ABC123");
});

test("validateNpcUtteranceStructure: punctuation accepted", () => {
  const text = "！、。？…";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  // NFKC: ！ -> !, ？ -> ?, … -> ...
  assert.equal(result.normalizedText, "!、。?...");
});

test("validateNpcUtteranceStructure: non-string rejected", () => {
  const result = validateNpcUtteranceStructure(123);
  assert.equal(result.ok, false);
  assert.equal(result.normalizedText, null);
  assert.ok(result.violations.some(v => v.code === "not_a_string"));
});

test("validateNpcUtteranceStructure: empty rejected", () => {
  const result = validateNpcUtteranceStructure("");
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "empty_string"));
});

test("validateNpcUtteranceStructure: whitespace-only rejected", () => {
  const result = validateNpcUtteranceStructure("   ");
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "whitespace_only"));
});

test("validateNpcUtteranceStructure: exactly 240 emoji accepted", () => {
  const text = "🍎".repeat(MAX_NPC_UTTERANCE_CHARS);
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.metrics.characterCount, 240);
});

test("validateNpcUtteranceStructure: 241 emoji rejected", () => {
  const text = "🍎".repeat(MAX_NPC_UTTERANCE_CHARS + 1);
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "too_long"));
});

test("validateNpcUtteranceStructure: LF, CR, Tab rejected", () => {
  assert.equal(validateNpcUtteranceStructure("\nこんにちは").ok, false, "leading LF");
  assert.equal(validateNpcUtteranceStructure("こんにちは\r").ok, false, "trailing CR");
  assert.equal(validateNpcUtteranceStructure("こん\tにちは").ok, false, "internal tab");
});

test("validateNpcUtteranceStructure: Unicode line/paragraph separators rejected", () => {
  assert.equal(validateNpcUtteranceStructure("\u2028こんにちは").ok, false, "leading U+2028");
  assert.equal(validateNpcUtteranceStructure("こん\u2028にちは").ok, false, "middle U+2028");
  assert.equal(validateNpcUtteranceStructure("こんにちは\u2028").ok, false, "trailing U+2028");
  assert.equal(validateNpcUtteranceStructure("\u2029こんにちは").ok, false, "leading U+2029");
  assert.equal(validateNpcUtteranceStructure("こん\u2029にちは").ok, false, "middle U+2029");
  assert.equal(validateNpcUtteranceStructure("こんにちは\u2029").ok, false, "trailing U+2029");
  const result = validateNpcUtteranceStructure("\u2028");
  assert.ok(result.violations.some(v => v.code === "unicode_separator_not_allowed"));
});

test("validateNpcUtteranceStructure: invisible format characters rejected", () => {
  assert.equal(validateNpcUtteranceStructure("\u200B").ok, false, "only U+200B");
  assert.equal(validateNpcUtteranceStructure("\uFEFF").ok, false, "only U+FEFF");
  assert.equal(validateNpcUtteranceStructure("こん\u200Bにちは").ok, false, "mixed U+200B");
  assert.equal(validateNpcUtteranceStructure("こん\uFEFFにちは").ok, false, "mixed U+FEFF");
  const result = validateNpcUtteranceStructure("\u200B");
  assert.ok(result.violations.some(v => v.code === "invisible_character_not_allowed"));
});

test("validateNpcUtteranceStructure: bidi override rejected", () => {
  assert.equal(validateNpcUtteranceStructure("あいう\u202Aえお").ok, false);
});

test("validateNpcUtteranceStructure: HTML tag rejected but comparison allowed", () => {
  assert.equal(validateNpcUtteranceStructure("これは <b>太字</b> です。").ok, false, "HTML tag");
  assert.equal(validateNpcUtteranceStructure("<script>alert(1)</script>").ok, false, "script tag");
  assert.equal(validateNpcUtteranceStructure("2 < 3 かつ 3 > 1 です。").ok, true, "comparison");
});

test("validateNpcUtteranceStructure: JSON and Markdown rejected", () => {
  assert.equal(validateNpcUtteranceStructure('{"text": "hello"}').ok, false, "JSON object");
  assert.equal(validateNpcUtteranceStructure('["hello"]').ok, false, "JSON array");
  assert.equal(validateNpcUtteranceStructure("# 見出し").ok, false, "Heading");
  assert.equal(validateNpcUtteranceStructure("- リスト").ok, false, "List");
});

test("validateNpcUtteranceStructure: role prefix with whitespace bypasses rejected", () => {
  assert.equal(validateNpcUtteranceStructure("assistant: hello").ok, false);
  assert.equal(validateNpcUtteranceStructure("assistant : hello").ok, false);
  assert.equal(validateNpcUtteranceStructure("assistant　: hello").ok, false);
  assert.equal(validateNpcUtteranceStructure("system : hello").ok, false);
  assert.equal(validateNpcUtteranceStructure("user : hello").ok, false);
  assert.equal(validateNpcUtteranceStructure("回答: はい").ok, false);
  assert.equal(validateNpcUtteranceStructure("回答 ： はい").ok, false);
  assert.equal(validateNpcUtteranceStructure("応答 : はい").ok, false);
  assert.equal(validateNpcUtteranceStructure("発言　: はい").ok, false);
});

test("validateNpcUtteranceStructure: specific stage directions rejected at boundaries", () => {
  assert.equal(validateNpcUtteranceStructure("(笑う)").ok, false);
  assert.equal(validateNpcUtteranceStructure("[考え込む]").ok, false);
  assert.equal(validateNpcUtteranceStructure("*ため息をつく*").ok, false);
  assert.equal(validateNpcUtteranceStructure("(笑う)こんにちは").ok, false);
  assert.equal(validateNpcUtteranceStructure("こんにちは(笑う)").ok, false);
});

test("validateNpcUtteranceStructure: ordinary parentheticals at boundaries accepted", () => {
  assert.equal(validateNpcUtteranceStructure("(1回目)の投票を確認したいです。").ok, true);
  assert.equal(validateNpcUtteranceStructure("これは暫定です(参考)").ok, true);
  assert.equal(validateNpcUtteranceStructure("(補足)これはまだ仮説です。").ok, true);
  assert.equal(validateNpcUtteranceStructure("この判断は確定ではありません(暫定)。").ok, true);
  assert.equal(validateNpcUtteranceStructure("昨日の投票(1回目)を確認したいです。").ok, true);
});

test("validateNpcUtteranceStructure: ordinary leading/trailing spaces remain trimmable", () => {
  const text = "　こんにちは　";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.normalizedText, "こんにちは");
});
