/**
 * Validates and sanitizes the NPC response request.
 * Returns a new object containing only allowed fields.
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
    evidenceUsed: validateStringArray(input.evidenceUsed, "evidenceUsed", 0, 20, 200)
  };

  return validated;
}

function validateNpc(npc) {
  if (!npc || typeof npc !== "object") throw createValidationError("Missing or invalid npc");
  return {
    id: validateString(npc.id, "npc.id", 1, 50),
    name: validateString(npc.name, "npc.name", 1, 50),
    personality: validateString(npc.personality, "npc.personality", 0, 500),
    speechStyle: validateString(npc.speechStyle, "npc.speechStyle", 1, 50),
    conversationPolicy: validateConversationPolicy(npc.conversationPolicy)
  };
}

function validateConversationPolicy(policy) {
  if (!policy || typeof policy !== "object") throw createValidationError("Missing or invalid conversationPolicy");
  return {
    truthfulness: validateString(policy.truthfulness, "policy.truthfulness", 0, 100),
    roleClaim: validateString(policy.roleClaim, "policy.roleClaim", 0, 100),
    allowedTactics: validateStringArray(policy.allowedTactics, "policy.allowedTactics", 0, 10, 100),
    forbidden: validateStringArray(policy.forbidden, "policy.forbidden", 0, 10, 100)
  };
}

function validateContext(context) {
  if (!context || typeof context !== "object") throw createValidationError("Missing or invalid context");
  return {
    day: validateInt(context.day, "context.day", 1, 30),
    phase: validateString(context.phase, "context.phase", 1, 50),
    publicEvidence: validateEvidenceArray(context.publicEvidence, "context.publicEvidence"),
    shareableKnownEvidence: validateEvidenceArray(context.shareableKnownEvidence, "context.shareableKnownEvidence"),
    privateStanceEvidence: validateEvidenceArray(context.privateStanceEvidence, "context.privateStanceEvidence"),
    publicClaims: validateClaimsArray(context.publicClaims, "context.publicClaims"),
    intent: validateIntent(context.intent),
    topSuspect: validateTopSuspect(context.topSuspect)
  };
}

function validateIntent(intent) {
  if (!intent || typeof intent !== "object") return null;
  return {
    asksWerewolfIdentity: Boolean(intent.asksWerewolfIdentity),
    asksRoleOrClaim: Boolean(intent.asksRoleOrClaim),
    asksVoteReason: Boolean(intent.asksVoteReason)
  };
}

function validateTopSuspect(suspect) {
  if (!suspect || typeof suspect !== "object") return null;
  return {
    id: validateString(suspect.id, "topSuspect.id", 1, 50),
    name: validateString(suspect.name, "topSuspect.name", 1, 50),
    score: validateInt(suspect.score, "topSuspect.score", -100, 100)
  };
}

function validateEvidenceArray(arr, name) {
  if (!Array.isArray(arr)) return [];
  if (arr.length > 20) throw createValidationError(`${name} too many items`);
  return arr.slice(0, 20).map((item, i) => {
    if (!item || typeof item !== "object") throw createValidationError(`Invalid item in ${name} at ${i}`);
    return {
      day: validateInt(item.day, `${name}[${i}].day`, 1, 30),
      phase: validateString(item.phase, `${name}[${i}].phase`, 0, 50),
      type: validateString(item.type, `${name}[${i}].type`, 1, 50),
      text: validateString(item.text, `${name}[${i}].text`, 1, 500)
    };
  });
}

function validateClaimsArray(arr, name) {
  if (!Array.isArray(arr)) return [];
  if (arr.length > 20) throw createValidationError(`${name} too many items`);
  return arr.map((item, i) => {
    if (!item || typeof item !== "object") throw createValidationError(`Invalid item in ${name} at ${i}`);
    return {
      day: validateInt(item.day, `${name}[${i}].day`, 1, 30),
      actorId: validateString(item.actorId, `${name}[${i}].actorId`, 1, 50),
      actorName: validateString(item.actorName, `${name}[${i}].actorName`, 1, 50),
      role: validateString(item.role, `${name}[${i}].role`, 1, 50),
      results: validateResultsArray(item.results, `${name}[${i}].results`)
    };
  });
}

function validateResultsArray(arr, name) {
  if (!Array.isArray(arr)) return [];
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
  if (!decision || typeof decision !== "object") throw createValidationError("Missing or invalid policyDecision");
  return {
    publicClaimAllowed: Boolean(decision.publicClaimAllowed),
    publicClaim: decision.publicClaim ? {
       day: validateInt(decision.publicClaim.day, "publicClaim.day", 1, 30),
       actorId: validateString(decision.publicClaim.actorId, "publicClaim.actorId", 1, 50),
       actorName: validateString(decision.publicClaim.actorName, "publicClaim.actorName", 1, 50),
       role: validateString(decision.publicClaim.role, "publicClaim.role", 1, 50),
       results: validateResultsArray(decision.publicClaim.results, "publicClaim.results")
    } : null,
    disclosedHiddenInfo: Boolean(decision.disclosedHiddenInfo)
  };
}

function validateResponsePlan(plan) {
  if (!plan || typeof plan !== "object") throw createValidationError("Missing or invalid responsePlan");
  return {
    baseText: validateString(plan.baseText, "responsePlan.baseText", 1, 1000),
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
  if (!Number.isSafeInteger(val)) throw createValidationError(`${name} must be a safe integer`);
  if (val < min || val > max) throw createValidationError(`${name} out of range`);
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
