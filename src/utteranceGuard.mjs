/**
 * Maximum length for NPC utterances in characters (Unicode code points).
 */
export const MAX_NPC_UTTERANCE_CHARS = 240;

/**
 * Validates the structural shape of an NPC utterance.
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

  const normalizedUntrimmed = text.normalize("NFKC");

  if (normalizedUntrimmed.includes("\n")) violations.push({ code: "line_feed_not_allowed" });
  if (normalizedUntrimmed.includes("\r")) violations.push({ code: "carriage_return_not_allowed" });
  if (normalizedUntrimmed.includes("\t")) violations.push({ code: "tab_not_allowed" });
  if (normalizedUntrimmed.includes("\u2028") || normalizedUntrimmed.includes("\u2029")) violations.push({ code: "unicode_separator_not_allowed" });
  if (normalizedUntrimmed.includes("\u200B") || normalizedUntrimmed.includes("\uFEFF")) violations.push({ code: "invisible_character_not_allowed" });

  const otherControlRegex = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
  if (otherControlRegex.test(normalizedUntrimmed)) violations.push({ code: "control_characters_not_allowed" });

  if (/[\u202A-\u202E\u2066-\u2069]/.test(normalizedUntrimmed)) violations.push({ code: "bidi_characters_not_allowed" });

  const ordinaryTrimmed = normalizedUntrimmed.replace(/^[ \u3000]+|[ \u3000]+$/g, "");
  const characterCount = [...ordinaryTrimmed].length;

  if (characterCount === 0) {
    if (normalizedUntrimmed.length > 0) violations.push({ code: "whitespace_only" });
    else violations.push({ code: "empty_string" });
  } else if (/^\s+$/u.test(ordinaryTrimmed)) {
    violations.push({ code: "whitespace_only" });
  }

  if (characterCount > MAX_NPC_UTTERANCE_CHARS) violations.push({ code: "too_long" });

  if (ordinaryTrimmed.includes("```")) violations.push({ code: "markdown_code_fence_not_allowed" });
  if (/<[a-z/][^>]*>/i.test(ordinaryTrimmed)) violations.push({ code: "html_markup_not_allowed" });
  if (/^\{.*\}$/.test(ordinaryTrimmed)) violations.push({ code: "json_object_not_allowed" });
  if (/^\[.*\]$/.test(ordinaryTrimmed)) violations.push({ code: "json_array_not_allowed" });
  if (/^#+\s/.test(ordinaryTrimmed)) violations.push({ code: "markdown_heading_not_allowed" });
  if (/^[\*\+\-]\s/.test(ordinaryTrimmed) || /^\d+\.\s+/.test(ordinaryTrimmed)) violations.push({ code: "markdown_list_not_allowed" });
  if (/^(assistant|system|user)\s*:\s*/i.test(ordinaryTrimmed)) violations.push({ code: "role_prefix_not_allowed" });
  if (/^(回答|応答|発言)\s*:\s*/.test(ordinaryTrimmed)) violations.push({ code: "explanatory_preface_not_allowed" });

  const stageKeywords = "笑う|考え込む|ため息をつく|泣く|驚く|怒る|微笑む|頷く|首を振る";
  const stageDirectionRegex = new RegExp(`^(\\((${stageKeywords})\\)|\\[(${stageKeywords})\\]|\\*(${stageKeywords})\\*)|(\\((${stageKeywords})\\)|\\[(${stageKeywords})\\]|\\*(${stageKeywords})\\*)$`);
  if (stageDirectionRegex.test(ordinaryTrimmed)) violations.push({ code: "stage_direction_not_allowed" });

  const ok = violations.length === 0;
  return { ok, normalizedText: ok ? ordinaryTrimmed : null, violations, metrics: { characterCount } };
}

/**
 * Pure helpers for schema validation.
 */
const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const isBoundedString = (v, min, max) => typeof v === "string" && v.length >= min && v.length <= max;

function validateSpeakerSchema(s) {
  try {
    if (!isPlainObject(s)) return false;
    if (!isBoundedString(s.id, 1, 64) || !isBoundedString(s.name, 1, 64)) return false;
    return ["citizen", "seer", "werewolf"].includes(s.role);
  } catch { return false; }
}

function validateRosterSchema(p) {
  try {
    if (!Array.isArray(p)) return false;
    const ids = new Set();
    const names = new Set();
    for (const player of p) {
      if (!isPlainObject(player)) return false;
      if (!isBoundedString(player.id, 1, 64) || !isBoundedString(player.name, 1, 64)) return false;
      if (ids.has(player.id) || names.has(player.name)) return false;
      ids.add(player.id);
      names.add(player.name);
    }
    return true;
  } catch { return false; }
}

function validateClaimSchema(c) {
  try {
    if (!isPlainObject(c)) return false;
    if (!isBoundedString(c.actorId, 1, 64) || !isBoundedString(c.actorName, 1, 64)) return false;
    if (c.role !== "seer") return false;
    if (!Array.isArray(c.results) || c.results.length === 0) return false;
    for (const r of c.results) {
      if (!isPlainObject(r)) return false;
      if (!isBoundedString(r.targetId, 1, 64) || !isBoundedString(r.targetName, 1, 64)) return false;
      if (r.result !== "human" && r.result !== "werewolf") return false;
    }
    return true;
  } catch { return false; }
}

/**
 * Validates role claims and secrecy.
 */
export function validateNpcUtteranceRoleAndSecrecy(input) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return createInvalidInputResult();

    const { text, speaker, publicPlayers, publicClaimAllowed, publicClaim, privateSeerResults } = input;

    const structuralResult = validateNpcUtteranceStructure(text);
    if (!structuralResult.ok) return structuralResult;

    const normalizedText = structuralResult.normalizedText;

    if (!validateSpeakerSchema(speaker) || !validateRosterSchema(publicPlayers)) {
      return createInvalidInputResult(structuralResult.metrics);
    }

    // 1. Disclosure check (highest priority)
    const disclosureViolation = checkPrivateDisclosure(normalizedText, privateSeerResults, publicClaim, publicClaimAllowed, speaker);
    if (disclosureViolation) return createViolationResult(disclosureViolation, structuralResult.metrics);

    // 2. Werewolf confession check
    if (speaker.role === "werewolf" && isAffirmativeRoleClaim(normalizedText, "werewolf", speaker.name)) {
      return createViolationResult("werewolf_confession_not_allowed", structuralResult.metrics);
    }

    // 3. Unauthorized role claim check
    const restrictedRoles = ["seer", "knight", "hunter", "medium", "citizen"];
    for (const role of restrictedRoles) {
      if (isAffirmativeRoleClaim(normalizedText, role, speaker.name)) {
        if (!publicClaimAllowed || role !== "seer") {
          return createViolationResult("role_claim_not_allowed", structuralResult.metrics);
        }
      }
    }

    // 4. Seer result claims
    const claimAnalysis = analyzeSeerResultClaims(normalizedText, publicPlayers);
    if (claimAnalysis.hasClaim) {
      if (!publicClaimAllowed) return createViolationResult("role_claim_not_allowed", structuralResult.metrics);
      const contractViolation = validateClaimAgainstContract(claimAnalysis.claims, publicClaim, speaker);
      if (contractViolation) return createViolationResult(contractViolation, structuralResult.metrics);
    }

    return structuralResult;
  } catch (err) {
    return createInvalidInputResult();
  }
}

function createInvalidInputResult(metrics = { characterCount: 0 }) {
  return { ok: false, normalizedText: null, violations: [{ code: "validation_input_invalid" }], metrics };
}

function createViolationResult(code, metrics) {
  return { ok: false, normalizedText: null, violations: [{ code }], metrics };
}

const DENIAL_ENDINGS = ["ではない", "ではありません", "ではないです", "はしません", "ではないと言いましたが", "ではありませんでした", "ではなかった"];
const SPECULATION_ENDINGS = ["かもしれない", "かもしれません", "だと思う", "と思っています", "の可能性がある", "を考えています", "だと断定するには早いです"];
const AFFIRMATIVE_ENDINGS = ["です", "だ", "である", "でした", "だった", "だといいます", "ですが"];

function isDenied(text) { return DENIAL_ENDINGS.some(e => text.startsWith(e)); }
function isSpeculation(text) { return SPECULATION_ENDINGS.some(e => text.startsWith(e)); }
function isAffirmative(text) {
  if (AFFIRMATIVE_ENDINGS.some(e => text.startsWith(e))) return true;
  if (/^[、。！？ 　]/.test(text) || text === "") return true;
  return false;
}

function getTermsForRole(role) {
  switch (role) {
    case "werewolf": return ["人狼", "狼"];
    case "seer": return ["占い師"];
    case "knight": return ["騎士", "狩人"];
    case "medium": return ["霊媒師", "霊能者"];
    case "citizen": return ["村人", "市民"];
    default: return [];
  }
}

/**
 * Detection logic for generic result claims (targets may not be in roster).
 */
function analyzeSeerResultClaims(text, players) {
  const claims = [];
  let hasClaim = isAffirmativeRoleClaim(text, "seer");

  // Recognize patterns like: [Target] (さん)? (は|が|の|を) ... (黒|白|人狼|狼|村人|市民)
  const prefix = "(?:(?:さん)?(?:を占った結果(?:、|は)?|の占い結果は|は|が|の|を)(?:、|は)?)";
  const resultTerms = "(黒|白|人狼|狼|村人|市民)";
  const genericRegex = new RegExp(`([^\\s、。！？ 　]{1,64})${prefix}${resultTerms}`, "g");

  let m;
  while ((m = genericRegex.exec(text)) !== null) {
    const matchedFullPrefix = m[0].slice(m[1].length);
    let targetName = m[1];
    let term = m[2];

    // Refine targetName if it accidentally included part of the formal prefix
    if (targetName.endsWith("の占い結果") && matchedFullPrefix.startsWith("は")) {
        targetName = targetName.slice(0, -5);
    } else if (targetName.endsWith("を占った結果") && (matchedFullPrefix.startsWith("は") || matchedFullPrefix.startsWith("、"))) {
        targetName = targetName.slice(0, -6);
    }

    const after = text.slice(m.index + m[0].length);
    if (isSpeculation(after)) continue;

    let res = null;
    if (["黒", "人狼", "狼"].includes(term)) {
      res = isDenied(after) ? "human" : (isAffirmative(after) ? "werewolf" : null);
    } else {
      res = isDenied(after) ? "werewolf" : (isAffirmative(after) ? "human" : null);
    }

    if (res) {
      hasClaim = true;
      const player = players.find(p => p.name === targetName);
      claims.push({
        targetId: player ? player.id : `unknown-${targetName}`,
        targetName,
        result: res
      });
    }
  }

  return { hasClaim, claims };
}

function checkPrivateDisclosure(text, privateResults, publicClaim, publicClaimAllowed, speaker) {
  if (!Array.isArray(privateResults)) return null;

  for (const res of privateResults) {
    const name = escapeRegex(res.targetName);
    const prefix = "(?:(?:さん)?(?:を占った結果(?:、|は)?|の占い結果は|は|が|の|を)(?:、|は)?)";
    const resultTerms = "(黒|白|人狼|狼|村人|市民)";
    const regex = new RegExp(`${name}${prefix}${resultTerms}`, "g");

    let m;
    while ((m = regex.exec(text)) !== null) {
      const term = m[1];
      const after = text.slice(m.index + m[0].length);
      if (isSpeculation(after)) continue;

      let detectedResult = null;
      if (["黒", "人狼", "狼"].includes(term)) {
        detectedResult = isDenied(after) ? "human" : (isAffirmative(after) ? "werewolf" : null);
      } else {
        detectedResult = isDenied(after) ? "werewolf" : (isAffirmative(after) ? "human" : null);
      }

      if (detectedResult === res.result) {
        if (!isAuthorizedDisclosure(res, detectedResult, publicClaim, publicClaimAllowed, speaker)) {
          return "private_seer_result_disclosure";
        }
      }
    }
  }
  return null;
}

function isAuthorizedDisclosure(privateRes, detectedResult, publicClaim, publicClaimAllowed, speaker) {
  if (!publicClaimAllowed || !validateClaimSchema(publicClaim)) return false;
  if (publicClaim.actorId !== speaker.id || publicClaim.actorName !== speaker.name) return false;
  const approved = publicClaim.results.find(r => r.targetId === privateRes.targetId);
  return approved && approved.targetName === privateRes.targetName && approved.result === detectedResult;
}

function validateClaimAgainstContract(detectedClaims, publicClaim, speaker) {
  if (!validateClaimSchema(publicClaim)) return "public_claim_contract_invalid";
  if (publicClaim.actorId !== speaker.id || publicClaim.actorName !== speaker.name) return "public_claim_actor_mismatch";

  const contractTargets = new Map();
  for (const res of publicClaim.results) {
    if (contractTargets.has(res.targetId)) return "public_claim_contract_invalid";
    contractTargets.set(res.targetId, res);
  }

  const detectedByTarget = new Map();
  for (const dc of detectedClaims) {
    if (!detectedByTarget.has(dc.targetId)) detectedByTarget.set(dc.targetId, []);
    detectedByTarget.get(dc.targetId).push(dc);
  }

  if (detectedByTarget.size > contractTargets.size) {
    for (const tid of detectedByTarget.keys()) {
      if (!contractTargets.has(tid)) return "public_claim_target_mismatch";
    }
    return "public_claim_extra_result";
  }

  for (const [tid, claims] of detectedByTarget) {
    const expected = contractTargets.get(tid);
    if (!expected) return "public_claim_target_mismatch";
    for (const dc of claims) {
      if (expected.result !== dc.result) return "public_claim_result_mismatch";
      if (expected.targetName !== dc.targetName) return "public_claim_target_mismatch";
    }
  }
  return null;
}

function isAffirmativeRoleClaim(text, role, speakerName) {
  const roleTerms = getTermsForRole(role);
  const selfRefs = ["私", "自分", "俺", "僕", "本当", "実際"];
  if (speakerName) selfRefs.push(speakerName);

  for (const rt of roleTerms) {
    if (new RegExp(`${escapeRegex(rt)}CO(?:[、。！？ 　]|$)`).test(text)) return true;
    for (const sr of selfRefs) {
      const p = new RegExp(`${escapeRegex(sr)}(?:は|が)${escapeRegex(rt)}`, "g");
      let m;
      while ((m = p.exec(text)) !== null) {
        const after = text.slice(m.index + m[0].length);
        if (isAffirmative(after) && !isDenied(after)) return true;
      }
    }
  }
  return false;
}

function escapeRegex(string) { return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
