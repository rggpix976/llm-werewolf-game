import { generatePseudoResponseText } from "./responseGenerator.mjs";
import { validateNpcUtteranceStructure } from "./utteranceGuard.mjs";

export class PseudoResponseProvider {
  constructor(options = {}) {
    this.name = options.name ?? "pseudo";
  }

  async generateResponse(request) {
    return {
      text: generatePseudoResponseText(request),
      providerName: this.name,
      model: "template-v1",
      usage: null,
      notes: ["deterministic_pseudo_response"]
    };
  }
}

export function validateProviderResponse(value, fallbackProviderName = "unknown") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Response provider must return an object");
  }

  if (typeof value.text !== "string" || value.text.trim() === "") {
    throw new TypeError("Response provider returned empty text");
  }

  // Generated utterances must satisfy the structural rules the game
  // applies to NPC speech (single line, no wrappers or role prefixes,
  // bounded length). Rejected text raises here so callers treat it as an
  // invalid provider response instead of publishing it as an NPC utterance.
  // Markup is the one exception: HTML-like text is not rejected at this
  // layer because every display path neutralizes it (the browser renders
  // provider text with textContent and the CLI sanitizes terminal output),
  // and legacy provider text containing markup literals must stay
  // displayable. The guard itself still reports the violation.
  const structure = validateNpcUtteranceStructure(value.text);
  const fatalViolations = structure.violations.filter(
    (violation) => violation.code !== "html_markup_not_allowed"
  );
  if (fatalViolations.length > 0) {
    const codes = fatalViolations.map((violation) => violation.code).join(", ");
    throw new TypeError(`Response provider returned invalid utterance structure: ${codes}`);
  }

  const text = structure.ok ? structure.normalizedText : value.text.trim();

  return {
    text,
    providerName: normalizeOptionalString(value.providerName) ?? fallbackProviderName,
    model: normalizeOptionalString(value.model),
    usage: isPlainObject(value.usage) ? structuredClone(value.usage) : null,
    notes: Array.isArray(value.notes)
      ? value.notes.filter((note) => typeof note === "string")
      : [],
    diagnostics: isPlainObject(value.diagnostics) ? structuredClone(value.diagnostics) : undefined
  };
}

export function getProviderName(provider) {
  return normalizeOptionalString(provider?.name)
    ?? normalizeOptionalString(provider?.constructor?.name)
    ?? "unknown";
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
