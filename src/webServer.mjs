import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const srcDir = path.join(rootDir, "src");
const port = Number.parseInt(process.env.PORT ?? "4173", 10);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"]
]);

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const filePath = resolveFilePath(requestUrl.pathname);

    if (!filePath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const contentType = mimeTypes.get(path.extname(filePath)) ?? "application/octet-stream";
    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store"
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error?.code === "ENOENT") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Internal server error");
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Set PORT to another value, for example:`);
    console.error("  $env:PORT=4174; npm.cmd run web");
    process.exit(1);
  }

  throw error;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Browser UI available at http://127.0.0.1:${port}/`);
});

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
