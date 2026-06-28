import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createRequestHandler } from "../src/webServer.mjs";

class MockRequest extends EventEmitter {
  constructor(method, url, headers = {}, body = "") {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.bodyData = body;
  }
  start() {
    if (this.bodyData) this.emit("data", Buffer.from(this.bodyData));
    this.emit("end");
  }
}

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.body = "";
    this.writable = true;
  }
  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
  }
  write(data) {
    this.body += data;
    return true;
  }
  end(data) {
    if (data) this.body += data;
    this.emit("finish");
  }
  on(event, listener) {
    super.on(event, listener);
    return this;
  }
  once(event, listener) {
    super.once(event, listener);
    return this;
  }
  emit(event, ...args) {
    return super.emit(event, ...args);
  }
}

test("GET /api/runtime-config returns config without secrets", (t, done) => {
  const handler = createRequestHandler({
    config: { provider: "openai", openai: { model: "gpt-5.4-mini", fallbackToPseudo: true } }
  });
  const req = new MockRequest("GET", "/api/runtime-config");
  const res = new MockResponse();

  res.on("finish", () => {
    try {
      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.provider, "openai");
      assert.equal(data.model, "gpt-5.4-mini");
      assert.equal(data.apiKey, undefined);
      assert.equal(res.headers["Cache-Control"], "no-store");
      done();
    } catch (e) {
      done(e);
    }
  });

  handler(req, res);
  req.start();
});

test("POST /api/npc-response success", (t, done) => {
  const mockProvider = {
    async generateResponse(req) {
      return { text: "Hello from mock", providerName: "mock" };
    }
  };
  const handler = createRequestHandler({ provider: mockProvider });
  const body = JSON.stringify({ npc: { id: "npc1" }, playerInput: "Hi" });
  const req = new MockRequest("POST", "/api/npc-response", { "content-type": "application/json" }, body);
  const res = new MockResponse();

  res.on("finish", () => {
    try {
      assert.equal(res.statusCode, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.text, "Hello from mock");
      done();
    } catch (e) {
      done(e);
    }
  });

  handler(req, res);
  req.start();
});

test("POST /api/npc-response rate limit", (t, done) => {
  const mockRateLimiter = { allow: () => false };
  const handler = createRequestHandler({ rateLimiter: mockRateLimiter });
  const req = new MockRequest("POST", "/api/npc-response", { "content-type": "application/json" }, "{}");
  const res = new MockResponse();

  res.on("finish", () => {
    try {
      assert.equal(res.statusCode, 429);
      assert.equal(JSON.parse(res.body).error, "Too many requests");
      done();
    } catch (e) {
      done(e);
    }
  });

  handler(req, res);
  req.start();
});

test("POST /api/npc-response invalid content-type", (t, done) => {
  const handler = createRequestHandler();
  const req = new MockRequest("POST", "/api/npc-response", { "content-type": "text/plain" }, "{}");
  const res = new MockResponse();

  res.on("finish", () => {
    try {
      assert.equal(res.statusCode, 415);
      done();
    } catch (e) {
      done(e);
    }
  });

  handler(req, res);
  req.start();
});

test("POST /api/npc-response too large body", (t, done) => {
  const handler = createRequestHandler();
  const largeBody = "a".repeat(70 * 1024);
  const req = new MockRequest("POST", "/api/npc-response", { "content-type": "application/json" }, largeBody);
  const res = new MockResponse();

  res.on("finish", () => {
    try {
      assert.equal(res.statusCode, 413);
      done();
    } catch (e) {
      done(e);
    }
  });

  handler(req, res);
  req.start();
});

test("Static file delivery - index.html", (t, done) => {
  const handler = createRequestHandler();
  const req = new MockRequest("GET", "/");
  const res = new MockResponse();

  res.on("finish", () => {
    try {
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["Content-Type"], "text/html; charset=utf-8");
      assert.ok(res.body.includes("<!doctype html>"));
      done();
    } catch (e) {
      done(e);
    }
  });

  handler(req, res);
  req.start();
});

test("Path traversal prevention", (t, done) => {
  const handler = createRequestHandler();
  const req = new MockRequest("GET", "/../package.json");
  const res = new MockResponse();

  res.on("finish", () => {
    try {
      assert.equal(res.statusCode, 404);
      done();
    } catch (e) {
      done(e);
    }
  });

  handler(req, res);
  req.start();
});
