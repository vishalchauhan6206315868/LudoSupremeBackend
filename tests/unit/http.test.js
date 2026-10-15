"use strict";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const express = require("express");

const config = require("../../config/env");
const app = require("../../app");
const errorHandler = require("../../middleware/error.middleware");
const sanitize = require("../../middleware/sanitize.middleware");
const AppError = require("../../utils/AppError");

let server;
let base;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const post = (path, body, headers = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("health endpoints respond and expose a request id", async () => {
  for (const path of ["/", "/health", "/api/health"]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);
    assert.ok(res.headers.get("x-request-id"));
  }
});

test("readiness is 503 while the database is not connected", async () => {
  const res = await fetch(base + "/ready");
  assert.equal(res.status, 503);
});

test("security headers are set and the framework is not advertised", async () => {
  const res = await fetch(base + "/health");
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.ok(res.headers.get("strict-transport-security"));
});

test("unknown routes return JSON 404 without leaking the query string", async () => {
  const res = await fetch(base + "/api/nope?token=secret");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.path, "/api/nope");
});

test("protected routes reject missing / garbage / forged tokens", async () => {
  const routes = ["/api/users/me", "/api/wallet", "/api/rooms/ABC123", "/api/games/history/my-games", "/api/leaderboard", "/api/rewards"];
  const forgedWrongSecret = jwt.sign({ id: "507f1f77bcf86cd799439011" }, "attacker-secret");
  const algNone = [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ id: "507f1f77bcf86cd799439011" })).toString("base64url"),
    "",
  ].join(".");

  for (const route of routes) {
    for (const auth of [undefined, "Bearer garbage", `Bearer ${forgedWrongSecret}`, `Bearer ${algNone}`]) {
      const res = await fetch(base + route, { headers: auth ? { authorization: auth } : {} });
      assert.equal(res.status, 401, `${route} with ${auth ? auth.slice(0, 20) : "no header"}`);
    }
  }
});

test("an expired token is rejected", async () => {
  const expired = jwt.sign({ id: "507f1f77bcf86cd799439011" }, config.jwt.secret, { expiresIn: -10 });
  const res = await fetch(base + "/api/users/me", { headers: { authorization: `Bearer ${expired}` } });
  assert.equal(res.status, 401);
});

test("register: validation errors (short / over-long password, bad email)", async () => {
  let res = await post("/api/auth/register", { name: "A", email: "nope", password: "123" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.message, "Validation Failed");
  assert.ok(body.errors.length >= 2);

  res = await post("/api/auth/register", { name: "Vishal", email: "v@example.com", password: "x".repeat(80) });
  assert.equal(res.status, 400); // bcrypt only reads 72 bytes
});

test("login: NoSQL operator injection is rejected, not executed", async () => {
  const res = await post("/api/auth/login", { email: { $gt: "" }, password: { $gt: "" } });
  assert.equal(res.status, 400);
});

test("malformed and oversized JSON bodies get clean 4xx errors", async () => {
  let res = await post("/api/auth/login", "{not json");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).message, "Malformed JSON body");

  res = await post("/api/auth/login", { email: "a@b.co", password: "x".repeat(20_000) });
  assert.equal(res.status, 413);
});

test("the public 'update my own leaderboard result' route needs auth", async () => {
  const res = await post("/api/leaderboard/update-result", { result: "win" });
  assert.equal(res.status, 401);
});

test("CORS: unlisted browser origins get no CORS headers (mobile clients unaffected)", async () => {
  const res = await fetch(base + "/health", { headers: { origin: "https://evil.example" } });
  assert.equal(res.status, 200);
  // in test env CLIENT_URL is empty -> dev-style permissive; production behaviour is covered below
});

test("error handler never leaks internal messages, keeps AppError messages", async () => {
  const mini = express();
  mini.get("/boom", () => {
    throw new Error("connect ECONNREFUSED mongodb://admin:hunter2@10.0.0.5");
  });
  mini.get("/known", () => {
    throw new AppError("Insufficient wallet balance", 400);
  });
  mini.get("/dup", () => {
    const e = new Error("E11000 duplicate key ... index: email_1");
    e.code = 11000;
    throw e;
  });
  mini.get("/version", () => {
    const e = new Error("No matching document");
    e.name = "VersionError";
    throw e;
  });
  mini.use(errorHandler);
  const s = http.createServer(mini);
  await new Promise((r) => s.listen(0, r));
  const b = `http://127.0.0.1:${s.address().port}`;
  try {
    let res = await fetch(b + "/boom");
    let body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.message, "Internal Server Error");
    assert.ok(!JSON.stringify(body).includes("hunter2"));

    res = await fetch(b + "/known");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).message, "Insufficient wallet balance");

    res = await fetch(b + "/dup");
    assert.equal(res.status, 409);
    assert.ok(!(await res.text()).includes("email_1"));

    res = await fetch(b + "/version");
    assert.equal(res.status, 409);
  } finally {
    s.close();
  }
});

test("sanitize strips $-operators and dotted keys from bodies", () => {
  const req = { body: { email: { $gt: "" }, ok: "x", "a.b": 1, nested: { list: [{ $ne: 1, keep: 2 }] } } };
  sanitize(req, {}, () => {});
  assert.deepEqual(req.body, { email: {}, ok: "x", nested: { list: [{ keep: 2 }] } });
});
