import { generatePseudoResponseText } from "./responseGenerator.mjs";
import { guardProviderResponse } from "./utteranceGuard.mjs";

const GUARDED_PROVIDERS = new WeakSet();

/**
 * Checks if a provider is already wrapped in a trusted GuardedResponseProvider.
 */
export function isGuardedProvider(provider) {
  return provider && typeof provider === "object" && GUARDED_PROVIDERS.has(provider);
}

/**
 * Marks a provider as guarded. Used only within this module.
 */
function markAsGuarded(provider) {
  GUARDED_PROVIDERS.add(provider);
}

export class GuardedResponseProvider {
  constructor(innerProvider) {
    this.innerProvider = innerProvider;
    this.name = innerProvider.name || getProviderName(innerProvider);
    markAsGuarded(this);
  }

  async generateResponse(request, options = {}) {
    const result = await this.innerProvider.generateResponse(request, options);
    // Generic provider validation. Throws if fundamentally broken (e.g. empty text).
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

/**
 * A marker-only provider for cases where guarding happened upstream (e.g. server).
 * Use markProviderAsGuarded(provider) instead of public properties.
 */
export function markExternalProviderAsGuarded(provider) {
    if (provider && typeof provider === "object") {
        markAsGuarded(provider);
    }
    return provider;
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
