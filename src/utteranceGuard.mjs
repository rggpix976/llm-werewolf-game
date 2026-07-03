/**
 * Maximum length for NPC utterances in characters (Unicode code points).
 */
export const MAX_NPC_UTTERANCE_CHARS = 240;

/**
 * Validates the structural shape of an NPC utterance.
 *
 * @param {any} text The text to validate.
 * @returns {object} The validation result.
 */
export function validateNpcUtteranceStructure(text) {
  const violations = [];

  if (typeof text !== "string") {
    violations.push({ code: "not_a_string" });
    return {
      ok: false,
      normalizedText: null,
      violations,
      metrics: { characterCount: 0 },
    };
  }

  // 1. Normalization
  // Apply Unicode NFKC normalization
  const normalizedUntrimmed = text.normalize("NFKC");

  // 2. Inspect the normalized untrimmed value for disallowed characters
  if (normalizedUntrimmed.includes("\n")) {
    violations.push({ code: "line_feed_not_allowed" });
  }
  if (normalizedUntrimmed.includes("\r")) {
    violations.push({ code: "carriage_return_not_allowed" });
  }
  if (normalizedUntrimmed.includes("\t")) {
    violations.push({ code: "tab_not_allowed" });
  }
  if (normalizedUntrimmed.includes("\u2028") || normalizedUntrimmed.includes("\u2029")) {
    violations.push({ code: "unicode_separator_not_allowed" });
  }

  // Invisible format characters
  if (normalizedUntrimmed.includes("\u200B") || normalizedUntrimmed.includes("\uFEFF")) {
    violations.push({ code: "invisible_character_not_allowed" });
  }

  // General control characters (C0/C1)
  const otherControlRegex = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
  if (otherControlRegex.test(normalizedUntrimmed)) {
    violations.push({ code: "control_characters_not_allowed" });
  }

  // Bidi overrides or isolation characters
  if (/[\u202A-\u202E\u2066-\u2069]/.test(normalizedUntrimmed)) {
    violations.push({ code: "bidi_characters_not_allowed" });
  }

  // 3. Trim only explicitly permitted ordinary surrounding spaces (U+0020 Space and U+3000 Ideographic Space)
  const ordinaryTrimmed = normalizedUntrimmed.replace(/^[ \u3000]+|[ \u3000]+$/g, "");

  // 4. Character count using Unicode code points
  const characterCount = [...ordinaryTrimmed].length;

  // Empty and whitespace checks
  if (characterCount === 0) {
    if (normalizedUntrimmed.length > 0) {
      violations.push({ code: "whitespace_only" });
    } else {
      violations.push({ code: "empty_string" });
    }
  } else {
    // 5. Reject whitespace-only utterances (any Unicode whitespace)
    if (/^\s+$/u.test(ordinaryTrimmed)) {
      violations.push({ code: "whitespace_only" });
    }
  }

  if (characterCount > MAX_NPC_UTTERANCE_CHARS) {
    violations.push({ code: "too_long" });
  }

  // 6. Structural checks on trimmed text
  // Markdown code fences
  if (ordinaryTrimmed.includes("```")) {
    violations.push({ code: "markdown_code_fence_not_allowed" });
  }

  // HTML or script markup
  if (/<[a-z/][^>]*>/i.test(ordinaryTrimmed)) {
    violations.push({ code: "html_markup_not_allowed" });
  }

  // JSON object or array wrappers
  if (/^\{.*\}$/.test(ordinaryTrimmed)) {
    violations.push({ code: "json_object_not_allowed" });
  }
  if (/^\[.*\]$/.test(ordinaryTrimmed)) {
    violations.push({ code: "json_array_not_allowed" });
  }

  // Markdown headings
  if (/^#+\s/.test(ordinaryTrimmed)) {
    violations.push({ code: "markdown_heading_not_allowed" });
  }

  // Markdown lists
  if (/^[\*\+\-]\s/.test(ordinaryTrimmed) || /^\d+\.\s+/.test(ordinaryTrimmed)) {
    violations.push({ code: "markdown_list_not_allowed" });
  }

  // Role prefixes (detecting optional spaces before the colon)
  if (/^(assistant|system|user)\s*:\s*/i.test(ordinaryTrimmed)) {
    violations.push({ code: "role_prefix_not_allowed" });
  }

  // Explanatory prefaces
  if (/^(回答|応答|発言)\s*:\s*/.test(ordinaryTrimmed)) {
    violations.push({ code: "explanatory_preface_not_allowed" });
  }

  // Stage direction wrappers
  const stageKeywords = "笑う|考え込む|ため息をつく|泣く|驚く|怒る|微笑む|頷く|首を振る";
  const stageDirectionRegex = new RegExp(`^(\\((${stageKeywords})\\)|\\[(${stageKeywords})\\]|\\*(${stageKeywords})\\*)|(\\((${stageKeywords})\\)|\\[(${stageKeywords})\\]|\\*(${stageKeywords})\\*)$`);
  if (stageDirectionRegex.test(ordinaryTrimmed)) {
    violations.push({ code: "stage_direction_not_allowed" });
  }

  const ok = violations.length === 0;

  return {
    ok,
    normalizedText: ok ? ordinaryTrimmed : null,
    violations,
    metrics: {
      characterCount,
    },
  };
}

/**
 * Validates NPC utterance role claims and secrecy.
 *
 * @param {object} params Validation parameters.
 * @returns {object} The validation result.
 */
export function validateNpcUtteranceRoleAndSecrecy({
  text,
  speaker,
  publicPlayers,
  publicClaimAllowed,
  publicClaim,
  privateSeerResults,
}) {
  // 1. Layering: Structural validation first
  const structuralResult = validateNpcUtteranceStructure(text);
  if (!structuralResult.ok) {
    return structuralResult;
  }

  const normalizedText = structuralResult.normalizedText;
  const violations = [];

  // Defensive validation of input data (fail closed if malformed)
  let rosterOk = true;
  if (!Array.isArray(publicPlayers)) {
    rosterOk = false;
  } else {
    const ids = new Set();
    const names = new Set();
    for (const p of publicPlayers) {
      try {
        if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.id || typeof p.name !== "string" || !p.name) {
          rosterOk = false;
          break;
        }
        if (ids.has(p.id) || names.has(p.name)) {
          rosterOk = false;
          break;
        }
        ids.add(p.id);
        names.add(p.name);
      } catch (e) {
        rosterOk = false;
        break;
      }
    }
  }

  // Patterns for role detection
  const ROLE_TERMS = ["人狼", "狼", "占い師", "騎士", "狩人", "霊媒師", "霊能者", "村人", "市民"];
  const SELF_PRONOUNS = "私|自分|俺|僕";

  /**
   * Checks if the text contains an affirmative claim of a role.
   * @param {string} txt
   * @param {string} roleName
   * @param {string} actorName
   * @returns {boolean}
   */
  const containsAffirmativeClaim = (txt, roleName, actorName) => {
    const actorPart = actorName ? `|${actorName}` : "";
    const affirmativePatterns = [
      new RegExp(`(${SELF_PRONOUNS}${actorPart})[はが].*${roleName}(です|だ)`),
      new RegExp(`${roleName}CO`),
    ];

    const denialPatterns = [
      new RegExp(`(${SELF_PRONOUNS}${actorPart})[はが].*${roleName}では(ありません|ない)`),
      new RegExp(`${roleName}COはしません`),
      new RegExp(`${roleName}ではありません`),
    ];

    for (const pattern of affirmativePatterns) {
      const matches = [...txt.matchAll(new RegExp(pattern, "g"))];
      for (const match of matches) {
        const matchText = match[0];
        const matchIndex = match.index;

        let isDenial = false;
        for (const denial of denialPatterns) {
          const denialMatches = [...txt.matchAll(new RegExp(denial, "g"))];
          if (denialMatches.some(dm => dm.index <= matchIndex && dm.index + dm[0].length >= matchIndex + matchText.length)) {
            isDenial = true;
            break;
          }
        }
        if (!isDenial) return true;
      }
    }
    return false;
  };

  /**
   * Detects if the text contains a seer-result-like claim for a target.
   * @param {string} txt
   * @param {string} targetName
   * @param {string} result "human" | "werewolf"
   * @returns {boolean}
   */
  const containsSeerResultClaim = (txt, targetName, result) => {
    const escapedName = targetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const suffix = "(さんは|さんが|は|が|を|さんを)";

    const werewolfPatterns = [
      "黒です", "人狼でした", "占い結果は黒です", "を占った結果、人狼でした",
      "黒", "人狼だった", "の占い結果は黒", "を占った結果、人狼"
    ];
    const humanPatterns = [
      "白です", "村人でした", "人狼ではありません", "占い結果は白です", "を占った結果、村人でした",
      "白", "村人だった", "の占い結果は白", "を占った結果、村人", "を占った結果、人狼ではなかった"
    ];

    const patterns = result === "werewolf" ? werewolfPatterns : humanPatterns;

    for (const p of patterns) {
      if (p.startsWith("の") || p.startsWith("を")) {
        if (new RegExp(`${escapedName}${p}([。!！？…\\s]|$)`).test(txt)) return true;
        // Formal prefix matching
        if (p.includes("占い結果は")) {
            if (new RegExp(`${escapedName}の占い結果は${result === "werewolf" ? "黒" : "白"}`).test(txt)) return true;
        }
        if (p.includes("占った結果")) {
            if (new RegExp(`${escapedName}(さん)?を占った結果、${result === "werewolf" ? "人狼" : "(村人|人狼ではなかった)"}`).test(txt)) return true;
        }
      } else if (p === "黒" || p === "白" || p === "人狼だった" || p === "村人だった" || p === "人狼でした" || p === "村人でした") {
        if (new RegExp(`${escapedName}${suffix}${p}([。!！？…\\s]|$)`).test(txt)) return true;
      } else {
        if (new RegExp(`${escapedName}${suffix}${p}`).test(txt)) return true;
      }
    }
    return false;
  };

  const anyRoleClaimed = ROLE_TERMS.find(rt => containsAffirmativeClaim(normalizedText, rt, speaker?.name));

  let claimedResults = [];
  if (rosterOk) {
    for (const player of publicPlayers) {
      if (containsSeerResultClaim(normalizedText, player.name, "werewolf")) {
        claimedResults.push({ targetId: player.id, targetName: player.name, result: "werewolf" });
      }
      if (containsSeerResultClaim(normalizedText, player.name, "human")) {
        claimedResults.push({ targetId: player.id, targetName: player.name, result: "human" });
      }
    }
  }

  // 2. Werewolf confession rule
  if (speaker?.role === "werewolf") {
    if (containsAffirmativeClaim(normalizedText, "人狼", speaker.name) || containsAffirmativeClaim(normalizedText, "狼", speaker.name)) {
      violations.push({ code: "werewolf_confession_not_allowed" });
    }
  }

  // 4. Approved public Seer claim (and secrecy)
  const checkPublicClaimContract = () => {
    if (!publicClaim || typeof publicClaim !== "object") return "public_claim_contract_invalid";
    try {
      if (typeof publicClaim.actorId !== "string" || !publicClaim.actorId) return "public_claim_contract_invalid";
      if (typeof publicClaim.actorName !== "string" || !publicClaim.actorName) return "public_claim_contract_invalid";
      if (publicClaim.actorId !== speaker?.id) return "public_claim_actor_mismatch";
      if (publicClaim.role !== "seer") return "public_claim_role_mismatch";
      if (!Array.isArray(publicClaim.results) || publicClaim.results.length === 0) return "public_claim_contract_invalid";

      const seenTargets = new Set();
      for (const res of publicClaim.results) {
        if (!res || typeof res !== "object") return "public_claim_contract_invalid";
        if (typeof res.targetId !== "string" || !res.targetId) return "public_claim_contract_invalid";
        if (typeof res.targetName !== "string" || !res.targetName) return "public_claim_contract_invalid";
        if (res.result !== "human" && res.result !== "werewolf") return "public_claim_contract_invalid";
        if (seenTargets.has(res.targetId)) return "public_claim_contract_invalid";
        seenTargets.add(res.targetId);

        if (!rosterOk) return "public_claim_contract_invalid";
        if (!publicPlayers.some(p => p.id === res.targetId && p.name === res.targetName)) return "public_claim_target_mismatch";
      }
    } catch (e) {
      return "public_claim_contract_invalid";
    }
    return null;
  };

  if (publicClaimAllowed === true) {
    if (anyRoleClaimed || claimedResults.length > 0) {
      const contractError = checkPublicClaimContract();
      if (contractError) {
        violations.push({ code: contractError });
      } else {
        if (anyRoleClaimed && anyRoleClaimed !== "占い師") {
          violations.push({ code: "public_claim_role_mismatch" });
        }

        const approvedResults = publicClaim.results;
        for (const claimed of claimedResults) {
          const approved = approvedResults.find(r => r.targetId === claimed.targetId);
          if (!approved) {
            violations.push({ code: "public_claim_extra_result" });
          } else if (approved.result !== claimed.result) {
            violations.push({ code: "public_claim_result_mismatch" });
          }
        }
      }
    }
  } else {
    // 3. Unauthorized role claims
    if (anyRoleClaimed) {
      violations.push({ code: "role_claim_not_allowed" });
    }
  }

  // 5. Private Seer-result disclosure
  if (Array.isArray(privateSeerResults)) {
    for (const privateRes of privateSeerResults) {
      if (containsSeerResultClaim(normalizedText, privateRes.targetName, privateRes.result)) {
        let authorized = false;
        if (publicClaimAllowed && publicClaim && Array.isArray(publicClaim.results)) {
          const approved = publicClaim.results.find(r => r.targetId === privateRes.targetId);
          if (approved && approved.result === privateRes.result) {
            authorized = true;
          }
        }
        if (!authorized) {
          violations.push({ code: "private_seer_result_disclosure" });
          break;
        }
      }
    }
  }

  if (!rosterOk && (anyRoleClaimed || (rosterOk && claimedResults.length > 0) || containsAffirmativeClaim(normalizedText, "占い師", speaker?.name))) {
    if (!violations.some(v => v.code === "public_claim_contract_invalid" || v.code === "role_claim_not_allowed" || v.code === "private_seer_result_disclosure" || v.code === "werewolf_confession_not_allowed")) {
      violations.push({ code: "public_claim_contract_invalid" });
    }
  }

  const ok = violations.length === 0;

  return {
    ok,
    normalizedText: ok ? normalizedText : null,
    violations: violations.map(v => ({ code: v.code })),
    metrics: structuralResult.metrics,
  };
}
