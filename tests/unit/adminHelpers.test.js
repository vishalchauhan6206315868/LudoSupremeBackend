"use strict";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("../../utils/adminHelpers");
const { isStrongPassword } = require("../../utils/passwordPolicy");
const { growth } = require("../../src/modules/admin/services/stats.service");
const { loadConfig } = require("../../config/env");

test("parsePagination clamps page/limit and ignores array/object query values", () => {
  assert.deepEqual(h.parsePagination({}), { page: 1, limit: 20, skip: 0 });
  assert.deepEqual(h.parsePagination({ page: "3", limit: "10" }), { page: 3, limit: 10, skip: 20 });
  assert.equal(h.parsePagination({ limit: "100000" }).limit, 100);
  assert.equal(h.parsePagination({ page: "-5", limit: "0" }).page, 1);
  assert.equal(h.parsePagination({ page: ["2", "3"], limit: { $gt: 1 } }).page, 1); // ?page=2&page=3 / nested
});

test("escapeRegex neutralises regex injection", () => {
  const rx = new RegExp(h.escapeRegex("(a+)+$.*"), "i");
  assert.ok(rx.test("xx(a+)+$.*yy"));
  assert.ok(!rx.test("aaaa"));
});

test("qs only accepts plain strings", () => {
  assert.equal(h.qs("a"), "a");
  assert.equal(h.qs(["a"]), "");
  assert.equal(h.qs({ $ne: 1 }), "");
  assert.equal(h.qs(undefined), "");
});

test("dateRange builds bounds and rejects garbage", () => {
  assert.equal(h.dateRange("nope", undefined), null);
  const r = h.dateRange("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
  assert.ok(r.$gte instanceof Date && r.$lte instanceof Date);
});

test("lastDays returns n consecutive day keys in the given time zone", () => {
  const now = new Date("2026-10-09T20:00:00Z"); // already Oct 10 in Asia/Kolkata (+05:30)
  const days = h.lastDays(7, "Asia/Kolkata", now);
  assert.equal(days.length, 7);
  assert.equal(days[6].key, "2026-10-10");
  assert.equal(days[0].key, "2026-10-04");
  assert.match(days[6].label, /Oct 10/);
  assert.equal(h.lastDays(1, "UTC", now)[0].key, "2026-10-09");
});

test("timeAgo", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  assert.equal(h.timeAgo(new Date("2026-10-09T11:58:00Z"), now), "2m ago");
  assert.equal(h.timeAgo(new Date("2026-10-09T09:00:00Z"), now), "3h ago");
});

test("password policy", () => {
  assert.equal(isStrongPassword("Admin@123456"), false); // contains a common pattern
  assert.equal(isStrongPassword("short1"), false);
  assert.equal(isStrongPassword("onlyletterspassphrase"), false);
  assert.equal(isStrongPassword("k7-Vault-Orange-42"), true);
  assert.equal(isStrongPassword("a1".repeat(40)), false); // > 72 (bcrypt limit)
  assert.equal(isStrongPassword(undefined), false);
});

test("growth percentage", () => {
  assert.equal(growth(0, 0), 0);
  assert.equal(growth(5, 0), 100);
  assert.equal(growth(150, 100), 50);
  assert.equal(growth(50, 100), -50);
});

test("config: admin settings validated", () => {
  const base = { NODE_ENV: "test" };
  assert.equal(loadConfig(base).admin.jwtExpiresIn, "8h");
  assert.throws(() => loadConfig({ ...base, ADMIN_TIMEZONE: "Mars/Olympus" }), /ADMIN_TIMEZONE/);
  assert.throws(() => loadConfig({ ...base, ADMIN_MAX_COIN_ADJUST: "0" }), /ADMIN_MAX_COIN_ADJUST/);
});
