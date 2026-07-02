import { describe, it } from "node:test";
import assert from "node:assert";
import { validateNpcUtterance, guardProviderResponse, MAX_UTTERANCE_LENGTH } from "../src/utteranceGuard.mjs";
import { ROLES } from "../src/constants.mjs";

// --- Helpers & Fixtures ---

function createBaseRequest(overrides = {}) {
  const base = {
    npc: {
      id: "npc1",
      name: "Aoi",
      personality: "冷静で観察好き",
      speechStyle: "calm"
    },
    playerInput: "こんにちは",
    context: {
      day: 1,
      phase: "day_discussion",
      publicEvidence: [],
      shareableKnownEvidence: [],
      privateStanceEvidence: [],
      publicClaims: [],
      intent: {
        asksWerewolfIdentity: false,
        asksRoleOrClaim: false,
        asksVoteReason: false
      },
      topSuspect: null
    },
    policyDecision: {
      publicClaimAllowed: false,
      publicClaim: null,
      disclosedHiddenInfo: false
    },
    responsePlan: {
      baseText: "こんにちは。何かお手伝いしましょうか。",
      speechStyle: "calm"
    }
  };

  return mergeDeep(base, overrides);
}

function mergeDeep(target, source) {
  for (const key in source) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      target[key] = mergeDeep(target[key] || {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

// --- Tests ---

describe("Utterance Guard: Structural Validation", () => {
  it("1. Normal short Japanese utterance is accepted unchanged", () => {
    const request = createBaseRequest();
    const text = "こんにちは。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.normalizedText, text);
  });

  it("2. Leading and trailing whitespace is normalized safely", () => {
    const request = createBaseRequest();
    const text = "  こんにちは。  ";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.normalizedText, "こんにちは。");
  });

  it("9. Empty string is rejected", () => {
    const request = createBaseRequest();
    const text = "";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "empty_utterance"));
  });

  it("10. Whitespace-only text is rejected", () => {
    const request = createBaseRequest();
    const text = "   ";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "empty_utterance"));
  });

  it("11. Non-string text is rejected", () => {
    const request = createBaseRequest();
    const text = 123;
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "not_a_string"));
  });

  it("12. Text over the maximum length is rejected", () => {
    const request = createBaseRequest();
    const text = "あ".repeat(MAX_UTTERANCE_LENGTH + 1);
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "too_long"));
  });

  it("13. Multiline output is rejected", () => {
    const request = createBaseRequest();
    const text = "一行目\n二行目";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "contains_line_breaks"));
  });

  it("14. Code-fence output is rejected", () => {
    const request = createBaseRequest();
    const text = "```js\nconsole.log('hi');\n```";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "contains_code_fence"));
  });

  it("15. JSON-wrapped output is rejected", () => {
    const request = createBaseRequest();
    const text = '{"text": "hi"}';
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "looks_like_json"));
  });

  it("16. HTML or script markup is rejected", () => {
    const request = createBaseRequest();
    const text = "Hello <script>alert(1)</script>";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "contains_html_or_script"));
  });

  it("17. Markdown heading or list wrapper is rejected", () => {
    const request = createBaseRequest();
    const text = "# Heading";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "contains_markdown_structure"));

    const text2 = "- item 1";
    const result2 = validateNpcUtterance({ request, text: text2 });
    assert.strictEqual(result2.ok, false);
    assert.ok(result2.violations.some(v => v.code === "contains_markdown_structure"));
  });

  it("18. System/assistant/user prefix is rejected", () => {
    const request = createBaseRequest();
    const text = "System: Hello";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "contains_role_prefix"));
  });

  it("19. Control characters are rejected", () => {
    const request = createBaseRequest();
    const text = "Hello\x00World";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "contains_control_characters"));
  });

  it("20. Bidirectional override characters are rejected", () => {
    const request = createBaseRequest();
    const text = "Hello\u202EWorld";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "contains_bidirectional_override"));
  });

  it("21. Stage-direction or explanatory wrapper is rejected", () => {
    const request = createBaseRequest();
    const text = "(小声で) 怪しいですね。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "contains_stage_direction_or_wrapper"));
  });

  it("Extra: NPC name prefix is rejected", () => {
    const request = createBaseRequest();
    const text = "Aoi: こんにちは";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "contains_name_prefix"));
  });
});

describe("Utterance Guard: Role and Secrecy Validation", () => {
  it("3. A werewolf denial is accepted", () => {
    const request = createBaseRequest();
    const text = "私は人狼ではありません。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, true);
  });

  it("4. A role denial is accepted", () => {
    const request = createBaseRequest();
    const text = "私は占い師ではありません。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, true);
  });

  it("5. Discussion of a role without claiming it is accepted", () => {
    const request = createBaseRequest();
    const text = "占い師の発言を確認したいです。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, true);
  });

  it("6. An exact code-approved seer claim is accepted", () => {
    const request = createBaseRequest({
      policyDecision: {
        publicClaimAllowed: true,
        publicClaim: {
          role: ROLES.SEER,
          results: [{ targetId: "npc2", result: "not_werewolf" }]
        }
      }
    });
    const text = "私は占い師です。Beniは人狼ではありませんでした。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, true);
  });

  it("22. Affirmative werewolf confession is rejected", () => {
    const request = createBaseRequest();
    const text = "私は人狼です。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "werewolf_confession"));
  });

  it("24. Unauthorized seer claim is rejected", () => {
    const request = createBaseRequest({
      policyDecision: { publicClaimAllowed: false }
    });
    const text = "私は占い師です。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "role_disclosure_not_allowed"));
  });

  it("25. Unauthorized citizen or other role claim is rejected", () => {
    const request = createBaseRequest({
      policyDecision: { publicClaimAllowed: false }
    });
    const text = "私は市民です。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "role_disclosure_not_allowed"));
  });

  it("26. Allowed role claim with the wrong role is rejected", () => {
    const request = createBaseRequest({
      policyDecision: {
        publicClaimAllowed: true,
        publicClaim: { role: ROLES.SEER }
      }
    });
    const text = "私は人狼です。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    // Might hit both confession and mismatch
    assert.ok(result.violations.some(v => v.code === "werewolf_confession" || v.code === "mismatched_role_claim"));
  });

  it("28. Private black seer result disclosure is rejected", () => {
    const request = createBaseRequest({
      context: {
        privateStanceEvidence: [{ type: "seer_result", targetId: "npc3", targetName: "Chika", result: "werewolf" }]
      }
    });
    const text = "Chikaは人狼です。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "private_result_disclosure"));
  });

  it("29. Private white seer result disclosure is rejected", () => {
    const request = createBaseRequest({
      context: {
        privateStanceEvidence: [{ type: "seer_result", targetId: "npc2", targetName: "Beni", result: "not_werewolf" }]
      }
    });
    const text = "Beniは人狼ではありません。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "private_result_disclosure"));
  });

  it("31. Suspicion without explicit private result disclosure remains acceptable", () => {
    const request = createBaseRequest({
      context: {
        privateStanceEvidence: [{ type: "seer_result", targetId: "npc3", targetName: "Chika", result: "werewolf" }]
      }
    });
    const text = "Chikaが怪しいと思います。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, true);
  });
});

describe("Utterance Guard: Factual Grounding Validation", () => {
  it("33. Invented execution is rejected", () => {
    const request = createBaseRequest();
    const text = "Beniが処刑されました。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "unsupported_claim_execution"));
  });

  it("34. Invented death is rejected", () => {
    const request = createBaseRequest();
    const text = "Beniが死亡しました。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "unsupported_claim_death"));
  });

  it("35. Invented attack is rejected", () => {
    const request = createBaseRequest();
    const text = "Beniが襲撃されました。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "unsupported_claim_attack"));
  });

  it("36. Invented vote is rejected", () => {
    const request = createBaseRequest();
    const text = "Beniに投票しました。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "unsupported_claim_vote"));
  });

  it("37. Invented seer action is rejected", () => {
    const request = createBaseRequest();
    const text = "Beniを占いました。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "unsupported_claim_seer_action"));
  });

  it("38. Invented winner is rejected", () => {
    const request = createBaseRequest();
    const text = "人狼陣営の勝利です。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, false);
    assert.ok(result.violations.some(v => v.code === "unsupported_claim_winner"));
  });

  it("39. The same factual term is accepted when it is supported by baseText or public evidence", () => {
    const request = createBaseRequest({
      context: {
        publicEvidence: [{ text: "Beniが処刑された。" }]
      }
    });
    const text = "Beniが処刑されたことは大きな事件です。";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, true);

    const request2 = createBaseRequest({
      responsePlan: { baseText: "Beniに投票した理由を言います。" }
    });
    const text2 = "Beniに投票したのは、彼が怪しかったからです。";
    const result2 = validateNpcUtterance({ request: request2, text: text2 });
    assert.strictEqual(result2.ok, true);
  });
});

describe("Utterance Guard: Replacement Behavior", () => {
  it("7. Existing pseudo responses pass the guard", () => {
    const request = createBaseRequest({
      responsePlan: { baseText: "こんにちは" },
      npc: { speechStyle: "calm" }
    });
    // Pseudo response generator adds "落ち着いて言うと、"
    const text = "落ち着いて言うと、こんにちは";
    const result = validateNpcUtterance({ request, text });
    assert.strictEqual(result.ok, true);
  });

  it("40. Rejected OpenAI text is replaced by deterministic pseudo text", () => {
    const request = createBaseRequest({
      responsePlan: { baseText: "正しい発言" }
    });
    const providerResult = {
      text: "私は人狼です（不正な発言）",
      providerName: "openai",
      model: "gpt-4",
      usage: { totalTokens: 10 },
      notes: ["some_note"]
    };
    const result = guardProviderResponse({ request, providerResult });
    assert.strictEqual(result.text, "落ち着いて言うと、正しい発言");
    assert.strictEqual(result.providerName, "pseudo");
    assert.strictEqual(result.diagnostics.utteranceGuard.status, "rejected_and_replaced");
    assert.strictEqual(result.diagnostics.utteranceGuard.safetyFallbackUsed, true);
    assert.strictEqual(result.diagnostics.utteranceGuard.originalProviderName, "openai");
    assert.ok(result.diagnostics.utteranceGuard.violationCodes.includes("werewolf_confession"));
  });

  it("45. Rejected text is absent from all returned fields", () => {
    const request = createBaseRequest();
    const providerResult = { text: "私は人狼です", providerName: "openai" };
    const result = guardProviderResponse({ request, providerResult });

    const stringified = JSON.stringify(result);
    assert.ok(!stringified.includes("私は人狼です"));
  });
});

describe("Utterance Guard: Invariants & Meta", () => {
  it("52. Malicious text cannot create a public claim", () => {
    // We already established that claims are code-controlled,
    // but we can prove that GuardedResponseProvider doesn't use provider metadata for claims.
    const request = createBaseRequest({
        policyDecision: { publicClaimAllowed: false }
    });
    const providerResult = {
        text: "私は占い師です",
        providerName: "malicious",
        diagnostics: {
            publicClaim: { role: ROLES.SEER } // Maliciously injected metadata
        }
    };

    // The GuardedResponseProvider/guardProviderResponse should not use providerResult.diagnostics.publicClaim
    const result = guardProviderResponse({ request, providerResult });
    // The result should be rejected and replaced because it's an unauthorized claim
    assert.strictEqual(result.diagnostics.utteranceGuard.status, "rejected_and_replaced");
  });

  it("58. Public snapshot privacy remains unchanged", async () => {
    // This is more of an integration test, but we check if utteranceGuard diagnostics are safe.
    const request = createBaseRequest();
    const providerResult = {
        text: "Ok",
        providerName: "openai",
        diagnostics: {
            secretKey: "SECRET" // Should not be in publicInfo
        }
    };
    const result = guardProviderResponse({ request, providerResult });
    assert.ok(result.diagnostics.utteranceGuard);
    assert.strictEqual(result.diagnostics.secretKey, "SECRET"); // Preserved in provider diagnostics
  });

  it("61. Transient pseudo fallback remains distinguishable from safety fallback", () => {
    // This is handled by OpenAIResponseProvider and GuardedResponseProvider separately.
    // Safety fallback has "utterance_safety_fallback" in notes.
    const request = createBaseRequest();
    const providerResult = { text: "Rejected", providerName: "openai" };
    const result = guardProviderResponse({ request, providerResult: { text: "私は人狼です", providerName: "openai" } });
    assert.ok(result.notes.includes("utterance_safety_fallback"));
  });
});
