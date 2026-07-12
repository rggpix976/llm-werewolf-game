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
    interpreterShadowMode: parseBoolean(env.INTERPRETER_SHADOW_MODE, false, "INTERPRETER_SHADOW_MODE"),
    openai: null
  };

  if (provider === "openai") {
    const apiKey = (env.OPENAI_API_KEY || "").trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required and cannot be whitespace only when LLM_PROVIDER is 'openai'.");
    }

    config.openai = {
      apiKey,
      model: env.OPENAI_MODEL || "gpt-5.4-mini",
      timeoutMs: parseStrictInt(env.OPENAI_TIMEOUT_MS, 15000, "OPENAI_TIMEOUT_MS", 1, 60000),
      maxRetries: parseStrictInt(env.OPENAI_MAX_RETRIES, 1, "OPENAI_MAX_RETRIES", 0, 5),
      maxOutputTokens: parseStrictInt(env.OPENAI_MAX_OUTPUT_TOKENS, 220, "OPENAI_MAX_OUTPUT_TOKENS", 1, 4096),
      maxRequestsPerMinute: parseStrictInt(env.OPENAI_MAX_REQUESTS_PER_MINUTE, 10, "OPENAI_MAX_REQUESTS_PER_MINUTE", 1, 60),
      fallbackToPseudo: parseBoolean(env.OPENAI_FALLBACK_TO_PSEUDO, true, "OPENAI_FALLBACK_TO_PSEUDO")
    };
  }

  return Object.freeze(config);
}

/**
 * Returns a safe version of the config for public consumption (browser).
 */
export function getRuntimeConfig(config) {
  const result = {
    provider: config.provider,
    interpreterShadowMode: config.interpreterShadowMode === true
  };

  if (config.openai) {
    result.model = config.openai.model;
    result.fallbackEnabled = config.openai.fallbackToPseudo;
  }

  return result;
}

function parseStrictInt(value, defaultValue, name, min, max) {
  if (value === undefined || value === "") return defaultValue;

  // Reject if it contains anything other than digits
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer without units or decimals. Got: ${value}`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} is not a safe integer. Got: ${value}`);
  }

  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}. Got: ${parsed}`);
  }

  return parsed;
}

function parseBoolean(value, defaultValue, name) {
  if (value === undefined || value === "") return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be 'true' or 'false'. Got: ${value}`);
}
