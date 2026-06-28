/**
 * Validates and parses environment variables for game configuration.
 * @param {Record<string, string | undefined>} env - Environment variables.
 * @returns {Object} Validated configuration.
 * @throws {Error} If configuration is invalid.
 */
export function parseConfig(env = process.env) {
  const provider = env.LLM_PROVIDER || "pseudo";
  if (!["pseudo", "openai"].includes(provider)) {
    throw new Error(`Invalid LLM_PROVIDER: ${provider}. Must be 'pseudo' or 'openai'.`);
  }

  const config = {
    provider,
    openai: null
  };

  if (provider === "openai") {
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER is 'openai'.");
    }

    config.openai = {
      apiKey,
      model: env.OPENAI_MODEL || "gpt-5.4-mini",
      timeoutMs: parsePositiveInt(env.OPENAI_TIMEOUT_MS, 15000, "OPENAI_TIMEOUT_MS"),
      maxRetries: parseNonNegativeInt(env.OPENAI_MAX_RETRIES, 1, "OPENAI_MAX_RETRIES"),
      maxOutputTokens: parsePositiveInt(env.OPENAI_MAX_OUTPUT_TOKENS, 220, "OPENAI_MAX_OUTPUT_TOKENS"),
      maxRequestsPerMinute: parsePositiveInt(env.OPENAI_MAX_REQUESTS_PER_MINUTE, 10, "OPENAI_MAX_REQUESTS_PER_MINUTE"),
      fallbackToPseudo: parseBoolean(env.OPENAI_FALLBACK_TO_PSEUDO, true, "OPENAI_FALLBACK_TO_PSEUDO")
    };

    // Additional validation for maxOutputTokens
    if (config.openai.maxOutputTokens < 1 || config.openai.maxOutputTokens > 4096) {
      throw new Error(`OPENAI_MAX_OUTPUT_TOKENS must be between 1 and 4096. Got: ${config.openai.maxOutputTokens}`);
    }

    // Small integer check for retries
    if (config.openai.maxRetries > 5) {
       throw new Error(`OPENAI_MAX_RETRIES is too high. Max allowed is 5. Got: ${config.openai.maxRetries}`);
    }
  }

  return Object.freeze(config);
}

/**
 * Returns a safe version of the config for public consumption (browser).
 */
export function getRuntimeConfig(config) {
  const result = {
    provider: config.provider
  };

  if (config.openai) {
    result.model = config.openai.model;
    result.fallbackEnabled = config.openai.fallbackToPseudo;
  }

  return result;
}

function parsePositiveInt(value, defaultValue, name) {
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer. Got: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInt(value, defaultValue, name) {
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer. Got: ${value}`);
  }
  return parsed;
}

function parseBoolean(value, defaultValue, name) {
  if (value === undefined || value === "") return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be 'true' or 'false'. Got: ${value}`);
}
