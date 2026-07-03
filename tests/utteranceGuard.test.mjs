import test from "node:test";
import assert from "node:assert/strict";
import { validateNpcUtteranceStructure, validateNpcUtteranceRoleAndSecrecy, MAX_NPC_UTTERANCE_CHARS } from "../src/utteranceGuard.mjs";

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

// New tests for validateNpcUtteranceRoleAndSecrecy

const defaultSpeaker = { id: "npc-aoi", name: "Aoi", role: "citizen" };
const defaultPlayers = [{ id: "npc-beni", name: "Beni" }];

test("validateNpcUtteranceRoleAndSecrecy: structural layer preserved", () => {
  const result = validateNpcUtteranceRoleAndSecrecy({
    text: "回答: はい",
    speaker: defaultSpeaker,
    publicPlayers: defaultPlayers,
    publicClaimAllowed: false
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "explanatory_preface_not_allowed"));
});

test("validateNpcUtteranceRoleAndSecrecy: normal accepted output", () => {
  const examples = [
    "こんにちは。",
    "占い師ではありません。",
    "Beniが人狼かもしれません。",
    "人狼だと断定するには早いです。",
    "人狼の可能性を考えています。",
    "騎士COはしません。",
    "霊媒師がいるかは分かりません。",
    "役職COはしません。",
    "Beniは少し気になります。",
    "Beniの発言をもう一度確認したいです。",
    "まだBeniを断定できません。"
  ];
  for (const text of examples) {
    const result = validateNpcUtteranceRoleAndSecrecy({
      text,
      speaker: { ...defaultSpeaker, role: "werewolf" },
      publicPlayers: defaultPlayers,
      publicClaimAllowed: false
    });
    assert.equal(result.ok, true, `Should accept: ${text}`);
  }
});

test("validateNpcUtteranceRoleAndSecrecy: werewolf confession rejections", () => {
  const badExamples = [
    "私は人狼です",
    "自分が人狼です",
    "俺は狼だ",
    "Aoiは人狼です",
    "人狼CO",
    "狼CO"
  ];
  for (const text of badExamples) {
    const result = validateNpcUtteranceRoleAndSecrecy({
      text,
      speaker: { id: "npc-aoi", name: "Aoi", role: "werewolf" },
      publicPlayers: defaultPlayers,
      publicClaimAllowed: false
    });
    assert.equal(result.ok, false, `Should reject: ${text}`);
    assert.ok(result.violations.some(v => v.code === "werewolf_confession_not_allowed"));
  }
});

test("validateNpcUtteranceRoleAndSecrecy: werewolf confession bypass attempts", () => {
  const text = "私は人狼ではないと言いましたが、実際は人狼です";
  const result = validateNpcUtteranceRoleAndSecrecy({
    text,
    speaker: { id: "npc-aoi", name: "Aoi", role: "werewolf" },
    publicPlayers: defaultPlayers,
    publicClaimAllowed: false
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "werewolf_confession_not_allowed"));
});

test("validateNpcUtteranceRoleAndSecrecy: unauthorized role claims rejections", () => {
  const roles = ["占い師", "騎士", "狩人", "霊媒師", "霊能者", "村人", "市民"];
  for (const role of roles) {
    const result = validateNpcUtteranceRoleAndSecrecy({
      text: `私は${role}です`,
      speaker: defaultSpeaker,
      publicPlayers: defaultPlayers,
      publicClaimAllowed: false
    });
    assert.equal(result.ok, false, `Should reject ${role} claim`);
    assert.ok(result.violations.some(v => v.code === "role_claim_not_allowed"));
  }
});

test("validateNpcUtteranceRoleAndSecrecy: denial followed by affirmative claim rejected", () => {
  const text = "占い師ではありません。嘘です、占い師COします。";
  const result = validateNpcUtteranceRoleAndSecrecy({
    text,
    speaker: defaultSpeaker,
    publicPlayers: defaultPlayers,
    publicClaimAllowed: false
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "role_claim_not_allowed"));
});

test("validateNpcUtteranceRoleAndSecrecy: exact approved Seer claim accepted", () => {
  const publicClaim = {
    actorId: "npc-aoi",
    actorName: "Aoi",
    role: "seer",
    results: [{ targetId: "npc-beni", targetName: "Beni", result: "werewolf" }]
  };
  const result = validateNpcUtteranceRoleAndSecrecy({
    text: "占い師COします。Beniは黒です。",
    speaker: { id: "npc-aoi", name: "Aoi", role: "seer" },
    publicPlayers: defaultPlayers,
    publicClaimAllowed: true,
    publicClaim
  });
  assert.equal(result.ok, true);
});

test("validateNpcUtteranceRoleAndSecrecy: approved white result accepted", () => {
  const publicClaim = {
    actorId: "npc-aoi",
    actorName: "Aoi",
    role: "seer",
    results: [{ targetId: "npc-beni", targetName: "Beni", result: "human" }]
  };
  const result = validateNpcUtteranceRoleAndSecrecy({
    text: "Beniは白です。",
    speaker: { id: "npc-aoi", name: "Aoi", role: "seer" },
    publicPlayers: defaultPlayers,
    publicClaimAllowed: true,
    publicClaim
  });
  assert.equal(result.ok, true);
});

test("validateNpcUtteranceRoleAndSecrecy: wrong actor rejected", () => {
  const publicClaim = {
    actorId: "npc-wrong",
    actorName: "Wrong",
    role: "seer",
    results: [{ targetId: "npc-beni", targetName: "Beni", result: "human" }]
  };
  const result = validateNpcUtteranceRoleAndSecrecy({
    text: "占い師COします。",
    speaker: defaultSpeaker,
    publicPlayers: defaultPlayers,
    publicClaimAllowed: true,
    publicClaim
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "public_claim_actor_mismatch"));
});

test("validateNpcUtteranceRoleAndSecrecy: wrong role rejected", () => {
  const publicClaim = {
    actorId: "npc-aoi",
    actorName: "Aoi",
    role: "knight", // Invalid in contract
    results: [{ targetId: "npc-beni", targetName: "Beni", result: "human" }]
  };
  const result = validateNpcUtteranceRoleAndSecrecy({
    text: "占い師COします。",
    speaker: defaultSpeaker,
    publicPlayers: defaultPlayers,
    publicClaimAllowed: true,
    publicClaim
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "public_claim_role_mismatch"));
});

test("validateNpcUtteranceRoleAndSecrecy: wrong target rejected", () => {
  const publicClaim = {
    actorId: "npc-aoi",
    actorName: "Aoi",
    role: "seer",
    results: [{ targetId: "npc-beni", targetName: "Beni", result: "werewolf" }]
  };
  const result = validateNpcUtteranceRoleAndSecrecy({
    text: "Daichiは黒です。",
    speaker: { id: "npc-aoi", name: "Aoi", role: "seer" },
    publicPlayers: [...defaultPlayers, { id: "npc-daichi", name: "Daichi" }],
    publicClaimAllowed: true,
    publicClaim
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "public_claim_extra_result"));
});

test("validateNpcUtteranceRoleAndSecrecy: wrong result rejected", () => {
  const publicClaim = {
    actorId: "npc-aoi",
    actorName: "Aoi",
    role: "seer",
    results: [{ targetId: "npc-beni", targetName: "Beni", result: "human" }]
  };
  const result = validateNpcUtteranceRoleAndSecrecy({
    text: "Beniは黒です。",
    speaker: { id: "npc-aoi", name: "Aoi", role: "seer" },
    publicPlayers: defaultPlayers,
    publicClaimAllowed: true,
    publicClaim
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "public_claim_result_mismatch"));
});

test("validateNpcUtteranceRoleAndSecrecy: duplicate target in publicClaim rejected", () => {
  const publicClaim = {
    actorId: "npc-aoi",
    actorName: "Aoi",
    role: "seer",
    results: [
      { targetId: "npc-beni", targetName: "Beni", result: "human" },
      { targetId: "npc-beni", targetName: "Beni", result: "human" }
    ]
  };
  const result = validateNpcUtteranceRoleAndSecrecy({
    text: "Beniは白です。",
    speaker: { id: "npc-aoi", name: "Aoi", role: "seer" },
    publicPlayers: defaultPlayers,
    publicClaimAllowed: true,
    publicClaim
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "public_claim_contract_invalid"));
});

test("validateNpcUtteranceRoleAndSecrecy: private result disclosure rejected", () => {
  const privateSeerResults = [{ targetId: "npc-beni", targetName: "Beni", result: "werewolf" }];
  const badExamples = [
    "Beniは黒です",
    "Beniは人狼だった",
    "Beniの占い結果は黒です",
    "Beniを占った結果、人狼でした",
    "Beniさんは黒です",
    "Beniさんを占った結果、人狼でした"
  ];
  for (const text of badExamples) {
    const result = validateNpcUtteranceRoleAndSecrecy({
      text,
      speaker: { id: "npc-aoi", name: "Aoi", role: "seer" },
      publicPlayers: defaultPlayers,
      publicClaimAllowed: false,
      privateSeerResults
    });
    assert.equal(result.ok, false, `Should reject disclosure: ${text}`);
    assert.ok(result.violations.some(v => v.code === "private_seer_result_disclosure"));
  }
});

test("validateNpcUtteranceRoleAndSecrecy: private result disclosure with particles", () => {
  const privateSeerResults = [{ targetId: "npc-beni", targetName: "Beni", result: "human" }];
  const text = "Beniさんが白です。";
  const result = validateNpcUtteranceRoleAndSecrecy({
    text,
    speaker: { id: "npc-aoi", name: "Aoi", role: "seer" },
    publicPlayers: defaultPlayers,
    publicClaimAllowed: false,
    privateSeerResults
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "private_seer_result_disclosure"));
});

test("validateNpcUtteranceRoleAndSecrecy: violation result does not contain private info", () => {
  const privateSeerResults = [{ targetId: "npc-beni", targetName: "Beni", result: "werewolf" }];
  const result = validateNpcUtteranceRoleAndSecrecy({
    text: "Beniは黒です",
    speaker: { id: "npc-aoi", name: "Aoi", role: "seer" },
    publicPlayers: defaultPlayers,
    publicClaimAllowed: false,
    privateSeerResults
  });
  assert.equal(result.ok, false);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("Beni"));
  assert.ok(!serialized.includes("werewolf"));
  assert.ok(!serialized.includes("黒"));
});

test("validateNpcUtteranceRoleAndSecrecy: malformed roster fails closed", () => {
  const result = validateNpcUtteranceRoleAndSecrecy({
    text: "占い師COします",
    speaker: defaultSpeaker,
    publicPlayers: [{ id: "dup", name: "Dup1" }, { id: "dup", name: "Dup2" }],
    publicClaimAllowed: true,
    publicClaim: { actorId: "npc-aoi", actorName: "Aoi", role: "seer", results: [{ targetId: "dup", targetName: "Dup1", result: "werewolf" }] }
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "public_claim_contract_invalid"));
});

test("validateNpcUtteranceRoleAndSecrecy: cyclic input safety", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const result = validateNpcUtteranceRoleAndSecrecy({
    text: "こんにちは",
    speaker: defaultSpeaker,
    publicPlayers: [cyclic],
    publicClaimAllowed: false
  });
  assert.equal(result.ok, true); // Should handle it gracefully
});
