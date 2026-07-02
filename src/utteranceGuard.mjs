import { generatePseudoResponseText } from "./responseGenerator.mjs";
import { ROLES } from "./constants.mjs";
import { normalize } from "./textUtils.mjs";

/**
 * Maximum character count for a single NPC utterance.
 */
export const MAX_UTTERANCE_LENGTH = 240;

/**
 * Valid fields for provider diagnostics allowed to reach the developer log.
 */
const ALLOWED_DIAGNOSTIC_FIELDS = new Set([
  "responseId",
  "requestId",
  "httpStatus",
  "providerStatus",
  "fallbackUsed",
  "retryCount"
]);

/**
 * Builds a code-controlled contract from the production NPC response request.
 */
export function buildUtteranceContract(request) {
  return {
    npcId: request.npc.id,
    npcName: request.npc.name,
    baseText: request.responsePlan.baseText,
    publicClaimAllowed: request.policyDecision.publicClaimAllowed,
    publicClaim: request.policyDecision.publicClaim,
    publicEvidence: request.context.publicEvidence,
    privateStanceEvidence: request.context.privateStanceEvidence,
    shareableKnownEvidence: request.context.shareableKnownEvidence
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

  const namePrefixPattern = new RegExp(`^${contract.npcName}[:：\\s]`, "i");
  if (namePrefixPattern.test(trimmed)) {
    violations.push({ code: "contains_name_prefix" });
  }

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
    [ROLES.WEREWOLF]: ["人狼", "狼"],
    "knight": ["騎士", "狩人", "knight"],
    "medium": ["霊媒師", "霊能者", "medium"]
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
      return patterns.some(p => {
        const idx = normalized.indexOf(p);
        if (idx === -1) return false;
        const remaining = normalized.slice(idx + p.length);
        return !isDenialSuffix(remaining);
      });
    });
  };

  const isDenialSuffix = (text) => {
    const denialSuffixes = ["ではありません", "ではない", "ではないです", "じゃない"];
    return denialSuffixes.some(suffix => text.startsWith(suffix));
  };

  if (!contract.publicClaimAllowed) {
    for (const role in roleKeywords) {
      if (isAffirmativeClaim(role)) {
        violations.push({ code: "role_disclosure_not_allowed" });
        break;
      }
    }
  } else {
    if (!contract.publicClaim || !contract.publicClaim.role) {
        violations.push({ code: "missing_approved_claim_data" });
    } else {
        const approvedRole = contract.publicClaim.role;
        for (const role in roleKeywords) {
            if (role !== approvedRole && isAffirmativeClaim(role)) {
                violations.push({ code: "mismatched_role_claim" });
                break;
            }
        }
    }
  }

  // Build Disclosure Patterns
  const buildRevealPatterns = (name, result) => {
    const isWolf = result === "werewolf" || result === "black";
    const base = isWolf
      ? [name + "は人狼", name + "は黒", name + "が人狼"]
      : [name + "は市民", name + "は白", name + "は人狼ではありません", name + "は人狼ではない", name + "は人狼じゃない"];

    const variations = [
      ...base,
      ...base.map(p => name + "さん" + p.slice(name.length)),
      name + "の占い結果は" + (isWolf ? "人狼" : "白"),
      name + "の占い結果は" + (isWolf ? "黒" : "白"),
      name + "の占い結果は" + (isWolf ? "人狼" : "市民"),
      name + "を占った結果、" + (isWolf ? "人狼" : "白"),
      name + "を占った結果、" + (isWolf ? "黒" : "白"),
      name + "を占った結果、" + (isWolf ? "人狼" : "市民")
    ];

    const withSan = variations.map(v => v.replace(name, name + "さん"));
    return [...new Set([...variations, ...withSan])];
  };

  const privateResults = contract.privateStanceEvidence.filter(e => e.type === "seer_result");
  const approvedResults = (contract.publicClaimAllowed && contract.publicClaim?.role === ROLES.SEER)
    ? (contract.publicClaim.results || [])
    : [];

  // Check private results for unauthorized disclosure
  for (const res of privateResults) {
    const targetName = normalize(res.targetName);
    const patterns = buildRevealPatterns(targetName, res.result);

    if (patterns.some(p => normalized.includes(p))) {
      const isApproved = approvedResults.some(r => r.targetId === res.targetId && r.result === res.result);
      if (!isApproved) {
        violations.push({ code: "private_result_disclosure" });
      }
    }
  }

  // Trusted targets and all potential subjects
  const trustedTargets = contract.shareableKnownEvidence.filter(e => e.targetName).map(e => normalize(e.targetName));
  const otherTargets = new Set();
  privateResults.forEach(e => { if (e.targetName) otherTargets.add(normalize(e.targetName)); });
  const allKnownTargets = [...new Set([...trustedTargets, ...otherTargets])];

  // General unauthorized disclosure check (Section 4 reinforced)
  // Check every alignment keyword associated with ANY target
  const words = extractTokens(normalized);
  for (const word of words) {
      // Find matches for target names
      const matchedKnownTarget = allKnownTargets.find(t => word.startsWith(t));
      if (matchedKnownTarget) {
          const name = matchedKnownTarget;
          for (const resType of ["werewolf", "not_werewolf"]) {
              const patterns = buildRevealPatterns(name, resType);
              if (patterns.some(p => normalized.includes(p))) {
                  const isApproved = approvedResults.some(r => {
                      const rName = normalize(getNpcNameById(contract, r.targetId));
                      return rName === name && r.result === resType;
                  });

                  const grounded = patterns.some(p => baseNormalized.includes(p)) ||
                                   contract.publicEvidence.some(e => patterns.some(p => normalize(e.text).includes(p)));

                  if (!isApproved && !grounded) {
                      violations.push({ code: "unauthorized_disclosure" });
                  }
              }
          }
      }
  }

  // Structured Fact Grounding (Section 5)
  const highRiskEvents = [
    { pattern: "処刑され", key: "execution" },
    { pattern: "襲撃され", key: "attack" },
    { pattern: "占いました", key: "seer_action" },
    { pattern: "占った", key: "seer_action" },
    { pattern: "投票し", key: "vote" },
    { pattern: "勝利", key: "winner" },
    { pattern: "死亡", key: "death" }
  ];

  for (const event of highRiskEvents) {
    if (normalized.includes(event.pattern)) {
        if (event.key === "winner") {
             const supported = baseNormalized.includes(event.pattern) || contract.publicEvidence.some(e => normalize(e.text).includes(event.pattern));
             if (!supported) violations.push({ code: "unsupported_claim_winner" });
             continue;
        }

        let eventFoundInUtterance = false;

        for (const word of words) {
            const factPrefixes = [word + "は", word + "を", word + "に", word + "さんが", word + "さんを", word + "さんに", word + "さんは"];
            const votePatterns = [word + "に投票", word + "さんに投票"];

            const utteranceHasFact = factPrefixes.some(pref => normalized.includes(pref + event.pattern)) ||
                                   (event.key === "vote" && votePatterns.some(p => normalized.includes(p)));

            if (utteranceHasFact) {
                eventFoundInUtterance = true;
                const matchedTrustedTarget = trustedTargets.find(t => word.startsWith(t));

                if (matchedTrustedTarget) {
                    const tName = matchedTrustedTarget;
                    const factPrefixesT = [tName + "は", tName + "を", tName + "に", tName + "さんが", tName + "さんを", tName + "さんに", tName + "さんは"];

                    const supportedByBase = factPrefixesT.some(pref => baseNormalized.includes(pref + event.pattern)) ||
                                            (event.key === "vote" && baseNormalized.includes(tName) && baseNormalized.includes("投票"));

                    const supportedByPublic = contract.publicEvidence.some(e => {
                        const n = normalize(e.text);
                        return factPrefixesT.some(pref => n.includes(pref + event.pattern)) ||
                               (event.key === "vote" && n.includes(tName) && n.includes("投票"));
                    });

                    if (!supportedByBase && !supportedByPublic) {
                        violations.push({ code: `unsupported_claim_${event.key}` });
                    }
                } else {
                    violations.push({ code: `unsupported_claim_${event.key}_invented_target` });
                }
            }
        }

        if (!eventFoundInUtterance) {
             const supported = baseNormalized.includes(event.pattern) || contract.publicEvidence.some(e => normalize(e.text).includes(event.pattern));
             if (!supported) violations.push({ code: `unsupported_claim_${event.key}_generic` });
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

function getNpcNameById(contract, id) {
    const evidence = contract.shareableKnownEvidence.find(e => e.targetId === id);
    return evidence ? evidence.targetName : id;
}

function extractTokens(txt) {
    return txt.split(/[^a-zA-Z0-9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]+|[はをにが行]/).filter(w => w.length > 1);
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
    return {
      text: generatePseudoResponseText(request),
      providerName: "pseudo",
      model: "template-v1",
      usage: null,
      notes: ["utterance_safety_fallback"],
      diagnostics: {
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

  let result;
  if (validation.ok) {
    result = {
      text: validation.normalizedText,
      providerName: providerResult.providerName,
      model: providerResult.model,
      usage: sanitizeUsage(providerResult.usage),
      notes: sanitizeNotes(providerResult.notes),
      diagnostics: {
        ...sanitizeDiagnostics(providerResult.diagnostics),
        utteranceGuard: {
          status: "accepted",
          safetyFallbackUsed: false,
          originalProviderName: providerResult.providerName,
          violationCodes: [],
          originalTextLength: validation.metrics.characterCount
        }
      }
    };
  } else {
    result = {
      text: generatePseudoResponseText(request),
      providerName: "pseudo",
      model: "template-v1",
      usage: sanitizeUsage(providerResult.usage),
      notes: sanitizeNotes(providerResult.notes, "utterance_safety_fallback"),
      diagnostics: {
        ...sanitizeDiagnostics(providerResult.diagnostics),
        utteranceGuard: {
          status: "rejected_and_replaced",
          safetyFallbackUsed: true,
          originalProviderName: providerResult.providerName,
          replacementProviderName: "pseudo",
          violationCodes: [...new Set(validation.violations.map(v => v.code))],
          originalTextLength: validation.metrics.characterCount
        }
      }
    };
  }

  if (!validation.ok && providerResult.text) {
      if (containsRejectedText(result, providerResult.text)) {
           return {
               text: result.text,
               providerName: "pseudo",
               model: "template-v1",
               notes: ["utterance_safety_fallback", "emergency_leak_protection"],
               diagnostics: {
                   utteranceGuard: {
                       status: "rejected_and_wiped",
                       safetyFallbackUsed: true,
                       originalProviderName: providerResult.providerName,
                       replacementProviderName: "pseudo"
                   }
               }
           };
      }
  }

  return result;
}

function containsRejectedText(obj, rejectedText) {
    const serialized = JSON.stringify(obj);
    return serialized.includes(rejectedText);
}

function sanitizeUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    const inputTokens = Number.isInteger(usage.inputTokens) ? usage.inputTokens : (Number.isInteger(usage.input_tokens) ? usage.input_tokens : null);
    const outputTokens = Number.isInteger(usage.outputTokens) ? usage.outputTokens : (Number.isInteger(usage.output_tokens) ? usage.output_tokens : null);
    const totalTokens = Number.isInteger(usage.totalTokens) ? usage.totalTokens : (Number.isInteger(usage.total_tokens) ? usage.total_tokens : null);

    const result = {};
    if (inputTokens !== null) result.inputTokens = inputTokens;
    if (outputTokens !== null) result.outputTokens = outputTokens;
    if (totalTokens !== null) result.totalTokens = totalTokens;
    return Object.keys(result).length > 0 ? result : null;
}

function sanitizeNotes(notes, extra) {
    const safe = Array.isArray(notes) ? notes.filter(n => typeof n === "string" && n.length < 100) : [];
    if (extra) safe.push(extra);
    return safe;
}

function sanitizeDiagnostics(diag) {
    if (!diag || typeof diag !== "object") return {};
    const safe = {};
    for (const key of ALLOWED_DIAGNOSTIC_FIELDS) {
        if (Object.hasOwn(diag, key)) {
            safe[key] = diag[key];
        }
    }
    return safe;
}
