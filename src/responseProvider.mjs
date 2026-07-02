import { generatePseudoResponseText } from "./responseGenerator.mjs";
import { guardProviderResponse } from "./utteranceGuard.mjs";

export class GuardedResponseProvider {
  constructor(innerProvider) {
    this.innerProvider = innerProvider;
    this.name = innerProvider.name || getProviderName(innerProvider);
  }

  async generateResponse(request, options = {}) {
    const result = await this.innerProvider.generateResponse(request, options);
    // Generic provider validation. Throws if fundamentally broken (e.g. empty text).
    // This preserves existing provider-error behavior by not triggering safety fallback
    // for broken provider responses that should be treated as system errors.
    const validated = validateProviderResponse(result, this.name);
    return guardProviderResponse({ request, providerResult: validated });
  }
}

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
