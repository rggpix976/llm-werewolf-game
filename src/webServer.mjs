import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, getRuntimeConfig } from "./config.mjs";
import { OpenAIResponseProvider } from "./openaiProvider.mjs";
import { PseudoResponseProvider } from "./responseProvider.mjs";

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
        return handleNpcResponse(request, response, provider, rateLimiter);
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

      console.error("Server error:", error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Internal server error");
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
    response.writeHead(429, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Too many requests" }));
    return;
  }

  // Content-Type validation
  if (request.headers["content-type"] !== "application/json") {
    response.writeHead(415, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Unsupported Content-Type. Use application/json" }));
    return;
  }

  let body;
  try {
    body = await readJsonBody(request, 64 * 1024); // 64 KiB limit
  } catch (error) {
    const status = error.status || 400;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error.message }));
    return;
  }

  try {
    validateNpcRequest(body);
    const result = await provider.generateResponse(body);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
  } catch (error) {
    const status = error.status || 500;
    const type = error.type || "server_error";
    // Generalize error message for security
    const message = status === 500 ? "Internal server error" : error.message;

    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      error: message,
      type,
      diagnostics: error.type ? {
        status: error.status,
        requestId: error.requestId,
        code: error.code,
        responseId: error.responseId
      } : undefined
    }));
  }
}

function validateNpcRequest(body) {
  if (!body || typeof body !== "object") throw createHttpError(400, "Invalid request body");
  if (!body.npc || typeof body.npc.id !== "string") throw createHttpError(400, "Missing npc.id");
  if (typeof body.playerInput !== "string") throw createHttpError(400, "Missing playerInput");
  // Basic sanity check on size/nesting if needed, but 64KiB limit already helps.
}

async function readJsonBody(request, limit) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(createHttpError(413, "Request body too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(createHttpError(400, "Invalid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createProvider(config) {
  if (config.provider === "openai") {
    return new OpenAIResponseProvider(config.openai);
  }
  return new PseudoResponseProvider();
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
    },
    reset() {
      requests = [];
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
