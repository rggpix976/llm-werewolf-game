/**
 * Validates and sanitizes the NPC response request.
 * Policy: Allowlist-reconstruction. Unexpected fields are stripped.
 * Types are strictly checked; no coercion (e.g., "false" is not converted to boolean).
 */
export function validateNpcResponseRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createValidationError("Request must be a JSON object");
  }

  const validated = {
    npc: validateNpc(input.npc),
    playerInput: validateString(input.playerInput, "playerInput", 1, 1000),
    context: validateContext(input.context),
    policyDecision: validatePolicyDecision(input.policyDecision),
    responsePlan: validateResponsePlan(input.responsePlan),
    evidenceUsed: validateStringArray(input.evidenceUsed, "evidenceUsed", 0, 50, 500)
  };

  return validated;
}

function validateNpc(npc) {
  if (!npc || typeof npc !== "object" || Array.isArray(npc)) throw createValidationError("Missing or invalid npc");
  return {
    id: validateString(npc.id, "npc.id", 1, 50),
    name: validateString(npc.name, "npc.name", 1, 50),
    personality: validateString(npc.personality, "npc.personality", 0, 500),
    speechStyle: validateString(npc.speechStyle, "npc.speechStyle", 1, 50),
    conversationPolicy: validateConversationPolicy(npc.conversationPolicy)
  };
}

function validateConversationPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw createValidationError("Missing or invalid conversationPolicy");
  return {
    truthfulness: validateString(policy.truthfulness, "policy.truthfulness", 0, 100),
    roleClaim: validateString(policy.roleClaim, "policy.roleClaim", 0, 100),
    allowedTactics: validateStringArray(policy.allowedTactics, "policy.allowedTactics", 0, 20, 100),
    forbidden: validateStringArray(policy.forbidden, "policy.forbidden", 0, 20, 100)
  };
}

function validateContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) throw createValidationError("Missing or invalid context");
  return {
    day: validateInt(context.day, "context.day", 1, 100),
    phase: validateString(context.phase, "context.phase", 1, 50),
    publicEvidence: validatePublicEvidenceArray(context.publicEvidence, "context.publicEvidence"),
    shareableKnownEvidence: validateKnownEvidenceArray(context.shareableKnownEvidence, "context.shareableKnownEvidence"),
    privateStanceEvidence: validateKnownEvidenceArray(context.privateStanceEvidence, "context.privateStanceEvidence"),
    publicClaims: validateClaimsArray(context.publicClaims, "context.publicClaims"),
    intent: validateIntent(context.intent),
    topSuspect: validateTopSuspect(context.topSuspect)
  };
}

function validateIntent(intent) {
  if (intent === null) return null;
  if (typeof intent !== "object" || Array.isArray(intent)) throw createValidationError("intent must be an object or null");
  return {
    asksWerewolfIdentity: validateBoolean(intent.asksWerewolfIdentity, "intent.asksWerewolfIdentity"),
    asksRoleOrClaim: validateBoolean(intent.asksRoleOrClaim, "intent.asksRoleOrClaim"),
    asksVoteReason: validateBoolean(intent.asksVoteReason, "intent.asksVoteReason")
  };
}

function validateTopSuspect(suspect) {
  if (suspect === null) return null;
  if (typeof suspect !== "object" || Array.isArray(suspect)) throw createValidationError("topSuspect must be an object or null");
  return {
    id: validateString(suspect.id, "topSuspect.id", 1, 50),
    name: validateString(suspect.name, "topSuspect.name", 1, 50),
    score: validateInt(suspect.score, "topSuspect.score", -100, 100)
  };
}

// Public evidence from gameState.publicInfo contains day, phase, type, text, etc.
function validatePublicEvidenceArray(arr, name) {
  if (!Array.isArray(arr)) throw createValidationError(`${name} must be an array`);
  if (arr.length > 30) throw createValidationError(`${name} too many items`);
  return arr.map((item, i) => {
    if (!item || typeof item !== "object") throw createValidationError(`Invalid item in ${name} at ${i}`);
    return {
      day: validateInt(item.day, `${name}[${i}].day`, 1, 100),
      phase: validateString(item.phase, `${name}[${i}].phase`, 1, 50),
      type: validateString(item.type, `${name}[${i}].type`, 1, 50),
      text: validateString(item.text, `${name}[${i}].text`, 1, 1000)
    };
  });
}

// Known info evidence from player.knownInfo might NOT contain phase (e.g. setup info)
function validateKnownEvidenceArray(arr, name) {
  if (!Array.isArray(arr)) throw createValidationError(`${name} must be an array`);
  if (arr.length > 30) throw createValidationError(`${name} too many items`);
  return arr.map((item, i) => {
    if (!item || typeof item !== "object") throw createValidationError(`Invalid item in ${name} at ${i}`);
    return {
      day: validateInt(item.day, `${name}[${i}].day`, 1, 100),
      type: validateString(item.type, `${name}[${i}].type`, 1, 50),
      text: validateString(item.text, `${name}[${i}].text`, 1, 1000),
      // Optional fields that might exist in knownInfo
      targetId: item.targetId !== undefined ? validateString(item.targetId, `${name}[${i}].targetId`, 1, 50) : undefined,
      result: item.result !== undefined ? validateString(item.result, `${name}[${i}].result`, 1, 50) : undefined
    };
  });
}

function validateClaimsArray(arr, name) {
  if (!Array.isArray(arr)) throw createValidationError(`${name} must be an array`);
  if (arr.length > 30) throw createValidationError(`${name} too many items`);
  return arr.map((item, i) => {
    if (!item || typeof item !== "object") throw createValidationError(`Invalid item in ${name} at ${i}`);
    return {
      day: validateInt(item.day, `${name}[${i}].day`, 1, 100),
      actorId: validateString(item.actorId, `${name}[${i}].actorId`, 1, 50),
      actorName: validateString(item.actorName, `${name}[${i}].actorName`, 1, 50),
      role: validateString(item.role, `${name}[${i}].role`, 1, 50),
      results: validateResultsArray(item.results, `${name}[${i}].results`)
    };
  });
}

function validateResultsArray(arr, name) {
  if (arr === undefined || arr === null) return [];
  if (!Array.isArray(arr)) throw createValidationError(`${name} must be an array`);
  if (arr.length > 10) throw createValidationError(`${name} too many items`);
  return arr.map((item, i) => {
    if (!item || typeof item !== "object") throw createValidationError(`Invalid item in ${name} at ${i}`);
    return {
      targetId: validateString(item.targetId, `${name}[${i}].targetId`, 1, 50),
      result: validateString(item.result, `${name}[${i}].result`, 1, 50)
    };
  });
}

function validatePolicyDecision(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) throw createValidationError("Missing or invalid policyDecision");
  return {
    publicClaimAllowed: validateBoolean(decision.publicClaimAllowed, "policyDecision.publicClaimAllowed"),
    publicClaim: decision.publicClaim ? {
       day: validateInt(decision.publicClaim.day, "publicClaim.day", 1, 100),
       actorId: validateString(decision.publicClaim.actorId, "publicClaim.actorId", 1, 50),
       actorName: validateString(decision.publicClaim.actorName, "publicClaim.actorName", 1, 50),
       role: validateString(decision.publicClaim.role, "publicClaim.role", 1, 50),
       results: validateResultsArray(decision.publicClaim.results, "publicClaim.results")
    } : null,
    disclosedHiddenInfo: validateBoolean(decision.disclosedHiddenInfo, "policyDecision.disclosedHiddenInfo")
  };
}

function validateResponsePlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw createValidationError("Missing or invalid responsePlan");
  return {
    baseText: validateString(plan.baseText, "responsePlan.baseText", 1, 2000),
    speechStyle: validateString(plan.speechStyle, "responsePlan.speechStyle", 1, 50)
  };
}

function validateString(val, name, min, max) {
  if (typeof val !== "string") throw createValidationError(`${name} must be a string`);
  if (val.length < min) throw createValidationError(`${name} too short`);
  if (val.length > max) throw createValidationError(`${name} too long`);
  return val;
}

function validateInt(val, name, min, max) {
  if (typeof val !== "number" || !Number.isSafeInteger(val)) throw createValidationError(`${name} must be a safe integer`);
  if (val < min || val > max) throw createValidationError(`${name} out of range`);
  return val;
}

function validateBoolean(val, name) {
  if (typeof val !== "boolean") throw createValidationError(`${name} must be a boolean`);
  return val;
}

function validateStringArray(arr, name, minLen, maxLen, maxItemLen) {
  if (!Array.isArray(arr)) throw createValidationError(`${name} must be an array`);
  if (arr.length < minLen || arr.length > maxLen) throw createValidationError(`${name} length out of range`);
  return arr.map((item, i) => validateString(item, `${name}[${i}]`, 0, maxItemLen));
}

function createValidationError(message) {
  const error = new Error(message);
  error.status = 400;
  error.name = "ValidationError";
  return error;
}
