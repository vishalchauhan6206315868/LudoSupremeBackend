"use strict";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../../config/env");

const prodEnv = (overrides = {}) => ({
  NODE_ENV: "production",
  MONGO_URI: "mongodb://localhost:27017/x",
  JWT_SECRET: "k9Jd82hs0QpLx7vZr3WmTn5bYcAe1UgF4oHiKs6D",
  ...overrides,
});

test("production: valid config loads", () => {
  const c = loadConfig(prodEnv());
  assert.equal(c.isProd, true);
  assert.equal(c.db.requireReplicaSet, true); // safe default for money flows
  assert.equal(c.jwt.algorithm, "HS256");
});

test("production: missing JWT_SECRET refuses to boot (no hard-coded fallback secret)", () => {
  assert.throws(() => loadConfig(prodEnv({ JWT_SECRET: "" })), /JWT_SECRET is required/);
});

test("production: short or guessable JWT_SECRET is rejected", () => {
  assert.throws(() => loadConfig(prodEnv({ JWT_SECRET: "short" })), /at least 32/);
  assert.throws(
    () => loadConfig(prodEnv({ JWT_SECRET: "ludo-supreme-default-secret-ludo-supreme" })),
    /guessable/
  );
});

test("production: MONGO_URI is required", () => {
  assert.throws(() => loadConfig(prodEnv({ MONGO_URI: "" })), /MONGO_URI is required/);
});

test("economy limits are validated", () => {
  assert.throws(() => loadConfig(prodEnv({ PLATFORM_FEE_PERCENT: "80" })), /PLATFORM_FEE_PERCENT/);
  assert.equal(loadConfig(prodEnv({ PLATFORM_FEE_PERCENT: "5" })).economy.platformFeePercent, 5);
});

test("development: a random ephemeral secret is generated, never a known default", () => {
  const a = loadConfig({ NODE_ENV: "development", MONGO_URI: "mongodb://x" });
  const b = loadConfig({ NODE_ENV: "development", MONGO_URI: "mongodb://x" });
  assert.ok(a.jwt.secret.length >= 64);
  assert.notEqual(a.jwt.secret, b.jwt.secret);
});

test("trust proxy parsing", () => {
  assert.equal(loadConfig(prodEnv({ TRUST_PROXY: "1" })).trustProxy, 1);
  assert.equal(loadConfig(prodEnv({ TRUST_PROXY: "true" })).trustProxy, true);
  assert.equal(loadConfig(prodEnv()).trustProxy, false);
});
