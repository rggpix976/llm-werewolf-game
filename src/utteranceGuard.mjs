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

  // General control characters (C0/C1)
  // Excluding \n (\x0A), \r (\x0D), \t (\x09) which are explicitly handled above
  // although they are technically control characters, we want distinct codes.
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
  }

  if (characterCount > MAX_NPC_UTTERANCE_CHARS) {
    violations.push({ code: "too_long" });
  }

  // 5. Structural checks on trimmed text
  // Markdown code fences
  if (ordinaryTrimmed.includes("```")) {
    violations.push({ code: "markdown_code_fence_not_allowed" });
  }

  // HTML or script markup
  if (/<[^>]+>/.test(ordinaryTrimmed)) {
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
  if (/^[\*\+\-]\s/.test(ordinaryTrimmed) || /^\d+\.\s/.test(ordinaryTrimmed)) {
    violations.push({ code: "markdown_list_not_allowed" });
  }

  // Role prefixes
  if (/^(assistant|system|user):\s*/i.test(ordinaryTrimmed)) {
    violations.push({ code: "role_prefix_not_allowed" });
  }

  // Explanatory prefaces
  if (/^(回答|応答|発言):\s*/.test(ordinaryTrimmed)) {
    violations.push({ code: "explanatory_preface_not_allowed" });
  }

  // Stage direction wrappers
  // Only reject if it's a wrapper at the beginning or end of the string.
  // Since we applied NFKC, full-width （ ） are normalized to ( ).
  const stageDirectionRegex = /^(\([^)]+\)|\[[^\]]+\]|\*[^*]+\*)|(\([^)]+\)|\[[^\]]+\]|\*[^*]+\*)$/;
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
