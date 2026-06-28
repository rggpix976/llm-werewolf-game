import { generatePseudoResponseText } from "./responseGenerator.mjs";

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

  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!text) {
    throw new TypeError("Response provider returned empty text");
  }

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
