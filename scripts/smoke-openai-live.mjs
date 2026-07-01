import { WerewolfGame } from "../src/gameEngine.mjs";
import { buildNpcResponseRequest } from "../src/responseGenerator.mjs";
import { createWebServer } from "../src/webServer.mjs";
import { parseConfig } from "../src/config.mjs";
import { OpenAIResponseProvider } from "../src/openaiProvider.mjs";
import { fileURLToPath } from "node:url";

export const EXIT_CODES = {
  CONFIG_OR_OPT_IN_FAILURE: 1,
  LOCAL_VALIDATION_FAILURE: 2,
  PROVIDER_API_FAILURE: 3,
  SMOKE_TEST_ASSERTION_FAILURE: 4,
  UNEXPECTED_FAILURE: 5,
  INTERRUPTION: 130
};

export class SmokeTestError extends Error {
  constructor(message, exitCode, diagnostics = null) {
    super(message);
    this.name = "SmokeTestError";
    this.exitCode = exitCode;
    this.diagnostics = diagnostics;
  }
}

/**
 * Creates a fetch wrapper that allows exactly one call.
 */
export function createOneCallFetch(originalFetch) {
  let callCount = 0;
  return {
    fetch: async (url, opts) => {
      if (callCount > 0) {
        throw new Error("Blocked second outbound OpenAI request locally.");
      }
      callCount++;
      return await originalFetch(url, opts);
    },
    getCallCount: () => callCount
  };
}

/**
 * Performs a controlled one-call real OpenAI smoke test.
 */
export async function runSmokeTest(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const signal = options.signal;

  // 1. Mandatory safety gates
  const optIn = env.OPENAI_LIVE_SMOKE_TEST;
  const providerEnv = env.LLM_PROVIDER;
  const apiKey = (env.OPENAI_API_KEY || "").trim();

  if (optIn !== "I_ACCEPT_API_CHARGES") {
    throw new SmokeTestError(
      "ERROR: Missing or invalid OPENAI_LIVE_SMOKE_TEST.\n" +
      "This command performs one billable OpenAI request.\n" +
      "To proceed, set OPENAI_LIVE_SMOKE_TEST=I_ACCEPT_API_CHARGES",
      EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE
    );
  }

  if (providerEnv !== "openai") {
    throw new SmokeTestError(
      "ERROR: LLM_PROVIDER must be 'openai' for this smoke test.",
      EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE
    );
  }

  if (!apiKey) {
    throw new SmokeTestError(
      "ERROR: OPENAI_API_KEY is missing or empty.",
      EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE
    );
  }

  logger.log("Safety gates passed. Starting controlled OpenAI smoke test...");

  let server;
  let guard;

  try {
    if (signal?.aborted) throw signal.reason;

    // 2. Construct deterministic game state and production request
    const game = WerewolfGame.create({ scenario: "sample", shuffleRoles: false });
    const targetNpc = game.getPlayer("npc1"); // Aoi
    const question = "Chikaの発言は怪しくない？";
    const prepared = buildNpcResponseRequest(targetNpc, game.state, question);
    const productionRequest = prepared.request;

    // 3. Start production web server with ephemeral port and strict config
    const customEnv = {
      ...env,
      OPENAI_MAX_RETRIES: "0",
      OPENAI_FALLBACK_TO_PSEUDO: "false",
      OPENAI_MAX_OUTPUT_TOKENS: "120",
      OPENAI_MAX_REQUESTS_PER_MINUTE: "1"
    };

    let config;
    try {
      config = parseConfig(customEnv);
    } catch (err) {
      throw new SmokeTestError(err.message, EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE);
    }

    const originalFetch = options.fetch || config.openai?.fetch || globalThis.fetch;
    guard = createOneCallFetch(originalFetch);

    const openaiProvider = new OpenAIResponseProvider({
      ...config.openai,
      maxRetries: 0,
      fallbackToPseudo: false,
      maxOutputTokens: 120,
      maxConcurrent: 1,
      fetch: guard.fetch
    });

    server = createWebServer({ config, provider: openaiProvider });

    await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
      if (signal) {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }
    });

    const port = server.address().port;
    const localUrl = `http://127.0.0.1:${port}/api/npc-response`;

    logger.log(`Local server listening on port ${port}. Sending request to ${localUrl}...`);

    const startTime = Date.now();
    const response = await fetch(localUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(productionRequest),
      signal
    });

    const duration = Date.now() - startTime;
    const status = response.status;
    const body = await response.json();

    if (!response.ok) {
      logger.error("FAIL: Local API request failed.");
      logger.error(`HTTP Status: ${status}`);
      logger.error(`Error Type: ${body.type}`);
      logger.error(`Error Message: ${body.error}`);
      if (body.diagnostics) {
        const diag = { ...body.diagnostics };
        delete diag.apiKey;
        logger.error("Diagnostics: " + JSON.stringify(diag, null, 2));
      }

      const isProviderError = body.diagnostics?.providerName === "openai";
      const exitCode = (status === 400 && !isProviderError)
        ? EXIT_CODES.LOCAL_VALIDATION_FAILURE
        : EXIT_CODES.PROVIDER_API_FAILURE;

      throw new SmokeTestError(body.error, exitCode, body.diagnostics);
    }

    // 4. Smoke test assertions
    const { text, providerName, model, usage, diagnostics } = body;
    const fallbackUsed = diagnostics?.fallbackUsed;
    const providerStatus = diagnostics?.providerStatus;

    const pass = Boolean(
      text && typeof text === "string" && text.length > 0 &&
      providerName === "openai" &&
      fallbackUsed !== true &&
      providerStatus === "completed" &&
      model &&
      guard.getCallCount() === 1
    );

    if (pass) {
      logger.log("\nPASS: Controlled OpenAI smoke test completed successfully.");
    } else {
      logger.log("\nFAIL: Smoke test assertions failed.");
      if (fallbackUsed) logger.log("- Reason: Fallback to pseudo was used.");
      if (providerName !== "openai") logger.log(`- Reason: Unexpected provider name: ${providerName}`);
      if (providerStatus !== "completed") logger.log(`- Reason: Unexpected provider status: ${providerStatus}`);
      if (guard.getCallCount() !== 1) logger.log(`- Reason: Unexpected OpenAI fetch count: ${guard.getCallCount()}`);
    }

    // 5. Print sanitized report
    logger.log("----------------------------------------");
    logger.log(`Result:          ${pass ? "PASS" : "FAIL"}`);
    logger.log(`Model:           ${model || "unknown"}`);
    logger.log(`Provider:        ${providerName}`);
    logger.log(`OpenAI Fetches:  ${guard.getCallCount()}`);
    logger.log(`Elapsed (ms):    ${duration}`);
    logger.log(`Output chars:    ${text?.length || 0}`);
    if (usage) {
      logger.log(`Input tokens:    ${usage.inputTokens ?? "N/A"}`);
      logger.log(`Output tokens:   ${usage.outputTokens ?? "N/A"}`);
      logger.log(`Total tokens:    ${usage.totalTokens ?? "N/A"}`);
    }
    logger.log(`Fallback used:   ${fallbackUsed ?? false}`);
    logger.log(`Provider status: ${providerStatus || "N/A"}`);
    logger.log(`HTTP status:     ${status}`);
    logger.log(`Request ID:      ${diagnostics?.requestId || "N/A"}`);
    logger.log(`Response ID:     ${diagnostics?.responseId || "N/A"}`);
    logger.log("----------------------------------------");
    logger.log(`NPC Utterance:   "${text}"`);
    logger.log("----------------------------------------");

    if (!pass) {
      const assertionMsg = fallbackUsed ? "Smoke test failed: Pseudo fallback was used." : "Smoke test assertion failed";
      throw new SmokeTestError(assertionMsg, EXIT_CODES.SMOKE_TEST_ASSERTION_FAILURE, diagnostics);
    }

    return { pass, body, duration, networkCallCount: guard.getCallCount() };

  } catch (error) {
    if (error instanceof SmokeTestError) throw error;
    if (error.name === "AbortError" || signal?.aborted) {
      throw new SmokeTestError("Interrupted by user.", EXIT_CODES.INTERRUPTION);
    }
    throw new SmokeTestError(error.message, EXIT_CODES.UNEXPECTED_FAILURE);
  } finally {
    if (server) {
      await new Promise(resolve => server.close(resolve));
      logger.log("Local server closed.");
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const onSigInt = () => {
    controller.abort();
  };
  process.on("SIGINT", onSigInt);

  runSmokeTest({ signal: controller.signal })
    .then(() => {
      process.exitCode = 0;
    })
    .catch(err => {
      if (err instanceof SmokeTestError) {
        process.exitCode = err.exitCode;
        if (err.exitCode !== EXIT_CODES.INTERRUPTION) {
           console.error("\n" + err.message);
        } else {
           console.log("\n" + err.message);
        }
      } else {
        console.error("\nFAIL: An unexpected error occurred.");
        console.error(err.message);
        process.exitCode = EXIT_CODES.UNEXPECTED_FAILURE;
      }
    })
    .finally(() => {
      process.removeListener("SIGINT", onSigInt);
    });
}
