import { generatePseudoResponseText } from "./responseGenerator.mjs";
import { ROLES } from "./constants.mjs";
import { normalize } from "./textUtils.mjs";

/**
 * Maximum character count for a single NPC utterance.
 */
export const MAX_UTTERANCE_LENGTH = 240;

/**
 * Builds a code-controlled contract from the production NPC response request.
 * This ensures we only use trusted information for validation.
 */
export function buildUtteranceContract(request) {
  return {
    npcId: request.npc.id,
    npcName: request.npc.name,
    baseText: request.responsePlan.baseText,
    publicClaimAllowed: request.policyDecision.publicClaimAllowed,
    publicClaim: request.policyDecision.publicClaim,
    publicEvidence: request.context.publicEvidence,
    privateStanceEvidence: request.context.privateStanceEvidence
  };
}

/**
 * Validates an NPC utterance against structural, role, secrecy, and factual grounding rules.
 */
export function validateNpcUtterance({ request, text }) {
  const contract = buildUtteranceContract(request);
  const violations = [];
  const metrics = { characterCount: typeof text === "string" ? text.length : 0 };

  if (typeof text !== "string") {
    violations.push({ code: "not_a_string" });
    return { ok: false, normalizedText: null, violations, metrics };
  }

  const trimmed = text.trim();
  if (trimmed === "") {
    violations.push({ code: "empty_utterance" });
    return { ok: false, normalizedText: null, violations, metrics };
  }

  if (trimmed.length > MAX_UTTERANCE_LENGTH) {
    violations.push({ code: "too_long" });
  }

  if (/\r|\n/.test(trimmed)) {
    violations.push({ code: "contains_line_breaks" });
  }

  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    violations.push({ code: "contains_control_characters" });
  }

  if (/[\u202A-\u202E]/.test(trimmed)) {
    violations.push({ code: "contains_bidirectional_override" });
  }

  if (/```/.test(trimmed)) {
    violations.push({ code: "contains_code_fence" });
  }

  if (/<[^>]*>/.test(trimmed)) {
    violations.push({ code: "contains_html_or_script" });
  }

  if (/^\s*\{.*\}\s*$/.test(trimmed) || /^\s*\[.*\]\s*$/.test(trimmed)) {
    violations.push({ code: "looks_like_json" });
  }

  if (/^\s*#|^\s*[-*]\s/.test(trimmed)) {
    violations.push({ code: "contains_markdown_structure" });
  }

  if (/^(system|assistant|user):/i.test(trimmed)) {
    violations.push({ code: "contains_role_prefix" });
  }

  // Reject NPC name prefix (e.g., "Aoi: ...")
  const namePrefixPattern = new RegExp(`^${contract.npcName}[:：\s]`, "i");
  if (namePrefixPattern.test(trimmed)) {
    violations.push({ code: "contains_name_prefix" });
  }

  // Stage directions or explanatory wrappers
  if (hasSuspiciousWrapper(trimmed) && !hasSuspiciousWrapper(contract.baseText)) {
    violations.push({ code: "contains_stage_direction_or_wrapper" });
  }

  const normalized = normalize(trimmed);
  const baseNormalized = normalize(contract.baseText);

  // Werewolf confession
  const confessionKeywords = ["私は人狼です", "自分が人狼です", "人狼co", "狼co"];
  if (confessionKeywords.some(kw => normalized.includes(kw))) {
    violations.push({ code: "werewolf_confession" });
  }

  // Unauthorized role claims
  const roleKeywords = {
    [ROLES.SEER]: ["占い師", "占いco", "seer"],
    [ROLES.CITIZEN]: ["市民", "村人"],
    [ROLES.WEREWOLF]: ["人狼", "狼"]
  };

  const isAffirmativeClaim = (role) => {
    const keywords = roleKeywords[role] || [];
    return keywords.some(kw => {
      const patterns = [
        kw + "です",
        kw + "co",
        "私が" + kw,
        "私は" + kw
      ];
      return patterns.some(p => normalized.includes(p)) && !isDenial(normalized, kw);
    });
  };

  const isDenial = (text, kw) => {
    const denialSuffixes = ["ではありません", "ではない", "ではないです", "じゃない"];
    return denialSuffixes.some(suffix => text.includes(kw + suffix));
  };

  if (!contract.publicClaimAllowed) {
    if (isAffirmativeClaim(ROLES.SEER) || isAffirmativeClaim(ROLES.CITIZEN) || isAffirmativeClaim(ROLES.WEREWOLF)) {
      violations.push({ code: "role_disclosure_not_allowed" });
    }
  } else {
    const allowedRole = contract.publicClaim.role;
    for (const role of Object.values(ROLES)) {
      if (role !== allowedRole && isAffirmativeClaim(role)) {
        violations.push({ code: "mismatched_role_claim" });
      }
    }
    // If it's a seer claim, verify target and result if possible
    if (allowedRole === ROLES.SEER && contract.publicClaim.results) {
        // We ensure that it doesn't invent DIFFERENT results than the approved ones.
        // This is tricky with natural language, but we can at least check for mentions of other players + result.
    }
  }

  // Private seer results disclosure
  const privateResults = contract.privateStanceEvidence.filter(e => e.type === "seer_result");
  for (const res of privateResults) {
    const targetName = normalize(res.targetName);
    const isWolf = res.result === "werewolf";

    const revealPatterns = isWolf
      ? [targetName + "は人狼", targetName + "は黒", targetName + "が人狼"]
      : [targetName + "は市民", targetName + "は白", targetName + "は人狼ではありません", targetName + "は人狼ではない", targetName + "は人狼じゃない", targetName + "は人狼ではな", targetName + "は人狼でな", targetName + "は人狼じゃな"];

    if (revealPatterns.some(p => normalized.includes(p))) {
      const isAllowedByClaim = contract.publicClaimAllowed &&
        contract.publicClaim.role === ROLES.SEER &&
        contract.publicClaim.results.some(r => normalize(r.targetId) === normalize(res.targetId) && r.result === res.result);

      if (!isAllowedByClaim) {
        violations.push({ code: "private_result_disclosure" });
      }
    }
  }

  // Unsupported game-state claims
  const highRiskPatterns = [
    { pattern: "処刑されました", key: "execution" },
    { pattern: "処刑された", key: "execution" },
    { pattern: "襲撃されました", key: "attack" },
    { pattern: "襲撃された", key: "attack" },
    { pattern: "占いました", key: "seer_action" },
    { pattern: "占った", key: "seer_action" },
    { pattern: "投票しました", key: "vote" },
    { pattern: "投票した", key: "vote" },
    { pattern: "勝利です", key: "winner" },
    { pattern: "勝利した", key: "winner" },
    { pattern: "死亡しました", key: "death" },
    { pattern: "死亡した", key: "death" }
  ];

  for (const item of highRiskPatterns) {
    if (normalized.includes(item.pattern)) {
      const supportedByBase = baseNormalized.includes(item.pattern);
      const supportedByPublic = contract.publicEvidence.some(e => normalize(e.text).includes(item.pattern));
      if (!supportedByBase && !supportedByPublic) {
        violations.push({ code: `unsupported_claim_${item.key}` });
      }
    }
  }

  return {
    ok: violations.length === 0,
    normalizedText: violations.length === 0 ? trimmed : null,
    violations,
    metrics
  };
}

function hasSuspiciousWrapper(text) {
  return /\(.*\)|（.*）|\[.*\]|［.*］|\{.*\}|｛.*｝/.test(text);
}

/**
 * Guards a provider response. If invalid, replaces with a safe pseudo-response.
 */
export function guardProviderResponse({ request, providerResult }) {
  let validation;
  try {
    validation = validateNpcUtterance({ request, text: providerResult.text });
  } catch (error) {
    // Fail-closed on internal guard error
    return {
      text: generatePseudoResponseText(request),
      providerName: "pseudo",
      model: "template-v1",
      usage: providerResult.usage,
      notes: [
        ...(providerResult.notes || []),
        "utterance_safety_fallback"
      ],
      diagnostics: {
        ...providerResult.diagnostics,
        utteranceGuard: {
          status: "internal_error_fallback",
          safetyFallbackUsed: true,
          originalProviderName: providerResult.providerName,
          replacementProviderName: "pseudo",
          violationCodes: ["internal_guard_error"]
        }
      }
    };
  }

  if (validation.ok) {
    return {
      ...providerResult,
      text: validation.normalizedText,
      diagnostics: {
        ...providerResult.diagnostics,
        utteranceGuard: {
          status: "accepted",
          safetyFallbackUsed: false,
          originalProviderName: providerResult.providerName,
          violationCodes: [],
          originalTextLength: validation.metrics.characterCount
        }
      }
    };
  }

  // Reject and replace
  const safeText = generatePseudoResponseText(request);
  return {
    text: safeText,
    providerName: "pseudo",
    model: "template-v1",
    usage: providerResult.usage,
    notes: [
      ...(providerResult.notes || []),
      "utterance_safety_fallback"
    ],
    diagnostics: {
      ...providerResult.diagnostics,
      utteranceGuard: {
        status: "rejected_and_replaced",
        safetyFallbackUsed: true,
        originalProviderName: providerResult.providerName,
        replacementProviderName: "pseudo",
        violationCodes: validation.violations.map(v => v.code),
        originalTextLength: validation.metrics.characterCount
      }
    }
  };
}
