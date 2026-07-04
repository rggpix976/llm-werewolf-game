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
 * Pure NPC Role-claim and Secrecy Validation
 */

const MAX_ID_NAME_CHARS = 64;
const MAX_PUBLIC_PLAYERS = 16;
const MAX_CLAIM_RESULTS = 16;
const MAX_PRIVATE_RESULTS = 16;

const ROLE_TERMS = {
  werewolf: ["人狼", "狼"],
  seer: ["占い師"],
  knight: ["騎士", "狩人"],
  medium: ["霊媒師", "霊能者"],
  citizen: ["村人", "市民"],
};

const ALIGNMENT_TERMS = {
  werewolf: ["黒", "人狼", "狼"],
  human: ["白", "村人", "市民"],
};

const SELF_PRONOUNS = ["私", "自分", "俺", "僕"];
const DENIAL_SUFFIXES = ["ではありません", "ではなかった", "ではないです", "じゃありません", "ではありませんでした", "ではなかったです", "ではないと言いましたが", "はしません", "ではないかと"];
const SPECULATION_SUFFIXES = ["だと思います", "のだと思います", "かもしれない", "かもしれません", "だと思う", "と思っています", "のだと思います", "でしょう", "の可能性がある", "を考えています", "だと断定するには早いです"];
const AFFIRMATIVE_SUFFIXES = ["です", "だ", "である", "でした", "だった", "判定です", "判定でした", "判定だった", "します", "しました", "ですが", "でしょうが"];
const REFERENCE_KEYWORDS = ["を疑っています", "を疑う", "の発言を確認", "を確認したい", "を確認します"];

/**
 * Validates role claims and secrecy.
 */
export function validateNpcUtteranceRoleAndSecrecy(input) {
  try {
    if (!isPlainObject(input)) return createViolationResult("validation_input_invalid");

    const { text, speaker, publicPlayers, publicClaimAllowed, publicClaim, privateSeerResults } = input;

    const structuralResult = validateNpcUtteranceStructure(text);
    if (!structuralResult.ok) return structuralResult;
    const normalizedText = structuralResult.normalizedText;

    if (publicClaimAllowed !== true && publicClaimAllowed !== false) {
      return createViolationResult("validation_input_invalid", structuralResult.metrics);
    }

    // Top-level schema validation for speaker and roster
    if (!validateSpeakerSchema(speaker) || !validateRosterSchema(publicPlayers)) {
      return createViolationResult("validation_input_invalid", structuralResult.metrics);
    }

    // Public claim contract validation (returns specific codes)
    if (publicClaimAllowed === true && publicClaim !== null && publicClaim !== undefined) {
      const claimContractViolation = checkClaimContractSanity(publicClaim, speaker, publicPlayers, privateSeerResults);
      if (claimContractViolation) {
          return createViolationResult(claimContractViolation, structuralResult.metrics);
      }
    }

    // Private results contract validation
    if (privateSeerResults !== undefined) {
        if (!validatePrivateResultsSchema(privateSeerResults, publicPlayers)) {
            return createViolationResult("validation_input_invalid", structuralResult.metrics);
        }
    }

    const claims = getAllClaims(normalizedText, speaker, publicPlayers);

    // 1. Werewolf confession (highest priority safety check)
    const selfWerewolfClaim = claims.find(c => c.type === "role" && c.role === "werewolf" && c.actorId === speaker.id && c.status === "affirmative");
    if (speaker.role === "werewolf" && selfWerewolfClaim) {
      return createViolationResult("werewolf_confession_not_allowed", structuralResult.metrics);
    }

    // 2. Secrecy disclosure
    if (Array.isArray(privateSeerResults)) {
      for (const res of privateSeerResults) {
        const disclosure = claims.find(c => c.type === "result" && c.targetId === res.targetId && c.result === res.result && c.status === "affirmative");
        if (disclosure) {
          if (!isAuthorizedDisclosure(res, disclosure.result, publicClaim, publicClaimAllowed, speaker)) {
            return createViolationResult("private_seer_result_disclosure", structuralResult.metrics);
          }
        }
      }
    }

    // 3. Unauthorized role/result claims or Contract violations
    if (publicClaimAllowed === false) {
      // "reject affirmative self-role claims" AND any other affirmative role/result claims per reviewer
      const aff = claims.find(c => (c.type === "role" || c.type === "result") && c.status === "affirmative");
      if (aff) {
          // Double check if it's a confession (different code)
          if (speaker.role === "werewolf" && aff.type === "role" && aff.role === "werewolf" && aff.actorId === speaker.id) {
              return createViolationResult("werewolf_confession_not_allowed", structuralResult.metrics);
          }
          return createViolationResult("role_claim_not_allowed", structuralResult.metrics);
      }
    } else {
      // publicClaimAllowed is true
      if (claims.some(c => c.status === "affirmative")) {
        const violation = validateDetectedClaimsAgainstContract(claims, publicClaim, speaker);
        if (violation) return createViolationResult(violation, structuralResult.metrics);
      }
    }

    return structuralResult;
  } catch (err) {
    return createViolationResult("validation_input_invalid");
  }
}

function getAllClaims(text, speaker, roster) {
  const claims = [];
  const selfRefs = [...SELF_PRONOUNS, "本当", "実際", speaker.name];
  const escapedSelfRefs = selfRefs.map(escapeRegex).sort((a, b) => b.length - a.length);
  const escapedRosterNames = roster.map(p => escapeRegex(p.name)).sort((a, b) => b.length - a.length);

  const matchedSpans = [];

  const roleTerms = Object.values(ROLE_TERMS).flat();
  const escapedRoleTerms = roleTerms.map(escapeRegex).sort((a, b) => b.length - a.length);
  const escapedAlignmentTerms = Object.values(ALIGNMENT_TERMS).flat().map(escapeRegex).sort((a, b) => b.length - a.length);

  const nameCapturePattern = `(${escapedRosterNames.length > 0 ? escapedRosterNames.join("|") + "|" : ""}[^\\s、。！？ 　]{1,64}?)`;

  // 1. Actor-prefixed CO syntax (e.g. "Beniは人狼COです")
  const actorCoRegex = new RegExp(`${nameCapturePattern}(?:さん)?(?:は|が)(${escapedRoleTerms.join("|")})CO`, "g");
  let m;
  while ((m = actorCoRegex.exec(text)) !== null) {
      const actor = resolveActor(m[1], speaker, roster);
      const status = getStatus(text, m.index + m[0].length);
      if (status === "reference" || status === "speculative") {
          matchedSpans.push({ start: m.index, end: m.index + m[0].length });
          continue;
      }
      claims.push({
          type: "role",
          actorId: actor ? actor.id : null,
          actorName: actor ? actor.name : null,
          role: getRoleFromTerm(m[2]),
          status: status || "affirmative",
          start: m.index,
          end: m.index + m[0].length
      });
      matchedSpans.push({ start: m.index, end: m.index + m[0].length });
  }

  // 2. Explicit Seer-result syntax (e.g. "Beniの占い結果は...")
  const explicitResultPrefix = "(?:(?:さん)?(?:を占った結果(?:、|は)?|の占い結果は))";
  const explicitResultRegex = new RegExp(`${nameCapturePattern}${explicitResultPrefix}(${escapedAlignmentTerms.join("|")})`, "g");
  while ((m = explicitResultRegex.exec(text)) !== null) {
    if (isOverlapping(m.index, m.index + m[0].length, matchedSpans)) continue;
    const target = resolveActor(m[1], speaker, roster);
    const baseAlignment = getAlignmentFromTerm(m[2]);
    const status = getStatus(text, m.index + m[0].length);
    if (status === "reference" || status === "speculative") {
        matchedSpans.push({ start: m.index, end: m.index + m[0].length });
        continue;
    }
    const { result, finalStatus } = applyAlignmentInversion(baseAlignment, status || "affirmative", true);
    claims.push({ type: "result", targetId: target ? target.id : null, targetName: target ? target.name : m[1], result, status: finalStatus, start: m.index, end: m.index + m[0].length });
    matchedSpans.push({ start: m.index, end: m.index + m[0].length });
  }

  // 3. Bare CO forms (Self)
  const bareCoRegex = new RegExp(`(?:^|[、。！？ 　])(${escapedRoleTerms.join("|")})CO(?![a-zA-Z0-9])`, "g");
  while ((m = bareCoRegex.exec(text)) !== null) {
    if (isOverlapping(m.index, m.index + m[0].length, matchedSpans)) continue;
    const status = getStatus(text, m.index + m[0].length);
    if (status === "reference" || status === "speculative") {
        matchedSpans.push({ start: m.index, end: m.index + m[0].length });
        continue;
    }
    claims.push({ type: "role", actorId: speaker.id, actorName: speaker.name, role: getRoleFromTerm(m[1]), status: status || "affirmative", start: m.index, end: m.index + m[0].length });
    matchedSpans.push({ start: m.index, end: m.index + m[0].length });
  }

  // 4. Self-subject role claims (explicit pronouns)
  const selfSubjectRegex = new RegExp(`(${escapedSelfRefs.join("|")})(?:は|が)(${escapedRoleTerms.join("|")})`, "g");
  while ((m = selfSubjectRegex.exec(text)) !== null) {
    if (isOverlapping(m.index, m.index + m[0].length, matchedSpans)) continue;
    const status = getStatus(text, m.index + m[0].length);
    if (status === "reference" || status === "speculative") {
        matchedSpans.push({ start: m.index, end: m.index + m[0].length });
        continue;
    }
    claims.push({ type: "role", actorId: speaker.id, actorName: speaker.name, role: getRoleFromTerm(m[2]), status: status || "affirmative", start: m.index, end: m.index + m[0].length });
    matchedSpans.push({ start: m.index, end: m.index + m[0].length });
  }

  // 5. Another-player alignment result (priority over role claim for ambiguous terms)
  const alignmentRegex = new RegExp(`${nameCapturePattern}(?:さん)?(?:は|が)(${escapedAlignmentTerms.join("|")})`, "g");
  while ((m = alignmentRegex.exec(text)) !== null) {
    if (isOverlapping(m.index, m.index + m[0].length, matchedSpans)) continue;
    const target = resolveActor(m[1], speaker, roster);
    const baseAlignment = getAlignmentFromTerm(m[2]);
    const status = getStatus(text, m.index + m[0].length);

    if (status === "reference" || status === "speculative") {
        matchedSpans.push({ start: m.index, end: m.index + m[0].length });
        continue;
    }

    if (target && target.id === speaker.id) {
        // Self ambiguous term -> Role claim
        claims.push({ type: "role", actorId: speaker.id, actorName: speaker.name, role: getRoleFromTerm(m[2]), status: status || "affirmative", start: m.index, end: m.index + m[0].length });
    } else {
        const { result, finalStatus } = applyAlignmentInversion(baseAlignment, status || "affirmative", true);
        claims.push({
            type: "result",
            targetId: target ? target.id : null,
            targetName: target ? target.name : m[1],
            result,
            status: finalStatus,
            start: m.index,
            end: m.index + m[0].length
        });
    }
    matchedSpans.push({ start: m.index, end: m.index + m[0].length });
  }

  // 6. Unambiguous actor-prefixed role claim
  const unambiguousRoles = ["占い師", "騎士", "狩人", "霊媒師", "霊能者"];
  const unambiguousRoleRegex = new RegExp(`${nameCapturePattern}(?:さん)?(?:は|が)(${unambiguousRoles.join("|")})`, "g");
  while ((m = unambiguousRoleRegex.exec(text)) !== null) {
    if (isOverlapping(m.index, m.index + m[0].length, matchedSpans)) continue;
    const actor = resolveActor(m[1], speaker, roster);
    const status = getStatus(text, m.index + m[0].length);
    if (status === "reference" || status === "speculative") {
        matchedSpans.push({ start: m.index, end: m.index + m[0].length });
        continue;
    }
    claims.push({
        type: "role",
        actorId: actor ? actor.id : null,
        actorName: actor ? actor.name : null,
        role: getRoleFromTerm(m[2]),
        status: status || "affirmative",
        start: m.index,
        end: m.index + m[0].length
    });
    matchedSpans.push({ start: m.index, end: m.index + m[0].length });
  }

  return claims;
}

function applyAlignmentInversion(baseAlignment, status, allowInversion) {
  if (allowInversion && status === "denied") {
    return { result: (baseAlignment === "werewolf" ? "human" : "werewolf"), finalStatus: "affirmative" };
  }
  return { result: baseAlignment, finalStatus: status };
}

function isOverlapping(start, end, spans) {
  return spans.some(s => (start < s.end && end > s.start));
}

function resolveActor(name, speaker, roster) {
  if (name === speaker.name || SELF_PRONOUNS.includes(name) || name === "本当" || name === "実際") {
    return { id: speaker.id, name: speaker.name };
  }
  const p = roster.find(p => p.name === name);
  if (p) return { id: p.id, name: p.name };
  return null;
}

function getStatus(text, afterIndex) {
  const after = text.slice(afterIndex);
  for (const kw of REFERENCE_KEYWORDS) if (after.startsWith(kw)) return "reference";
  for (const s of SPECULATION_SUFFIXES) if (after.startsWith(s)) return "speculative";
  for (const s of DENIAL_SUFFIXES) if (after.startsWith(s)) return "denied";
  for (const s of AFFIRMATIVE_SUFFIXES) if (after.startsWith(s)) return "affirmative";
  if (/^[、。！？ 　]/.test(after) || after === "") return "affirmative";
  return null;
}

function getRoleFromTerm(term) {
  for (const [role, terms] of Object.entries(ROLE_TERMS)) if (terms.includes(term)) return role;
  if (ALIGNMENT_TERMS.werewolf.includes(term)) return "werewolf";
  if (ALIGNMENT_TERMS.human.includes(term)) return "citizen";
  return null;
}

function getAlignmentFromTerm(term) {
  if (ALIGNMENT_TERMS.werewolf.includes(term)) return "werewolf";
  if (ALIGNMENT_TERMS.human.includes(term)) return "human";
  return null;
}

function isAuthorizedDisclosure(res, detectedResult, publicClaim, publicClaimAllowed, speaker) {
  if (publicClaimAllowed !== true || !isPlainObject(publicClaim)) return false;
  if (publicClaim.actorId !== speaker.id || publicClaim.actorName !== speaker.name || publicClaim.role !== "seer") return false;
  if (!Array.isArray(publicClaim.results)) return false;
  const approved = publicClaim.results.find(r => r.targetId === res.targetId);
  return approved && approved.targetName === res.targetName && approved.result === detectedResult;
}

function validateDetectedClaimsAgainstContract(claims, publicClaim, speaker) {
  const affirmativeClaims = claims.filter(c => c.status === "affirmative");
  if (affirmativeClaims.length === 0) return null;

  for (const c of affirmativeClaims) {
    if (c.type === "role" && c.actorId !== speaker.id) return "public_claim_actor_mismatch";
  }

  if (!isPlainObject(publicClaim)) return "public_claim_contract_invalid";
  if (publicClaim.actorId !== speaker.id || publicClaim.actorName !== speaker.name) return "public_claim_actor_mismatch";
  if (publicClaim.role !== "seer") return "public_claim_role_mismatch";
  if (!Array.isArray(publicClaim.results)) return "public_claim_contract_invalid";

  const contractTargets = new Map();
  for (const res of publicClaim.results) contractTargets.set(res.targetId, res);

  for (const c of affirmativeClaims) {
    if (c.type === "role") {
      if (c.role !== "seer") return "public_claim_role_mismatch";
    } else {
      if (!c.targetId) return "public_claim_target_mismatch";
      const expected = contractTargets.get(c.targetId);
      if (!expected) return "public_claim_extra_result";
      if (expected.result !== c.result || expected.targetName !== c.targetName) return "public_claim_result_mismatch";
    }
  }
  return null;
}

function isPlainObject(v) {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isStrictBoundedString(v, min, max) {
  if (typeof v !== "string") return false;
  const cpLength = [...v].length;
  if (cpLength < min || cpLength > max) return false;
  if (v.trim().length === 0) return false;
  if (/[\x00-\x1F\x7F-\x9F\u2028\u2029\u200B\uFEFF\u202A-\u202E\u2066-\u2069]/.test(v)) return false;
  return true;
}

function validateSpeakerSchema(s) {
  if (!isPlainObject(s)) return false;
  if (!isStrictBoundedString(s.id, 1, MAX_ID_NAME_CHARS) || !isStrictBoundedString(s.name, 1, MAX_ID_NAME_CHARS)) return false;
  return ["citizen", "seer", "werewolf"].includes(s.role);
}

function validateRosterSchema(p) {
  if (!Array.isArray(p) || p.length > MAX_PUBLIC_PLAYERS) return false;
  const ids = new Set(), names = new Set();
  for (const player of p) {
    if (!isPlainObject(player) || !isStrictBoundedString(player.id, 1, MAX_ID_NAME_CHARS) || !isStrictBoundedString(player.name, 1, MAX_ID_NAME_CHARS)) return false;
    if (ids.has(player.id) || names.has(player.name)) return false;
    ids.add(player.id); names.add(player.name);
  }
  return true;
}

function checkClaimContractSanity(c, speaker, roster, privateResults) {
  if (!isPlainObject(c)) return "public_claim_contract_invalid";
  if (!isStrictBoundedString(c.actorId, 1, MAX_ID_NAME_CHARS) || !isStrictBoundedString(c.actorName, 1, MAX_ID_NAME_CHARS)) return "public_claim_contract_invalid";
  if (c.actorId !== speaker.id || c.actorName !== speaker.name) return "public_claim_actor_mismatch";
  if (c.role !== "seer") return "public_claim_role_mismatch";
  if (!Array.isArray(c.results) || c.results.length === 0 || c.results.length > MAX_CLAIM_RESULTS) return "public_claim_contract_invalid";

  const tids = new Set(), tnames = new Set();
  for (const r of c.results) {
    if (!isPlainObject(r) || !isStrictBoundedString(r.targetId, 1, MAX_ID_NAME_CHARS) || !isStrictBoundedString(r.targetName, 1, MAX_ID_NAME_CHARS) || (r.result !== "human" && r.result !== "werewolf")) return "public_claim_contract_invalid";
    if (tids.has(r.targetId) || tnames.has(r.targetName)) return "public_claim_contract_invalid";

    const player = roster.find(p => p.id === r.targetId);
    if (!player || player.name !== r.targetName) return "public_claim_target_mismatch";

    if (privateResults && Array.isArray(privateResults)) {
      const pr = privateResults.find(p => p.targetId === r.targetId);
      if (pr && pr.result !== r.result) return "public_claim_contract_invalid"; // Contradicting private result makes contract invalid
    }
    tids.add(r.targetId); tnames.add(r.targetName);
  }
  return null;
}

function validatePrivateResultsSchema(pr, roster) {
  if (!Array.isArray(pr) || pr.length > MAX_PRIVATE_RESULTS) return false;
  const tids = new Set(), tnames = new Set();
  for (const r of pr) {
    if (!isPlainObject(r) || !isStrictBoundedString(r.targetId, 1, MAX_ID_NAME_CHARS) || !isStrictBoundedString(r.targetName, 1, MAX_ID_NAME_CHARS) || (r.result !== "human" && r.result !== "werewolf")) return false;
    if (tids.has(r.targetId) || tnames.has(r.targetName)) return false;
    const player = roster.find(p => p.id === r.targetId);
    if (!player || player.name !== r.targetName) return false;
    tids.add(r.targetId); tnames.add(r.targetName);
  }
  return true;
}

function createViolationResult(code, metrics = { characterCount: 0 }) {
  return { ok: false, normalizedText: null, violations: [{ code }], metrics };
}

function escapeRegex(string) { return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
