import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, getRuntimeConfig } from "./config.mjs";
import { OpenAIResponseProvider } from "./openaiProvider.mjs";
import { PseudoResponseProvider, GuardedResponseProvider, getProviderName } from "./responseProvider.mjs";
import { validateNpcResponseRequest } from "./validator.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const srcDir = path.join(rootDir, "src");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"]
]);

/**
 * Creates the request handler for the werewolf game server.
 */
export function createRequestHandler(options = {}) {
  const config = options.config || parseConfig();
  const provider = options.provider || createProvider(config);
  const rateLimiter = options.rateLimiter || createRateLimiter(config);

  return async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const pathname = requestUrl.pathname;

      // API Endpoints
      if (pathname === "/api/runtime-config" && request.method === "GET") {
        return handleRuntimeConfig(response, config);
      }

      if (pathname === "/api/npc-response" && request.method === "POST") {
        return await handleNpcResponse(request, response, provider, rateLimiter);
      }

      // Method not allowed for API
      if (pathname.startsWith("/api/")) {
        response.writeHead(405, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      // Static Files
      const filePath = resolveFilePath(pathname);
      if (!filePath) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      const contentType = mimeTypes.get(path.extname(filePath)) ?? "application/octet-stream";
      response.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store"
      });
      createReadStream(filePath).pipe(response);
    } catch (error) {
      if (error?.code === "ENOENT") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      console.error("Outer server error:", error);
      sendError(response, error.status || 500, error.message || "Internal server error", error.type, error.diagnostics);
    }
  };
}

function handleRuntimeConfig(response, config) {
  const runtimeConfig = getRuntimeConfig(config);
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(runtimeConfig));
}

async function handleNpcResponse(request, response, provider, rateLimiter) {
  // Check rate limit
  if (!rateLimiter.allow()) {
    return sendError(response, 429, "Too many requests", "rate_limit");
  }

  // Content-Type validation: case-insensitive exact media type match before semicolon
  const contentTypeHeader = request.headers["content-type"] || "";
  const mediaType = contentTypeHeader.split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return sendError(response, 415, "Unsupported Content-Type. Use application/json", "bad_request");
  }

  let body;
  try {
    body = await readJsonBody(request, 64 * 1024); // 64 KiB limit
  } catch (error) {
    return sendError(response, error.status || 400, error.message, "bad_request");
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  request.on("aborted", onAbort);
  response.on("close", () => {
    if (!response.writableEnded) {
       controller.abort();
    }
  });

  try {
    const validatedRequest = validateNpcResponseRequest(body);
    const result = await provider.generateResponse(validatedRequest, { signal: controller.signal });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
  } catch (error) {
    if (error.name === "AbortError" || controller.signal.aborted) {
       // Request aborted by client, do not attempt to write further if already closed
       return;
    }

    if (error.name === "ValidationError") {
      return sendError(response, 400, error.message, "bad_request");
    }

    const type = error.type || "server_error";
    const status = mapErrorToHttpStatus(type, error.upstreamStatus);
    const safeMessage = getSafeErrorMessage(type, error.message, status);

    sendError(response, status, safeMessage, type, error.diagnostics || {
       httpStatus: error.upstreamStatus || status,
       code: error.code,
       requestId: error.requestId,
       responseId: error.responseId,
       retryable: error.retryable,
       retryCount: error.retryCount,
       providerName: getProviderName(provider)
    });
  } finally {
    request.removeListener("aborted", onAbort);
    // response listener removal is trickier as 'close' is used for many things,
    // but in Node.js 18+ it should be fine as it's terminal.
  }
}

function mapErrorToHttpStatus(type, upstreamStatus) {
  const map = {
    "invalid_provider_response": 502,
    "timeout": 504,
    "network_error": 503,
    "provider_server_error": 502,
    "rate_limit": 429,
    "bad_request": 400,
    "authentication_error": 502,
    "permission_error": 502
  };
  return map[type] || upstreamStatus || 500;
}

function getSafeErrorMessage(type, originalMessage, status) {
  if (status === 400 && type === "bad_request") return originalMessage;

  const messages = {
    "timeout": "The request timed out. Please try again.",
    "network_error": "A network error occurred. Please check your connection.",
    "authentication_error": "Provider authentication failed. Please contact the administrator.",
    "permission_error": "Provider permission denied. Please contact the administrator.",
    "rate_limit": "Rate limit exceeded. Please wait a moment before trying again.",
    "bad_request": "The request was invalid.",
    "provider_server_error": "The response provider encountered an error. Please try again later.",
    "invalid_provider_response": "The provider returned an invalid response."
  };
  return messages[type] || "An unexpected error occurred.";
}

function sendError(response, status, message, type, diagnostics) {
  if (response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    error: message,
    type: type || "server_error",
    diagnostics: diagnostics
  }));
}

async function readJsonBody(request, limit) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let currentLength = 0;
    let settled = false;

    const onData = (chunk) => {
      if (settled) return;
      chunks.push(chunk);
      currentLength += chunk.length;
      if (currentLength > limit) {
        settled = true;
        cleanup();
        request.resume(); // Drain
        reject(createHttpError(413, "Request body too large"));
      }
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const fullBody = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(fullBody));
      } catch (error) {
        reject(createHttpError(400, "Invalid JSON"));
      }
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    function cleanup() {
        request.removeListener("data", onData);
        request.removeListener("end", onEnd);
        request.removeListener("error", onError);
    }

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createProvider(config) {
  let provider;
  if (config.provider === "openai") {
    provider = new OpenAIResponseProvider(config.openai);
  } else {
    provider = new PseudoResponseProvider();
  }
  // If the provider is already a GuardedResponseProvider (e.g. passed in via options),
  // do not wrap it again.
  if (provider.isGuarded) {
    return provider;
  }
  return new GuardedResponseProvider(provider);
}

function createRateLimiter(config) {
  const maxPerMinute = config.openai?.maxRequestsPerMinute || 60;
  let requests = [];
  return {
    allow() {
      const now = Date.now();
      requests = requests.filter(time => now - time < 60000);
      if (requests.length >= maxPerMinute) return false;
      requests.push(now);
      return true;
    }
  };
}

export function createWebServer(options = {}) {
  const handler = createRequestHandler(options);
  return createServer(handler);
}

export function startServer() {
  let config;
  try {
    config = parseConfig();
  } catch (error) {
    console.error("Configuration error:", error.message);
    process.exit(1);
  }

  const port = Number.parseInt(process.env.PORT ?? "4173", 10);
  const server = createWebServer({ config });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use.`);
      process.exit(1);
    }
    throw error;
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Browser UI available at http://127.0.0.1:${port}/`);
    console.log(`LLM Provider: ${config.provider}`);
  });

  return server;
}

function resolveFilePath(pathname) {
  const decodedPath = decodeURIComponent(pathname);

  if (decodedPath === "/" || decodedPath === "/index.html") {
    return path.join(publicDir, "index.html");
  }

  if (decodedPath.startsWith("/src/")) {
    return resolveInside(srcDir, decodedPath.slice("/src/".length));
  }

  return resolveInside(publicDir, decodedPath.slice(1));
}

function resolveInside(baseDir, relativePath) {
  const candidate = path.resolve(baseDir, relativePath);
  const relative = path.relative(baseDir, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}

// Start server if this file is run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}
