import test from "node:test";
import assert from "node:assert/strict";
import { validateNpcUtteranceStructure, MAX_NPC_UTTERANCE_CHARS } from "../src/utteranceGuard.mjs";

test("validateNpcUtteranceStructure: normal Japanese utterance accepted unchanged", () => {
  const text = "こんにちは、私は村人です。";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.normalizedText, text);
  assert.deepEqual(result.violations, []);
  assert.equal(result.metrics.characterCount, text.length);
});

test("validateNpcUtteranceStructure: leading and trailing spaces trimmed", () => {
  const text = "  前後の空白を消してください  ";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.normalizedText, "前後の空白を消してください");
});

test("validateNpcUtteranceStructure: Unicode NFKC normalization", () => {
  // Full-width alphanumeric to half-width, etc.
  const text = "ＡＢＣ１２３";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.normalizedText, "ABC123");
});

test("validateNpcUtteranceStructure: punctuation accepted", () => {
  const text = "！、。？…";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  // Note: NFKC normalizes full-width ！ and ？ to half-width ! and ?
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
  assert.ok(result.violations.some(v => v.code === "whitespace_only" || v.code === "empty_after_normalization"));
});

test("validateNpcUtteranceStructure: exactly 240 characters accepted", () => {
  const text = "あ".repeat(MAX_NPC_UTTERANCE_CHARS);
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.metrics.characterCount, 240);
});

test("validateNpcUtteranceStructure: 241 characters rejected", () => {
  const text = "あ".repeat(MAX_NPC_UTTERANCE_CHARS + 1);
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "too_long"));
});

test("validateNpcUtteranceStructure: LF rejected", () => {
  const text = "一行目\n二行目";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "line_feed_not_allowed"));
});

test("validateNpcUtteranceStructure: CRLF rejected", () => {
  const text = "一行目\r\n二行目";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "line_feed_not_allowed" || v.code === "carriage_return_not_allowed"));
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

test("validateNpcUtteranceStructure: script markup rejected", () => {
  const text = "<script>alert(1)</script>";
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

test("validateNpcUtteranceStructure: unordered list rejected", () => {
  const text = "- アイテム1";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "markdown_list_not_allowed"));
});

test("validateNpcUtteranceStructure: ordered list rejected", () => {
  const text = "1. アイテム1";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "markdown_list_not_allowed"));
});

test("validateNpcUtteranceStructure: assistant prefix rejected", () => {
  const text = "assistant: こんにちは";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "role_prefix_not_allowed"));
});

test("validateNpcUtteranceStructure: system prefix rejected", () => {
  const text = "system: 設定します";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "role_prefix_not_allowed"));
});

test("validateNpcUtteranceStructure: user prefix rejected", () => {
  const text = "user: 質問です";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "role_prefix_not_allowed"));
});

test("validateNpcUtteranceStructure: explanatory preface rejected", () => {
  const text = "回答: はい、そうです。";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "explanatory_preface_not_allowed"));
});

test("validateNpcUtteranceStructure: parenthesized stage direction rejected", () => {
  const text = "それは困りました（笑う）";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "stage_direction_not_allowed"));
});

test("validateNpcUtteranceStructure: bracketed stage direction rejected", () => {
  const text = "どうしましょうか [考え込む]";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "stage_direction_not_allowed"));
});

test("validateNpcUtteranceStructure: asterisk stage direction rejected", () => {
  const text = "*ため息をつく* わかりました。";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "stage_direction_not_allowed"));
});

test("validateNpcUtteranceStructure: rejected text absent from the serialized validation result", () => {
  const badText = "落とし穴 <script>alert(1)</script>";
  const result = validateNpcUtteranceStructure(badText);
  assert.equal(result.ok, false);
  assert.equal(result.normalizedText, null);

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("<script>"));
  assert.ok(!serialized.includes("alert(1)"));
});

test("validateNpcUtteranceStructure: violation objects contain only documented safe fields", () => {
  const text = "回答: はい [笑]";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, false);
  assert.ok(result.violations.length > 0);
  for (const violation of result.violations) {
    const keys = Object.keys(violation);
    assert.deepEqual(keys, ["code"]);
  }
});
