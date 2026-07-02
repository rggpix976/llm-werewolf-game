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

test("validateNpcUtteranceStructure: leading/trailing/internal LF rejected", () => {
  assert.equal(validateNpcUtteranceStructure("\nこんにちは").ok, false, "leading LF");
  assert.equal(validateNpcUtteranceStructure("こんにちは\n").ok, false, "trailing LF");
  assert.equal(validateNpcUtteranceStructure("こん\nにちは").ok, false, "internal LF");
  assert.ok(validateNpcUtteranceStructure("\n").violations.some(v => v.code === "line_feed_not_allowed"));
});

test("validateNpcUtteranceStructure: leading/trailing/internal CR rejected", () => {
  assert.equal(validateNpcUtteranceStructure("\rこんにちは").ok, false, "leading CR");
  assert.equal(validateNpcUtteranceStructure("こんにちは\r").ok, false, "trailing CR");
  assert.equal(validateNpcUtteranceStructure("こん\rにちは").ok, false, "internal CR");
  assert.ok(validateNpcUtteranceStructure("\r").violations.some(v => v.code === "carriage_return_not_allowed"));
});

test("validateNpcUtteranceStructure: leading/trailing/internal Tab rejected", () => {
  assert.equal(validateNpcUtteranceStructure("\tこんにちは").ok, false, "leading tab");
  assert.equal(validateNpcUtteranceStructure("こんにちは\t").ok, false, "trailing tab");
  assert.equal(validateNpcUtteranceStructure("こん\tにちは").ok, false, "internal tab");
  assert.ok(validateNpcUtteranceStructure("\t").violations.some(v => v.code === "tab_not_allowed"));
});

test("validateNpcUtteranceStructure: control character rejected", () => {
  const text = "あいう\x00えお";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "control_characters_not_allowed"));
});

test("validateNpcUtteranceStructure: bidi override rejected", () => {
  const text = "あいう\u202Aえお";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "bidi_characters_not_allowed"));
});

test("validateNpcUtteranceStructure: code fence rejected", () => {
  const text = "```javascript\nconsole.log(1);\n```";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "markdown_code_fence_not_allowed"));
});

test("validateNpcUtteranceStructure: HTML tag rejected", () => {
  const text = "これは <b>太字</b> です。";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "html_markup_not_allowed"));
});

test("validateNpcUtteranceStructure: JSON object wrapper rejected", () => {
  const text = '{"text": "hello"}';
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "json_object_not_allowed"));
});

test("validateNpcUtteranceStructure: JSON array wrapper rejected", () => {
  const text = '["hello", "world"]';
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "json_array_not_allowed"));
});

test("validateNpcUtteranceStructure: Markdown heading rejected", () => {
  const text = "# 見出し";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "markdown_heading_not_allowed"));
});

test("validateNpcUtteranceStructure: Markdown list rejected", () => {
  assert.equal(validateNpcUtteranceStructure("- アイテム").ok, false);
  assert.equal(validateNpcUtteranceStructure("1. アイテム").ok, false);
});

test("validateNpcUtteranceStructure: role prefix rejected", () => {
  assert.equal(validateNpcUtteranceStructure("assistant: hello").ok, false);
  assert.equal(validateNpcUtteranceStructure("system: hello").ok, false);
  assert.equal(validateNpcUtteranceStructure("user: hello").ok, false);
});

test("validateNpcUtteranceStructure: explanatory preface rejected", () => {
  assert.equal(validateNpcUtteranceStructure("回答: はい").ok, false);
});

test("validateNpcUtteranceStructure: stage direction wrappers rejected", () => {
  assert.equal(validateNpcUtteranceStructure("（笑う）").ok, false);
  assert.equal(validateNpcUtteranceStructure("(笑う)").ok, false);
  assert.equal(validateNpcUtteranceStructure("[考え込む]").ok, false);
  assert.equal(validateNpcUtteranceStructure("*ため息をつく*").ok, false);
  assert.equal(validateNpcUtteranceStructure("（笑う）こんにちは").ok, false);
  assert.equal(validateNpcUtteranceStructure("こんにちは（笑う）").ok, false);
});

test("validateNpcUtteranceStructure: internal parentheses accepted", () => {
  const text1 = "昨日の投票（1回目）を確認したいです。";
  const res1 = validateNpcUtteranceStructure(text1);
  assert.equal(res1.ok, true);
  // NFKC normalizes （ ） to ( )
  assert.equal(res1.normalizedText, "昨日の投票(1回目)を確認したいです。");

  const text2 = "Aoi（占い師を名乗った人）の発言を確認します。";
  const res2 = validateNpcUtteranceStructure(text2);
  assert.equal(res2.ok, true);
});

test("validateNpcUtteranceStructure: rejected text absent from results", () => {
  const badText = "落とし穴 <script>alert(1)</script>";
  const result = validateNpcUtteranceStructure(badText);
  assert.equal(result.ok, false);
  assert.equal(result.normalizedText, null);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("<script>"));
});

test("validateNpcUtteranceStructure: violation objects contain only code", () => {
  const result = validateNpcUtteranceStructure("回答: はい [笑]");
  assert.equal(result.ok, false);
  for (const violation of result.violations) {
    assert.deepEqual(Object.keys(violation), ["code"]);
  }
});

test("validateNpcUtteranceStructure: ordinary leading/trailing spaces remain safely trimmable", () => {
  const text = "　こんにちは　"; // Full-width spaces
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.normalizedText, "こんにちは");
  assert.equal(result.metrics.characterCount, 5);
});
