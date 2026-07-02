/**
 * Maximum length for NPC utterances in characters.
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

  // Basic whitespace check
  if (text.length > 0 && text.trim().length === 0) {
    violations.push({ code: "whitespace_only" });
  }

  if (text.length === 0) {
    violations.push({ code: "empty_string" });
  }

  // Normalization
  // Apply Unicode NFKC normalization and trim
  const normalizedText = text.normalize("NFKC").trim();
  const characterCount = normalizedText.length;

  if (characterCount === 0 && violations.length === 0) {
    violations.push({ code: "empty_after_normalization" });
  }

  if (characterCount > MAX_NPC_UTTERANCE_CHARS) {
    violations.push({ code: "too_long" });
  }

  // Structural checks
  if (normalizedText.includes("\n")) {
    violations.push({ code: "line_feed_not_allowed" });
  }
  if (normalizedText.includes("\r")) {
    violations.push({ code: "carriage_return_not_allowed" });
  }

  // Control characters (excluding those already handled if any)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(normalizedText)) {
    violations.push({ code: "control_characters_not_allowed" });
  }

  // Bidi overrides
  if (/[\u202A-\u202E\u2066-\u2069]/.test(normalizedText)) {
    violations.push({ code: "bidi_characters_not_allowed" });
  }

  // Markdown code fences
  if (normalizedText.includes("```")) {
    violations.push({ code: "markdown_code_fence_not_allowed" });
  }

  // HTML or script markup
  if (/<[^>]+>/.test(normalizedText)) {
    violations.push({ code: "html_markup_not_allowed" });
  }

  // JSON object or array wrappers
  if (/^\s*\{.*\}\s*$/.test(normalizedText)) {
    violations.push({ code: "json_object_not_allowed" });
  }
  if (/^\s*\[.*\]\s*$/.test(normalizedText)) {
    violations.push({ code: "json_array_not_allowed" });
  }

  // Markdown headings
  if (/^#+\s/.test(normalizedText)) {
    violations.push({ code: "markdown_heading_not_allowed" });
  }

  // Markdown lists
  if (/^[\*\+\-]\s/.test(normalizedText)) {
    violations.push({ code: "markdown_list_not_allowed" });
  }
  if (/^\d+\.\s/.test(normalizedText)) {
    violations.push({ code: "markdown_list_not_allowed" });
  }

  // Role prefixes
  if (/^(assistant|system|user):\s*/i.test(normalizedText)) {
    violations.push({ code: "role_prefix_not_allowed" });
  }

  // Explanatory prefaces
  if (/^(回答|応答|発言):\s*/.test(normalizedText)) {
    violations.push({ code: "explanatory_preface_not_allowed" });
  }

  // Stage directions
  if (/（.*）/.test(normalizedText) || /\(.*\)/.test(normalizedText)) {
    violations.push({ code: "stage_direction_not_allowed" });
  }
  if (/\[.*\]/.test(normalizedText)) {
    violations.push({ code: "stage_direction_not_allowed" });
  }
  if (/\*.*\*/.test(normalizedText)) {
    violations.push({ code: "stage_direction_not_allowed" });
  }

  const ok = violations.length === 0;

  return {
    ok,
    normalizedText: ok ? normalizedText : null,
    violations,
    metrics: {
      characterCount,
    },
  };
}
