import test from "node:test";
import assert from "node:assert/strict";
import {
  validateNpcUtteranceStructure,
  validateNpcUtteranceRoleAndSecrecy,
} from "../src/utteranceGuard.mjs";

/**
 * UTTERANCE GUARD TESTS
 *
 * This file contains:
 * 1. Structural validation tests (19 blocks, baseline)
 * 2. Role and Secrecy validation tests (18 blocks, new)
 */

test("validateNpcUtteranceStructure: normal Japanese utterance accepted unchanged", () => {
  const text = "こんにちは、私は村人です。";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.normalizedText, text);
  assert.deepEqual(result.violations, []);
  assert.equal(result.metrics.characterCount, 13);
});

test("validateNpcUtteranceStructure: ordinary leading/trailing spaces trimmable but internal preserved", () => {
  const text = " 　こんにちは 私は 市民です。 　";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.normalizedText, "こんにちは 私は 市民です。");
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
  assert.equal(result.normalizedText, "!、。?...");
});

test("validateNpcUtteranceStructure: non-string rejected", () => {
  const result = validateNpcUtteranceStructure(123);
  assert.equal(result.ok, false);
  assert.equal(result.normalizedText, null);
  assert.ok(result.violations.some(v => v.code === "not_a_string"));
});

test("validateNpcUtteranceStructure: empty or whitespace-only rejected", () => {
  assert.equal(validateNpcUtteranceStructure("").ok, false, "empty");
  assert.ok(validateNpcUtteranceStructure("").violations.some(v => v.code === "empty_string"));

  assert.equal(validateNpcUtteranceStructure("   ").ok, false, "ASCII whitespace");
  assert.ok(validateNpcUtteranceStructure("   ").violations.some(v => v.code === "whitespace_only"));

  assert.equal(validateNpcUtteranceStructure("　").ok, false, "ideographic space");
  assert.ok(validateNpcUtteranceStructure("　").violations.some(v => v.code === "whitespace_only"));

  assert.equal(validateNpcUtteranceStructure("\u1680").ok, false, "Ogham space mark");
  assert.ok(validateNpcUtteranceStructure("\u1680").violations.some(v => v.code === "whitespace_only"));
});

test("validateNpcUtteranceStructure: length limits using Unicode code points", () => {
  const text240 = "🍎".repeat(240);
  const result240 = validateNpcUtteranceStructure(text240);
  assert.equal(result240.ok, true);
  assert.equal(result240.metrics.characterCount, 240);

  const text241 = "🍎".repeat(241);
  const result241 = validateNpcUtteranceStructure(text241);
  assert.equal(result241.ok, false);
  assert.ok(result241.violations.some(v => v.code === "too_long"));
});

test("validateNpcUtteranceStructure: LF and CR rejections with exact codes", () => {
  const trailingLF = validateNpcUtteranceStructure("こんにちは\n");
  assert.equal(trailingLF.ok, false);
  assert.ok(trailingLF.violations.some(v => v.code === "line_feed_not_allowed"));

  const leadingCR = validateNpcUtteranceStructure("\rこんにちは");
  assert.equal(leadingCR.ok, false);
  assert.ok(leadingCR.violations.some(v => v.code === "carriage_return_not_allowed"));

  const crlf = validateNpcUtteranceStructure("こん\r\nにちは");
  assert.equal(crlf.ok, false);
  assert.ok(crlf.violations.some(v => v.code === "line_feed_not_allowed"));
  assert.ok(crlf.violations.some(v => v.code === "carriage_return_not_allowed"));
});

test("validateNpcUtteranceStructure: Tab rejections with exact codes", () => {
  const leadingTab = validateNpcUtteranceStructure("\tこんにちは");
  assert.equal(leadingTab.ok, false);
  assert.ok(leadingTab.violations.some(v => v.code === "tab_not_allowed"));

  const trailingTab = validateNpcUtteranceStructure("こんにちは\t");
  assert.equal(trailingTab.ok, false);
  assert.ok(trailingTab.violations.some(v => v.code === "tab_not_allowed"));

  const internalTab = validateNpcUtteranceStructure("こん\tにちは");
  assert.equal(internalTab.ok, false);
  assert.ok(internalTab.violations.some(v => v.code === "tab_not_allowed"));

  const onlyTabs = validateNpcUtteranceStructure("\t\t");
  assert.equal(onlyTabs.ok, false);
  assert.ok(onlyTabs.violations.some(v => v.code === "tab_not_allowed"));
});

test("validateNpcUtteranceStructure: control characters and Unicode separators rejected", () => {
  const u0000 = validateNpcUtteranceStructure("あ\x00い");
  assert.equal(u0000.ok, false);
  assert.ok(u0000.violations.some(v => v.code === "control_characters_not_allowed"));

  const u001B = validateNpcUtteranceStructure("\x1Bあ");
  assert.equal(u001B.ok, false);
  assert.ok(u001B.violations.some(v => v.code === "control_characters_not_allowed"));

  const u2028 = validateNpcUtteranceStructure("あ\u2028い");
  assert.equal(u2028.ok, false);
  assert.ok(u2028.violations.some(v => v.code === "unicode_separator_not_allowed"));

  const u2029 = validateNpcUtteranceStructure("あ\u2029");
  assert.equal(u2029.ok, false);
  assert.ok(u2029.violations.some(v => v.code === "unicode_separator_not_allowed"));
});

test("validateNpcUtteranceStructure: invisible characters rejected", () => {
  const u200B = validateNpcUtteranceStructure("こん\u200Bにちは");
  assert.equal(u200B.ok, false);
  assert.ok(u200B.violations.some(v => v.code === "invisible_character_not_allowed"));

  const uFEFF = validateNpcUtteranceStructure("\uFEFFこんにちは");
  assert.equal(uFEFF.ok, false);
  assert.ok(uFEFF.violations.some(v => v.code === "invisible_character_not_allowed"));
});

test("validateNpcUtteranceStructure: bidi override rejected", () => {
  assert.equal(validateNpcUtteranceStructure("あいう\u202Aえお").ok, false);
  assert.ok(validateNpcUtteranceStructure("あいう\u202Aえお").violations.some(v => v.code === "bidi_characters_not_allowed"));
});

test("validateNpcUtteranceStructure: HTML and script rejections but comparison accepted", () => {
  assert.equal(validateNpcUtteranceStructure("<img src=x>").ok, false);
  assert.ok(validateNpcUtteranceStructure("<img src=x>").violations.some(v => v.code === "html_markup_not_allowed"));

  assert.equal(validateNpcUtteranceStructure("</div>").ok, false);
  assert.ok(validateNpcUtteranceStructure("</div>").violations.some(v => v.code === "html_markup_not_allowed"));

  assert.equal(validateNpcUtteranceStructure("<script>alert(1)</script>").ok, false);

  assert.equal(validateNpcUtteranceStructure("2 < 3 かつ 3 > 1 です。").ok, true);
});

test("validateNpcUtteranceStructure: JSON and Markdown structural rejections", () => {
  assert.equal(validateNpcUtteranceStructure('{"text":"hi"}').ok, false, "JSON object");
  assert.equal(validateNpcUtteranceStructure('["hi"]').ok, false, "JSON array");

  assert.equal(validateNpcUtteranceStructure("```js\nconsole.log(1)\n```").ok, false, "code fence");
  assert.ok(validateNpcUtteranceStructure("```").violations.some(v => v.code === "markdown_code_fence_not_allowed"));

  assert.equal(validateNpcUtteranceStructure("# 見出し").ok, false, "heading");

  // Markdown list rejections (require whitespace)
  assert.equal(validateNpcUtteranceStructure("1. 項目").ok, false, "ordered list single digit");
  assert.equal(validateNpcUtteranceStructure("12. 項目").ok, false, "ordered list multiple digits");
  assert.equal(validateNpcUtteranceStructure("- リスト").ok, false, "unordered list");
});

test("validateNpcUtteranceStructure: decimals and numbering without spaces accepted", () => {
  assert.equal(validateNpcUtteranceStructure("1.23について確認します。").ok, true);
  assert.equal(validateNpcUtteranceStructure("2026.07.01の記録です。").ok, true);
  assert.equal(validateNpcUtteranceStructure("1.ではなく別案です。").ok, true);
});

test("validateNpcUtteranceStructure: role prefixes and prefaces with variants rejected", () => {
  assert.equal(validateNpcUtteranceStructure("assistant : hello").ok, false);
  assert.equal(validateNpcUtteranceStructure("system　: hello").ok, false);
  assert.equal(validateNpcUtteranceStructure("user  : hello").ok, false);

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

test("validateNpcUtteranceStructure: rejected text absent from results", () => {
  const distinctiveSecret = "SECRET_TOKEN_99";
  const badText = `回答: ${distinctiveSecret} <script>alert(1)</script>`;
  const result = validateNpcUtteranceStructure(badText);

  assert.equal(result.ok, false);
  assert.equal(result.normalizedText, null);

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(distinctiveSecret));
  assert.ok(!serialized.includes("<script>"));

  assert.ok(result.violations.length > 0);
  for (const violation of result.violations) {
    assert.deepEqual(Object.keys(violation), ["code"]);
    assert.ok(typeof violation.code === "string");
    assert.ok(!JSON.stringify(violation).includes(distinctiveSecret));
  }
});

// --- 2. ROLE AND SECRECY VALIDATION TESTS (18 BLOCKS) ---

const MOCK_ROSTER = [
  { id: "npc-aoi", name: "Aoi" },
  { id: "npc-beni", name: "Beni" }
];
const SPEAKER_AOI_WOLF = { id: "npc-aoi", name: "Aoi", role: "werewolf" };
const SPEAKER_AOI_SEER = { id: "npc-aoi", name: "Aoi", role: "seer" };
const SPEAKER_AOI_CITIZEN = { id: "npc-aoi", name: "Aoi", role: "citizen" };

test("validateNpcUtteranceRoleAndSecrecy: normal Japanese utterance accepted", () => {
  const res = validateNpcUtteranceRoleAndSecrecy({ text: "こんにちは。", speaker: SPEAKER_AOI_WOLF, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false });
  assert.equal(res.ok, true);
});

test("validateNpcUtteranceRoleAndSecrecy: role/werewolf discussion accepted", () => {
  const res1 = validateNpcUtteranceRoleAndSecrecy({ text: "占い師の発言を確認したいです。", speaker: SPEAKER_AOI_WOLF, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false });
  assert.equal(res1.ok, true);
  const res2 = validateNpcUtteranceRoleAndSecrecy({ text: "Beniが人狼かもしれません。", speaker: SPEAKER_AOI_WOLF, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false });
  assert.equal(res2.ok, true);
  const res3 = validateNpcUtteranceRoleAndSecrecy({ text: "私は人狼を疑っています。", speaker: SPEAKER_AOI_WOLF, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false });
  assert.equal(res3.ok, true);
});

test("validateNpcUtteranceRoleAndSecrecy: denials accepted", () => {
  const cases = ["私は人狼ではありません", "占い師ではありません", "騎士ではありません", "役職COはしません"];
  for (const text of cases) {
    const res = validateNpcUtteranceRoleAndSecrecy({ text, speaker: SPEAKER_AOI_WOLF, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false });
    assert.equal(res.ok, true, `Should accept ${text}`);
  }
});

test("validateNpcUtteranceRoleAndSecrecy: Werewolf self-confession rejected", () => {
  const cases = ["私は人狼です", "自分が人狼です", "Aoiは人狼です", "人狼CO", "狼CO", "人狼COです", "狼COします"];
  for (const text of cases) {
    const res = validateNpcUtteranceRoleAndSecrecy({ text, speaker: SPEAKER_AOI_WOLF, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false });
    assert.equal(res.ok, false, `Should reject ${text}`);
    assert.equal(res.violations[0].code, "werewolf_confession_not_allowed");
  }
});

test("validateNpcUtteranceRoleAndSecrecy: mixed Werewolf denial + confession rejected", () => {
  const text = "私は人狼ではありません。ただし本当は人狼です";
  const res = validateNpcUtteranceRoleAndSecrecy({ text, speaker: SPEAKER_AOI_WOLF, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false });
  assert.equal(res.ok, false);
  assert.equal(res.violations[0].code, "werewolf_confession_not_allowed");
});

test("validateNpcUtteranceRoleAndSecrecy: unauthorized role claims rejected", () => {
  const cases = ["私は占い師です", "占い師CO", "私が騎士です", "騎士CO", "私は狩人です", "霊媒師CO", "私は霊能者です", "私は村人です", "市民CO", "占い師COします"];
  for (const text of cases) {
    const res = validateNpcUtteranceRoleAndSecrecy({ text, speaker: SPEAKER_AOI_CITIZEN, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false });
    assert.equal(res.ok, false, `Should reject ${text}`);
    assert.equal(res.violations[0].code, "role_claim_not_allowed");
  }
});

test("validateNpcUtteranceRoleAndSecrecy: third-party role claims rejected when disallowed", () => {
  const res = validateNpcUtteranceRoleAndSecrecy({ text: "Beniは占い師です", speaker: SPEAKER_AOI_CITIZEN, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false });
  assert.equal(res.ok, false);
  assert.equal(res.violations[0].code, "role_claim_not_allowed");
});

test("validateNpcUtteranceRoleAndSecrecy: unknown actor role claim rejected when disallowed", () => {
  const res = validateNpcUtteranceRoleAndSecrecy({ text: "Malloryは占い師です", speaker: SPEAKER_AOI_CITIZEN, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false });
  assert.equal(res.ok, false);
  assert.equal(res.violations[0].code, "role_claim_not_allowed");
});

test("validateNpcUtteranceRoleAndSecrecy: exact approved Seer claim accepted", () => {
  const publicClaim = { actorId: "npc-aoi", actorName: "Aoi", role: "seer", results: [{ targetId: "npc-beni", targetName: "Beni", result: "werewolf" }] };
  const res1 = validateNpcUtteranceRoleAndSecrecy({ text: "Beniは人狼でした", speaker: SPEAKER_AOI_SEER, publicPlayers: MOCK_ROSTER, publicClaimAllowed: true, publicClaim });
  assert.equal(res1.ok, true);

  const publicClaim2 = { actorId: "npc-aoi", actorName: "Aoi", role: "seer", results: [{ targetId: "npc-beni", targetName: "Beni", result: "human" }] };
  const res2 = validateNpcUtteranceRoleAndSecrecy({ text: "Beniは村人でした", speaker: SPEAKER_AOI_SEER, publicPlayers: MOCK_ROSTER, publicClaimAllowed: true, publicClaim: publicClaim2 });
  assert.equal(res2.ok, true);
});

test("validateNpcUtteranceRoleAndSecrecy: Seer claim contract mismatches rejected", () => {
  const publicClaim = { actorId: "npc-aoi", actorName: "Aoi", role: "seer", results: [{ targetId: "npc-beni", targetName: "Beni", result: "werewolf" }] };

  // Wrong actor
  assert.equal(validateNpcUtteranceRoleAndSecrecy({ text: "Beniは人狼でした", speaker: SPEAKER_AOI_SEER, publicPlayers: MOCK_ROSTER, publicClaimAllowed: true, publicClaim: { ...publicClaim, actorId: "npc-beni" } }).violations[0].code, "public_claim_actor_mismatch");
  // Wrong role
  assert.equal(validateNpcUtteranceRoleAndSecrecy({ text: "Beniは人狼でした", speaker: SPEAKER_AOI_SEER, publicPlayers: MOCK_ROSTER, publicClaimAllowed: true, publicClaim: { ...publicClaim, role: "werewolf" } }).violations[0].code, "public_claim_role_mismatch");
  // Extra result
  assert.equal(validateNpcUtteranceRoleAndSecrecy({ text: "Beniは人狼でした。Aoiは白です", speaker: SPEAKER_AOI_SEER, publicPlayers: MOCK_ROSTER, publicClaimAllowed: true, publicClaim }).violations[0].code, "public_claim_role_mismatch");
  // Unknown target
  assert.equal(validateNpcUtteranceRoleAndSecrecy({ text: "Malloryは人狼でした", speaker: SPEAKER_AOI_SEER, publicPlayers: MOCK_ROSTER, publicClaimAllowed: true, publicClaim }).violations[0].code, "public_claim_target_mismatch");
});

test("validateNpcUtteranceRoleAndSecrecy: private Seer result disclosure rejected", () => {
  const privateSeerResults = [{ targetId: "npc-beni", targetName: "Beni", result: "werewolf" }];
  const cases = ["Beniは黒です", "Beniさんは黒です", "Beniの占い結果は黒です", "Beniを占った結果、人狼でした"];
  for (const text of cases) {
    const res = validateNpcUtteranceRoleAndSecrecy({ text, speaker: SPEAKER_AOI_SEER, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false, privateSeerResults });
    assert.equal(res.ok, false, `Should reject ${text}`);
    assert.equal(res.violations[0].code, "private_seer_result_disclosure");
  }
});

test("validateNpcUtteranceRoleAndSecrecy: negated alignment interpreted correctly", () => {
  const privateSeerResults = [{ targetId: "npc-beni", targetName: "Beni", result: "human" }];
  // "Beni is not werewolf" -> interprets as "Beni is human"
  const res = validateNpcUtteranceRoleAndSecrecy({ text: "Beniは人狼ではありません", speaker: SPEAKER_AOI_SEER, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false, privateSeerResults });
  assert.equal(res.ok, false);
  assert.equal(res.violations[0].code, "private_seer_result_disclosure");
});

test("validateNpcUtteranceRoleAndSecrecy: suspicion without result accepted", () => {
  const privateSeerResults = [{ targetId: "npc-beni", targetName: "Beni", result: "human" }];
  const res = validateNpcUtteranceRoleAndSecrecy({ text: "Beniは少し気になります。", speaker: SPEAKER_AOI_SEER, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false, privateSeerResults });
  assert.equal(res.ok, true);
});

test("validateNpcUtteranceRoleAndSecrecy: data safety and no leakage", () => {
  const privateSeerResults = [{ targetId: "npc-beni", targetName: "Beni", result: "human" }];
  const res = validateNpcUtteranceRoleAndSecrecy({ text: "私は人狼です", speaker: SPEAKER_AOI_WOLF, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false, privateSeerResults });
  const json = JSON.stringify(res);
  assert.ok(!json.includes("人狼です"));
  assert.ok(!json.includes("npc-beni"));
  assert.ok(!json.includes("Beni"));
  assert.ok(!json.includes("human"));
});

test("validateNpcUtteranceRoleAndSecrecy: input objects immutability", () => {
  const speaker = { id: "a", name: "A", role: "citizen" };
  const roster = [{ id: "b", name: "B" }];
  const speakerJSON = JSON.stringify(speaker);
  validateNpcUtteranceRoleAndSecrecy({ text: "hello", speaker, publicPlayers: roster, publicClaimAllowed: false });
  assert.equal(JSON.stringify(speaker), speakerJSON);
});

test("validateNpcUtteranceRoleAndSecrecy: malformed roster rejected", () => {
  const res = validateNpcUtteranceRoleAndSecrecy({ text: "hello", speaker: SPEAKER_AOI_WOLF, publicPlayers: [{ id: "dup", name: "A" }, { id: "dup", name: "B" }], publicClaimAllowed: false });
  assert.equal(res.ok, false);
  assert.equal(res.violations[0].code, "validation_input_invalid");
});

test("validateNpcUtteranceRoleAndSecrecy: malformed claim contracts rejected", () => {
  const res = validateNpcUtteranceRoleAndSecrecy({ text: "hello", speaker: SPEAKER_AOI_SEER, publicPlayers: MOCK_ROSTER, publicClaimAllowed: true, publicClaim: { role: "knight" } });
  assert.equal(res.ok, false);
  assert.ok(res.violations[0].code.startsWith("public_claim_"));
});

test("validateNpcUtteranceRoleAndSecrecy: throwing getters handled safely", () => {
  const res = validateNpcUtteranceRoleAndSecrecy({ get text() { throw new Error("SECRET"); }, speaker: SPEAKER_AOI_WOLF, publicPlayers: MOCK_ROSTER, publicClaimAllowed: false });
  assert.equal(res.ok, false);
  assert.ok(!JSON.stringify(res).includes("SECRET"));
});
