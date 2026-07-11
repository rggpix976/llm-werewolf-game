export const SCHEMA_VERSION = 1;
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const enums = Object.freeze({
  supportedLocale: ["ja", "ja-JP", "en", "en-US"],
  gameRole: ["seer", "werewolf", "citizen"],
  claimableRole: ["seer", "werewolf", "citizen"],
  claimResult: ["werewolf", "not_werewolf"],
  questionTopic: ["role", "result", "vote", "suspicion", "opinion", "reasoning", "rules", "other"],
  gamePhase: ["day_discussion", "player_question", "npc_response", "vote", "execution", "night", "seer_action", "werewolf_attack", "win_check"],
  commentaryIntent: ["acknowledge", "ponder", "decline", "ask_for_clarification", "neutral_reaction"],
  toneTag: ["formal", "casual", "brief", "detailed"],
  variantLifecycle: ["active", "retired"],
  declineReason: ["not_allowed", "insufficient_public_information", "unsupported_topic"],
  clarificationReason: ["ambiguous_target", "ambiguous_intent", "multiple_alternatives", "uninterpretable"],
  finalizationReason: ["renderer_selected", "renderer_timeout_fallback", "renderer_abort_fallback", "renderer_error_fallback", "renderer_invalid_output_fallback"]
});

export const candidateFields = Object.freeze({
  non_game_statement: [], question: ["targetId", "topic"], suspicion: ["targetId"],
  vote_declaration: ["targetId"], role_claim: ["claimedRole"], result_claim: ["targetId", "result"],
  information_request: ["topic"], uninterpretable: ["reason"]
});

export const acceptedTypeForCandidate = Object.freeze(Object.fromEntries(
  Object.keys(candidateFields).filter((type) => type !== "uninterpretable")
    .map((type) => [type, `accepted_${type}`])
));

export const eventFields = Object.freeze({
  public_statement_recorded: [], public_question_recorded: ["targetId", "topic"],
  suspicion_expressed: ["targetId"], vote_declared: ["targetId"],
  role_claim_recorded: ["claimId"], result_claim_recorded: ["claimId"]
});

export const descriptorFields = Object.freeze({
  role_claim: ["claimedRole"], result_claim: ["targetId", "result"], vote_declaration: ["targetId"],
  suspicion: ["targetId"], answer: ["topic"], acknowledgement: ["referenceId"], pondering: ["topic"],
  decline: ["reason"], clarification_request: ["reason", "allowedTargetIds?"]
});

export const canonicalDescriptorTypes = Object.freeze(["role_claim", "result_claim", "vote_declaration", "suspicion"]);
export const commentaryDescriptorTypes = Object.freeze(["answer", "acknowledgement", "pondering", "decline", "clarification_request"]);
