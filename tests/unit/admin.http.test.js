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
const v = require("../../src/modules/admin/validations/admin.validation");

let server;
let base;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const call = (method, path, { token, body } = {}) =>
  fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

const sign = (claims, opts = {}) =>
  jwt.sign({ id: "64b000000000000000000001", ...claims }, config.jwt.secret, {
    algorithm: "HS256", issuer: config.jwt.issuer, expiresIn: "1h", ...opts,
  });

const ID = "64b000000000000000000001";
const PROTECTED = [
  ["GET", "/api/admin/me"], ["POST", "/api/admin/change-password"], ["POST", "/api/admin/logout-all"],
  ["GET", "/api/admin/dashboard"], ["GET", "/api/admin/settings"],
  ["GET", "/api/admin/users"], ["GET", `/api/admin/users/${ID}`],
  ["PATCH", `/api/admin/users/${ID}/status`], ["POST", `/api/admin/users/${ID}/coins`],
  ["GET", "/api/admin/games"], ["GET", `/api/admin/games/${ID}`],
  ["GET", "/api/admin/transactions"], ["GET", "/api/admin/economy/summary"], ["GET", "/api/admin/reports/daily"],
  ["GET", "/api/admin/banners"], ["POST", "/api/admin/banners"], ["PATCH", `/api/admin/banners/${ID}`], ["DELETE", `/api/admin/banners/${ID}`],
  ["GET", "/api/admin/support/tickets"], ["GET", `/api/admin/support/tickets/${ID}`],
  ["POST", `/api/admin/support/tickets/${ID}/reply`], ["PATCH", `/api/admin/support/tickets/${ID}/status`],
  ["GET", "/api/admin/audit-logs"], ["GET", "/api/admin/admins"], ["POST", "/api/admin/admins"], ["PATCH", `/api/admin/admins/${ID}/status`],
];

test("every admin endpoint (except login) rejects requests without a token", async () => {
  for (const [m, p] of PROTECTED) {
    const res = await call(m, p);
    assert.equal(res.status, 401, `${m} ${p} should be 401, got ${res.status}`);
  }
});

test("forged, expired, wrong-secret and alg:none tokens are rejected", async () => {
  const bad = [
    jwt.sign({ id: ID, typ: "admin" }, "another-secret-another-secret-another", { algorithm: "HS256", issuer: config.jwt.issuer }),
    sign({ typ: "admin" }, { expiresIn: -10 }),
    sign({ typ: "admin" }, { issuer: "someone-else" }),
    `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ id: ID, typ: "admin" })).toString("base64url")}.`,
    "garbage",
  ];
  for (const token of bad) {
    assert.equal((await call("GET", "/api/admin/dashboard", { token })).status, 401);
  }
});

test("a PLAYER token (no typ:'admin') can never open admin routes", async () => {
  const playerToken = sign({}); // exactly what /api/auth/login issues
  for (const [m, p] of PROTECTED.slice(0, 8)) {
    assert.equal((await call(m, p, { token: playerToken })).status, 401, `${m} ${p}`);
  }
});

test("an ADMIN token can never open player routes", async () => {
  const adminToken = sign({ typ: "admin" });
  assert.equal((await call("GET", "/api/users/me", { token: adminToken })).status, 401);
  assert.equal((await call("GET", "/api/wallet/me", { token: adminToken })).status, 401);
  assert.equal((await call("GET", "/api/support/tickets/mine", { token: adminToken })).status, 401);
});

test("admin login validates its input before touching the database", async () => {
  assert.equal((await call("POST", "/api/admin/login", { body: {} })).status, 400);
  assert.equal((await call("POST", "/api/admin/login", { body: { email: "nope", password: "x" } })).status, 400);
  const injection = await call("POST", "/api/admin/login", { body: { email: { $gt: "" }, password: { $gt: "" } } });
  assert.equal(injection.status, 400);
});

test("player-facing banner / support routes need a player token", async () => {
  assert.equal((await call("GET", "/api/banners")).status, 401);
  assert.equal((await call("POST", "/api/support/tickets", { body: { subject: "x", message: "y" } })).status, 401);
});

// ---- validators in isolation (no database needed) ----
const mini = (method, path, rules) => {
  const a = express();
  a.use(express.json());
  a[method](path, ...rules, v.validateRequest, (req, res) => res.json({ ok: true, body: req.body }));
  a.use(errorHandler);
  const s = http.createServer(a);
  return new Promise((resolve) => s.listen(0, () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` })));
};
const send = (url, method, body) =>
  fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("coin adjustment validator", async () => {
  const { s, url } = await mini("post", "/u/:id/coins", v.coinAdjustValidation);
  try {
    const ok = { type: "credit", amount: 500, reason: "Compensation for ticket 1" };
    assert.equal((await send(`${url}/u/${ID}/coins`, "POST", ok)).status, 200);
    assert.equal((await send(`${url}/u/not-an-id/coins`, "POST", ok)).status, 400);
    assert.equal((await send(`${url}/u/${ID}/coins`, "POST", { ...ok, type: "mint" })).status, 400);
    assert.equal((await send(`${url}/u/${ID}/coins`, "POST", { ...ok, amount: 0 })).status, 400);
    assert.equal((await send(`${url}/u/${ID}/coins`, "POST", { ...ok, amount: -5 })).status, 400);
    assert.equal((await send(`${url}/u/${ID}/coins`, "POST", { ...ok, amount: 1.5 })).status, 400);
    assert.equal((await send(`${url}/u/${ID}/coins`, "POST", { ...ok, amount: config.admin.maxCoinAdjust + 1 })).status, 400);
    assert.equal((await send(`${url}/u/${ID}/coins`, "POST", { ...ok, reason: "" })).status, 400);
    assert.equal((await send(`${url}/u/${ID}/coins`, "POST", { ...ok, idempotencyKey: "short" })).status, 400);
    const coerced = await (await send(`${url}/u/${ID}/coins`, "POST", { ...ok, amount: "500" })).json();
    assert.equal(coerced.body.amount, 500); // string -> integer
  } finally { s.close(); }
});

test("block requires a reason, unblock does not", async () => {
  const { s, url } = await mini("patch", "/u/:id/status", v.userStatusValidation);
  try {
    assert.equal((await send(`${url}/u/${ID}/status`, "PATCH", { isActive: false })).status, 400);
    assert.equal((await send(`${url}/u/${ID}/status`, "PATCH", { isActive: false, reason: "ab" })).status, 400);
    assert.equal((await send(`${url}/u/${ID}/status`, "PATCH", { isActive: false, reason: "Chargeback fraud" })).status, 200);
    assert.equal((await send(`${url}/u/${ID}/status`, "PATCH", { isActive: true })).status, 200);
    assert.equal((await send(`${url}/u/${ID}/status`, "PATCH", { isActive: "false", reason: "text here" })).status, 400); // strict boolean
  } finally { s.close(); }
});

test("banner + admin creation + password validators", async () => {
  const b = await mini("post", "/b", v.bannerCreateValidation);
  const a = await mini("post", "/a", v.createAdminValidation);
  const c = await mini("post", "/c", v.changePasswordValidation);
  try {
    const banner = { title: "Weekend Tournament", imageUrl: "https://cdn.example.com/a.png" };
    assert.equal((await send(`${b.url}/b`, "POST", banner)).status, 200);
    assert.equal((await send(`${b.url}/b`, "POST", { ...banner, imageUrl: "http://insecure.example.com/a.png" })).status, 400);
    assert.equal((await send(`${b.url}/b`, "POST", { ...banner, imageUrl: "javascript:alert(1)" })).status, 400);
    assert.equal((await send(`${b.url}/b`, "POST", { ...banner, startsAt: "2026-05-02", endsAt: "2026-05-01" })).status, 400);
    assert.equal((await send(`${b.url}/b`, "POST", { title: "x" })).status, 400);

    const admin = { name: "Ops Admin", email: "ops@company.com", password: "k7-Vault-Orange-42" };
    assert.equal((await send(`${a.url}/a`, "POST", admin)).status, 200);
    assert.equal((await send(`${a.url}/a`, "POST", { ...admin, password: "Admin@123456" })).status, 400);
    assert.equal((await send(`${a.url}/a`, "POST", { ...admin, role: "root" })).status, 400);

    assert.equal((await send(`${c.url}/c`, "POST", { currentPassword: "old", newPassword: "k7-Vault-Orange-42" })).status, 200);
    assert.equal((await send(`${c.url}/c`, "POST", { currentPassword: "old", newPassword: "weak" })).status, 400);
  } finally { b.s.close(); a.s.close(); c.s.close(); }
});
