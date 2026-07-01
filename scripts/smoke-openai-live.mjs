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
  UNEXPECTED_FAILURE: 5
};

export async function runSmokeTest(options = {}) {
  const env = options.env || process.env;
  const injectFetch = options.fetch;

  // 1. Mandatory safety gates
  const optIn = env.OPENAI_LIVE_SMOKE_TEST;
  const provider = env.LLM_PROVIDER;
  const apiKey = (env.OPENAI_API_KEY || "").trim();

  if (optIn !== "I_ACCEPT_API_CHARGES") {
    const msg = "ERROR: Missing or invalid OPENAI_LIVE_SMOKE_TEST.\n" +
                "This command performs one billable OpenAI request.\n" +
                "To proceed, set OPENAI_LIVE_SMOKE_TEST=I_ACCEPT_API_CHARGES";
    if (options.silent) throw { message: msg, code: EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE };
    console.error(msg);
    process.exit(EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE);
  }

  if (provider !== "openai") {
    const msg = "ERROR: LLM_PROVIDER must be 'openai' for this smoke test.";
    if (options.silent) throw { message: msg, code: EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE };
    console.error(msg);
    process.exit(EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE);
  }

  if (!apiKey) {
    const msg = "ERROR: OPENAI_API_KEY is missing or empty.";
    if (options.silent) throw { message: msg, code: EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE };
    console.error(msg);
    process.exit(EXIT_CODES.CONFIG_OR_OPT_IN_FAILURE);
  }

  if (!options.silent) console.log("Safety gates passed. Starting controlled OpenAI smoke test...");

  let server;
  try {
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

    const config = parseConfig(customEnv);
    const openaiProvider = new OpenAIResponseProvider({
      ...config.openai,
      maxRetries: 0,
      fallbackToPseudo: false,
      maxOutputTokens: 120,
      maxConcurrent: 1,
      fetch: injectFetch || config.openai?.fetch
    });

    server = createWebServer({ config, provider: openaiProvider });

    await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.on("error", reject);
    });

    const port = server.address().port;
    const localUrl = `http://127.0.0.1:${port}/api/npc-response`;

    if (!options.silent) console.log(`Local server listening on port ${port}. Sending request to ${localUrl}...`);

    const startTime = Date.now();
    const response = await fetch(localUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(productionRequest)
    });

    const duration = Date.now() - startTime;
    const status = response.status;
    const body = await response.json();

    if (!response.ok) {
      if (!options.silent) {
        console.error("FAIL: Local API request failed.");
        console.error(`HTTP Status: ${status}`);
        console.error(`Error Type: ${body.type}`);
        console.error(`Error Message: ${body.error}`);
        if (body.diagnostics) {
          console.error("Diagnostics:", JSON.stringify(body.diagnostics, null, 2));
        }
      }
      const code = status === 400 ? EXIT_CODES.LOCAL_VALIDATION_FAILURE : EXIT_CODES.PROVIDER_API_FAILURE;
      if (options.silent) throw { message: body.error, code, diagnostics: body.diagnostics, status };
      process.exit(code);
    }

    // 4. Smoke test assertions
    const { text, providerName, model, usage, diagnostics } = body;
    const fallbackUsed = diagnostics?.fallbackUsed;

    const pass = Boolean(
      text && typeof text === "string" && text.length > 0 &&
      providerName === "openai" &&
      fallbackUsed !== true &&
      model
    );

    if (!options.silent) {
      if (pass) {
        console.log("\nPASS: Controlled OpenAI smoke test completed successfully.");
      } else {
        console.log("\nFAIL: Smoke test assertions failed.");
        if (fallbackUsed) console.log("- Reason: Fallback to pseudo was used.");
        if (providerName !== "openai") console.log(`- Reason: Unexpected provider name: ${providerName}`);
      }

      // 5. Print sanitized report
      console.log("----------------------------------------");
      console.log(`Result:          ${pass ? "PASS" : "FAIL"}`);
      console.log(`Model:           ${model || "unknown"}`);
      console.log(`Provider:        ${providerName}`);
      console.log(`Elapsed (ms):    ${duration}`);
      console.log(`Output chars:    ${text?.length || 0}`);
      if (usage) {
        console.log(`Input tokens:    ${usage.inputTokens ?? "N/A"}`);
        console.log(`Output tokens:   ${usage.outputTokens ?? "N/A"}`);
        console.log(`Total tokens:    ${usage.totalTokens ?? "N/A"}`);
      }
      console.log(`Fallback used:   ${fallbackUsed ?? false}`);
      console.log(`Provider status: ${diagnostics?.providerStatus || "N/A"}`);
      console.log(`HTTP status:     ${status}`);
      console.log(`Request ID:      ${diagnostics?.requestId || "N/A"}`);
      console.log(`Response ID:     ${diagnostics?.responseId || "N/A"}`);
      console.log("----------------------------------------");
      console.log(`NPC Utterance:   "${text}"`);
      console.log("----------------------------------------");
    }

    if (!pass) {
      if (options.silent) throw { message: "Smoke test assertion failed", code: EXIT_CODES.SMOKE_TEST_ASSERTION_FAILURE };
      process.exit(EXIT_CODES.SMOKE_TEST_ASSERTION_FAILURE);
    }

    return { pass, body, duration };

  } catch (error) {
    if (error.code) throw error;
    if (!options.silent) {
      console.error("\nFAIL: An unexpected error occurred.");
      console.error(error.message);
    }
    if (options.silent) throw { message: error.message, code: EXIT_CODES.UNEXPECTED_FAILURE };
    process.exit(EXIT_CODES.UNEXPECTED_FAILURE);
  } finally {
    if (server) {
      await new Promise(resolve => server.close(resolve));
      if (!options.silent) console.log("Local server closed.");
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Handle interruption
  process.on("SIGINT", () => {
    console.log("\nInterrupted by user.");
    process.exit(0);
  });

  runSmokeTest().catch(err => {
    // Already handled or unexpected
    if (err.code) process.exit(err.code);
    process.exit(EXIT_CODES.UNEXPECTED_FAILURE);
  });
}
