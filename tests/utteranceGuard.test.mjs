import test from "node:test";
import assert from "node:assert/strict";
import { validateNpcUtteranceStructure, validateNpcUtteranceRoleAndSecrecy, MAX_NPC_UTTERANCE_CHARS } from "../src/utteranceGuard.mjs";

// --- Existing Structural Tests (Preserved 1-19) ---

test("1. validateNpcUtteranceStructure: normal Japanese utterance accepted unchanged", () => {
  const text = "こんにちは、私は村人です。";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.normalizedText, text);
  assert.deepEqual(result.violations, []);
});

test("2. validateNpcUtteranceStructure: ordinary leading/trailing spaces trimmable but internal preserved", () => {
  const text = " 　こんにちは 私は 市民です。 　";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.normalizedText, "こんにちは 私は 市民です。");
});

test("3. validateNpcUtteranceStructure: Unicode NFKC normalization", () => {
  const text = "ＡＢＣ１２３";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.normalizedText, "ABC123");
});

test("4. validateNpcUtteranceStructure: punctuation accepted", () => {
  const text = "！、。？…";
  const result = validateNpcUtteranceStructure(text);
  assert.equal(result.ok, true);
  assert.equal(result.normalizedText, "!、。?...");
});

test("5. validateNpcUtteranceStructure: non-string rejected", () => {
  const result = validateNpcUtteranceStructure(123);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "not_a_string"));
});

test("6. validateNpcUtteranceStructure: empty or whitespace-only rejected", () => {
  assert.equal(validateNpcUtteranceStructure("").ok, false);
  assert.equal(validateNpcUtteranceStructure("   ").ok, false);
});

test("7. validateNpcUtteranceStructure: length limits using Unicode code points", () => {
  const text240 = "🍎".repeat(240);
  assert.equal(validateNpcUtteranceStructure(text240).ok, true);
  const text241 = "🍎".repeat(241);
  assert.equal(validateNpcUtteranceStructure(text241).ok, false);
});

test("8. validateNpcUtteranceStructure: LF and CR rejections", () => {
  assert.equal(validateNpcUtteranceStructure("こん\nにちは").ok, false);
  assert.equal(validateNpcUtteranceStructure("こん\rにちは").ok, false);
});

test("9. validateNpcUtteranceStructure: Tab rejections", () => {
  assert.equal(validateNpcUtteranceStructure("こん\tにちは").ok, false);
});

test("10. validateNpcUtteranceStructure: control characters and separators rejected", () => {
  assert.equal(validateNpcUtteranceStructure("あ\x00い").ok, false);
  assert.equal(validateNpcUtteranceStructure("あ\u2028い").ok, false);
});

test("11. validateNpcUtteranceStructure: invisible characters rejected", () => {
  assert.equal(validateNpcUtteranceStructure("こん\u200Bにちは").ok, false);
  assert.equal(validateNpcUtteranceStructure("\uFEFFこんにちは").ok, false);
});

test("12. validateNpcUtteranceStructure: bidi override rejected", () => {
  assert.equal(validateNpcUtteranceStructure("あいう\u202Aえお").ok, false);
});

test("13. validateNpcUtteranceStructure: HTML markup rejected", () => {
  assert.equal(validateNpcUtteranceStructure("<script>").ok, false);
  assert.equal(validateNpcUtteranceStructure("</div>").ok, false);
});

test("14. validateNpcUtteranceStructure: JSON and Markdown structural rejections", () => {
  assert.equal(validateNpcUtteranceStructure('{"a":1}').ok, false);
  assert.equal(validateNpcUtteranceStructure("```").ok, false);
});

test("15. validateNpcUtteranceStructure: decimals accepted", () => {
  assert.equal(validateNpcUtteranceStructure("1.23").ok, true);
});

test("16. validateNpcUtteranceStructure: role prefixes rejected", () => {
  assert.equal(validateNpcUtteranceStructure("assistant: hello").ok, false);
  assert.equal(validateNpcUtteranceStructure("回答: はい").ok, false);
});

test("17. validateNpcUtteranceStructure: stage directions rejected at boundaries", () => {
  assert.equal(validateNpcUtteranceStructure("(笑う)").ok, false);
  assert.equal(validateNpcUtteranceStructure("[考え込む]").ok, false);
});

test("18. validateNpcUtteranceStructure: ordinary parentheticals accepted", () => {
  assert.equal(validateNpcUtteranceStructure("(1回目)").ok, true);
});

test("19. validateNpcUtteranceStructure: rejected text absent from results", () => {
  const secret = "SECRET_TOKEN";
  const result = validateNpcUtteranceStructure(`回答: ${secret}`);
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes(secret));
});

// --- New Role and Secrecy Tests (20-37+) ---

const defaultSpeaker = { id: "aoi", name: "Aoi", role: "citizen" };
const defaultPlayers = [{ id: "aoi", name: "Aoi" }, { id: "beni", name: "Beni" }];

test("20. validateNpcUtteranceRoleAndSecrecy: normal non-claim accepted", () => {
  const result = validateNpcUtteranceRoleAndSecrecy({
    text: "今日はいい天気ですね。",
    speaker: defaultSpeaker,
    publicPlayers: defaultPlayers,
    publicClaimAllowed: false
  });
  assert.equal(result.ok, true);
});

test("21. validateNpcUtteranceRoleAndSecrecy: role discussion and denials accepted", () => {
  const cases = [
    "占い師は誰でしょう？",
    "私は占い師ではありません。",
    "騎士COはしません。",
    "人狼ではありません。",
    "役職COはしません。"
  ];
  for (const text of cases) {
    const result = validateNpcUtteranceRoleAndSecrecy({
      text,
      speaker: defaultSpeaker,
      publicPlayers: defaultPlayers,
      publicClaimAllowed: false
    });
    assert.equal(result.ok, true, `Should accept: ${text}`);
  }
});

test("22. validateNpcUtteranceRoleAndSecrecy: Werewolf self-confession rejections", () => {
  const speaker = { id: "aoi", name: "Aoi", role: "werewolf" };
  const cases = ["私は人狼です", "自分が人狼です", "俺は狼だ", "Aoiは人狼です", "人狼CO", "狼CO"];
  for (const text of cases) {
    const result = validateNpcUtteranceRoleAndSecrecy({
      text,
      speaker,
      publicPlayers: defaultPlayers,
      publicClaimAllowed: false
    });
    assert.equal(result.ok, false, `Should reject confession: ${text}`);
    assert.ok(result.violations.some(v => v.code === "werewolf_confession_not_allowed"));
  }
});

test("23. validateNpcUtteranceRoleAndSecrecy: Werewolf mixed bypass rejections", () => {
  const speaker = { id: "aoi", name: "Aoi", role: "werewolf" };
  const cases = [
    "私は人狼ではないと言いましたが、実際は人狼です",
    "狼ではありません。ただし本当は狼です"
  ];
  for (const text of cases) {
    const result = validateNpcUtteranceRoleAndSecrecy({
      text,
      speaker,
      publicPlayers: defaultPlayers,
      publicClaimAllowed: false
    });
    assert.equal(result.ok, false, `Should reject bypass: ${text}`);
  }
});

test("24. validateNpcUtteranceRoleAndSecrecy: Werewolf discussion about others accepted", () => {
  const speaker = { id: "aoi", name: "Aoi", role: "werewolf" };
  const cases = ["Beniが人狼かもしれません", "人狼の可能性を考えています"];
  for (const text of cases) {
    const result = validateNpcUtteranceRoleAndSecrecy({
      text,
      speaker,
      publicPlayers: defaultPlayers,
      publicClaimAllowed: false
    });
    assert.equal(result.ok, true);
  }
});

test("25. validateNpcUtteranceRoleAndSecrecy: Unauthorized Seer claim rejections", () => {
  const cases = ["私は占い師です", "占い師CO"];
  for (const text of cases) {
    const result = validateNpcUtteranceRoleAndSecrecy({
      text,
      speaker: defaultSpeaker,
      publicPlayers: defaultPlayers,
      publicClaimAllowed: false
    });
    assert.equal(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "role_claim_not_allowed"));
  }
});

test("26. validateNpcUtteranceRoleAndSecrecy: Unauthorized Knight/Hunter claim rejections", () => {
  const cases = ["私が騎士です", "騎士CO", "私は狩人です"];
  for (const text of cases) {
    assert.equal(validateNpcUtteranceRoleAndSecrecy({
      text, speaker: defaultSpeaker, publicPlayers: defaultPlayers, publicClaimAllowed: false
    }).ok, false);
  }
});

test("27. validateNpcUtteranceRoleAndSecrecy: Unauthorized Medium/Spiritualist claim rejections", () => {
  const cases = ["霊媒師CO", "私は霊能者です"];
  for (const text of cases) {
    assert.equal(validateNpcUtteranceRoleAndSecrecy({
      text, speaker: defaultSpeaker, publicPlayers: defaultPlayers, publicClaimAllowed: false
    }).ok, false);
  }
});

test("28. validateNpcUtteranceRoleAndSecrecy: Unauthorized Citizen/Village-person claim rejections", () => {
  const cases = ["私は村人です", "市民CO"];
  for (const text of cases) {
    assert.equal(validateNpcUtteranceRoleAndSecrecy({
      text, speaker: defaultSpeaker, publicPlayers: defaultPlayers, publicClaimAllowed: false
    }).ok, false);
  }
});

test("29. validateNpcUtteranceRoleAndSecrecy: Exact approved Seer claim accepted", () => {
  const speaker = { id: "aoi", name: "Aoi", role: "seer" };
  const publicClaim = {
    actorId: "aoi", actorName: "Aoi", role: "seer",
    results: [{ targetId: "beni", targetName: "Beni", result: "werewolf" }]
  };
  const cases = ["私は占い師です。Beniは黒です。", "Beniは人狼でした", "Beniの占い結果は黒です"];
  for (const text of cases) {
    const result = validateNpcUtteranceRoleAndSecrecy({
      text, speaker, publicPlayers: defaultPlayers, publicClaimAllowed: true, publicClaim
    });
    assert.equal(result.ok, true, `Should accept: ${text}`);
  }
});

test("30. validateNpcUtteranceRoleAndSecrecy: Approved white result accepted", () => {
  const speaker = { id: "aoi", name: "Aoi", role: "seer" };
  const publicClaim = {
    actorId: "aoi", actorName: "Aoi", role: "seer",
    results: [{ targetId: "beni", targetName: "Beni", result: "human" }]
  };
  const cases = ["Beniは白です", "Beniは村人でした", "Beniは人狼ではありません"];
  for (const text of cases) {
    assert.equal(validateNpcUtteranceRoleAndSecrecy({
      text, speaker, publicPlayers: defaultPlayers, publicClaimAllowed: true, publicClaim
    }).ok, true);
  }
});

test("31. validateNpcUtteranceRoleAndSecrecy: Claim contract actor/role mismatches", () => {
  const speaker = { id: "aoi", name: "Aoi", role: "seer" };
  const validClaim = { actorId: "aoi", actorName: "Aoi", role: "seer", results: [{ targetId: "beni", targetName: "Beni", result: "werewolf" }] };

  // Actor mismatch
  assert.equal(validateNpcUtteranceRoleAndSecrecy({
    text: "Beniは黒です", speaker, publicPlayers: defaultPlayers, publicClaimAllowed: true,
    publicClaim: { ...validClaim, actorName: "Wrong" }
  }).violations[0].code, "public_claim_actor_mismatch");

  // Role mismatch in contract
  assert.equal(validateNpcUtteranceRoleAndSecrecy({
    text: "Beniは黒です", speaker, publicPlayers: defaultPlayers, publicClaimAllowed: true,
    publicClaim: { ...validClaim, role: "knight" } // schema validation will fail it
  }).violations[0].code, "public_claim_contract_invalid");
});

test("32. validateNpcUtteranceRoleAndSecrecy: Claim contract target/result mismatches", () => {
  const speaker = { id: "aoi", name: "Aoi", role: "seer" };
  const validClaim = { actorId: "aoi", actorName: "Aoi", role: "seer", results: [{ targetId: "beni", targetName: "Beni", result: "werewolf" }] };

  // Wrong target name in text
  assert.equal(validateNpcUtteranceRoleAndSecrecy({
    text: "Daichiは黒です", speaker, publicPlayers: [...defaultPlayers, {id:"d", name:"Daichi"}],
    publicClaimAllowed: true, publicClaim: validClaim
  }).violations[0].code, "public_claim_target_mismatch");

  // Wrong result in text
  assert.equal(validateNpcUtteranceRoleAndSecrecy({
    text: "Beniは白です", speaker, publicPlayers: defaultPlayers,
    publicClaimAllowed: true, publicClaim: validClaim
  }).violations[0].code, "public_claim_result_mismatch");
});

test("33. validateNpcUtteranceRoleAndSecrecy: Private Seer-result disclosure rejections", () => {
  const speaker = { id: "aoi", name: "Aoi", role: "seer" };
  const privateResults = [{ targetId: "beni", targetName: "Beni", result: "werewolf" }];
  const cases = ["Beniは黒", "Beniは人狼だった", "Beniを占った結果、人狼でした"];
  for (const text of cases) {
    const result = validateNpcUtteranceRoleAndSecrecy({
      text, speaker, publicPlayers: defaultPlayers, publicClaimAllowed: false, privateSeerResults: privateResults
    });
    assert.equal(result.ok, false, `Should reject disclosure: ${text}`);
    assert.ok(result.violations.some(v => v.code === "private_seer_result_disclosure"));
  }
});

test("34. validateNpcUtteranceRoleAndSecrecy: Secrecy disclosure with さん suffix and particles", () => {
  const speaker = { id: "aoi", name: "Aoi", role: "seer" };
  const privateResults = [{ targetId: "beni", targetName: "Beni", result: "human" }];
  const cases = ["Beniさんは白", "Beniの占い結果は白", "Beniを占った結果は白"];
  for (const text of cases) {
    assert.equal(validateNpcUtteranceRoleAndSecrecy({
      text, speaker, publicPlayers: defaultPlayers, publicClaimAllowed: false, privateSeerResults: privateResults
    }).ok, false);
  }
});

test("35. validateNpcUtteranceRoleAndSecrecy: Generic result detection (targets not in roster)", () => {
  const text = "Malloryは黒です"; // Mallory is not in roster
  const result = validateNpcUtteranceRoleAndSecrecy({
    text, speaker: defaultSpeaker, publicPlayers: defaultPlayers, publicClaimAllowed: false
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => v.code === "role_claim_not_allowed"));
});

test("36. validateNpcUtteranceRoleAndSecrecy: Strict input schema rejections", () => {
  // Bad speaker role
  assert.equal(validateNpcUtteranceRoleAndSecrecy({
    text: "hi", speaker: { ...defaultSpeaker, role: "GOD" }, publicPlayers: defaultPlayers, publicClaimAllowed: false
  }).violations[0].code, "validation_input_invalid");

  // Malformed roster (duplicate ID)
  assert.equal(validateNpcUtteranceRoleAndSecrecy({
    text: "hi", speaker: defaultSpeaker, publicPlayers: [{id:"x", name:"A"}, {id:"x", name:"B"}], publicClaimAllowed: false
  }).violations[0].code, "validation_input_invalid");
});

test("37. validateNpcUtteranceRoleAndSecrecy: Throwing getters rejections", () => {
  const speaker = {
    id: "aoi", role: "citizen",
    get name() { throw new Error("BOOM"); }
  };
  const result = validateNpcUtteranceRoleAndSecrecy({
    text: "hi", speaker, publicPlayers: defaultPlayers, publicClaimAllowed: false
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].code, "validation_input_invalid");
  assert.ok(!JSON.stringify(result).includes("BOOM"));
});
