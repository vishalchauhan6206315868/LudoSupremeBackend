"use strict";
process.env.NODE_ENV = "test";
process.env.RATE_LIMIT_ENABLED = "true"; // limiter is off by default in tests

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const { createRateLimiter } = require("../../middleware/rateLimit.middleware");

const listen = (app) =>
  new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => resolve(server));
  });

test("blocks after max requests with 429 + Retry-After, per key", async () => {
  const app = express();
  app.use(createRateLimiter({ windowMs: 60_000, max: 2, keyGenerator: (req) => req.headers["x-key"] }));
  app.get("/", (req, res) => res.json({ ok: true }));
  const server = await listen(app);
  const url = `http://127.0.0.1:${server.address().port}/`;

  try {
    const hit = (key) => fetch(url, { headers: { "x-key": key } });
    assert.equal((await hit("a")).status, 200);
    assert.equal((await hit("a")).status, 200);
    const blocked = await hit("a");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.equal((await blocked.json()).success, false);
    // a different key (different user / IP) is unaffected
    assert.equal((await hit("b")).status, 200);
  } finally {
    server.close();
  }
});

test("skipSuccessfulRequests: only failures use up the login budget", async () => {
  const app = express();
  app.use(createRateLimiter({ windowMs: 60_000, max: 2, keyGenerator: () => "k", skipSuccessfulRequests: true }));
  app.get("/ok", (req, res) => res.json({ ok: true }));
  app.get("/fail", (req, res) => res.status(401).json({ ok: false }));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    for (let i = 0; i < 6; i++) assert.equal((await fetch(`${base}/ok`)).status, 200); // successes are free
    assert.equal((await fetch(`${base}/fail`)).status, 401);
    assert.equal((await fetch(`${base}/fail`)).status, 401);
    assert.equal((await fetch(`${base}/fail`)).status, 429); // 3rd failure is blocked
  } finally {
    server.close();
  }
});
