import test from "node:test";
import assert from "node:assert/strict";
import { PseudoResponseProvider, validateProviderResponse } from "../src/responseProvider.mjs";
import { MAX_NPC_UTTERANCE_CHARS } from "../src/utteranceGuard.mjs";

test("validateProviderResponse: normal Japanese utterance accepted unchanged", () => {
  const result = validateProviderResponse({ text: "私は人狼ではありません。発言と投票で見てください。" });
  assert.equal(result.text, "私は人狼ではありません。発言と投票で見てください。");
  assert.equal(result.providerName, "unknown");
});

test("validateProviderResponse: accepted text is the guard-normalized text", () => {
  const result = validateProviderResponse({ text: "  こんにちは。ＡＢＣ  " });
  assert.equal(result.text, "こんにちは。ABC");
});

test("validateProviderResponse: non-object and empty text keep the legacy errors", () => {
  assert.throws(() => validateProviderResponse(null), /must return an object/);
  assert.throws(() => validateProviderResponse("text"), /must return an object/);
  assert.throws(() => validateProviderResponse({ text: "" }), /returned empty text/);
  assert.throws(() => validateProviderResponse({ text: "   " }), /returned empty text/);
  assert.throws(() => validateProviderResponse({ text: 123 }), /returned empty text/);
});

test("validateProviderResponse: line breaks in generated text rejected with violation codes", () => {
  assert.throws(
    () => validateProviderResponse({ text: "一行目です。\n二行目です。" }),
    /invalid utterance structure: .*line_feed_not_allowed/
  );
});

test("validateProviderResponse: JSON and markdown wrappers rejected with violation codes", () => {
  assert.throws(
    () => validateProviderResponse({ text: "{\"text\":\"はい\"}" }),
    /invalid utterance structure: .*json_object_not_allowed/
  );
  assert.throws(
    () => validateProviderResponse({ text: "```\nはい\n```" }),
    /invalid utterance structure: .*markdown_code_fence_not_allowed/
  );
});

test("validateProviderResponse: role prefixes rejected with violation codes", () => {
  assert.throws(
    () => validateProviderResponse({ text: "assistant: はい、そうです。" }),
    /invalid utterance structure: .*role_prefix_not_allowed/
  );
});

test("validateProviderResponse: markup literals stay displayable but markup plus a form violation is rejected", () => {
  // Display paths neutralize markup (textContent in the browser, the CLI
  // terminal sanitizer), so markup alone is not an acceptance failure.
  const accepted = validateProviderResponse({ text: "<b>文字どおりのテキスト</b>" });
  assert.equal(accepted.text, "<b>文字どおりのテキスト</b>");
  assert.throws(
    () => validateProviderResponse({ text: "<b>はい</b>\n次の行" }),
    /invalid utterance structure: .*line_feed_not_allowed/
  );
});

test("validateProviderResponse: utterances over the character limit rejected as too_long", () => {
  const tooLong = "あ".repeat(MAX_NPC_UTTERANCE_CHARS + 1);
  assert.throws(
    () => validateProviderResponse({ text: tooLong }),
    /invalid utterance structure: .*too_long/
  );
  const atLimit = "あ".repeat(MAX_NPC_UTTERANCE_CHARS);
  assert.equal(validateProviderResponse({ text: atLimit }).text, atLimit);
});

test("validateProviderResponse: provider metadata normalization is unchanged", () => {
  const result = validateProviderResponse({
    text: "様子を見たいです。",
    providerName: " openai ",
    model: "gpt-test",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    notes: ["ok", 42, "kept"]
  }, "fallback-name");
  assert.equal(result.providerName, "openai");
  assert.equal(result.model, "gpt-test");
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.deepEqual(result.notes, ["ok", "kept"]);
});

test("validateProviderResponse: pseudo provider output passes structural validation", async () => {
  const provider = new PseudoResponseProvider();
  const raw = await provider.generateResponse({
    responsePlan: {
      speechStyle: "calm",
      baseText: "今出ている材料だけだと、まだ断定はできません。少し気になるのはタロウです。"
    }
  });
  const validated = validateProviderResponse(raw, provider.name);
  assert.equal(validated.text, raw.text);
});
