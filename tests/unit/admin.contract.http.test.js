"use strict";
/**
 * Admin API contract checks over real HTTP, with the Mongoose models stubbed (no database).
 * Covers what the Flutter admin panel relies on: winner/moves shape, settings keys, audit-log
 * prefix filter, banner page size, /me createdAt and the dashboard refresh limiter.
 */
process.env.NODE_ENV = "test";
process.env.RATE_LIMIT_ENABLED = "true"; // the refresh limiter is a no-op while rate limiting is disabled

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const jwt = require("jsonwebtoken");

const config = require("../../config/env");
const Admin = require("../../src/modules/admin/models/admin.model");
const AdminAuditLog = require("../../src/modules/admin/models/adminAuditLog.model");
const Banner = require("../../src/modules/banners/models/Banner");
const GameSession = require("../../src/modules/games/models/GameSession");
const stats = require("../../src/modules/admin/services/stats.service");
const errorHandler = require("../../middleware/error.middleware");
const app = require("../../app");

const ADMIN_ID = "64b000000000000000000001";
const created = new Date("2026-09-01T09:00:00.000Z");
let selectArg = "";
let auditFilter = null;
let bannerLimitSeen = null;

const chain = (result) => {
  const c = { sort: () => c, skip: () => c, limit: (n) => { bannerLimitSeen = n; return c; }, select: () => c, populate: () => c, lean: async () => result };
  return c;
};

Admin.findById = () => ({
  select: (s) => {
    selectArg = s;
    return { lean: async () => ({ _id: ADMIN_ID, name: "Root", email: "root@x.com", role: "superadmin", isActive: true, createdAt: created }) };
  },
});
AdminAuditLog.countDocuments = async (f) => { auditFilter = f; return 1; };
AdminAuditLog.find = (f) => {
  auditFilter = f;
  return chain([{ _id: "l1", admin: ADMIN_ID, adminEmail: "root@x.com", action: "wallet.credit", targetType: "user", targetId: "u1", meta: { amount: 50 }, ip: "1.1.1.1", requestId: "r1", __v: 0, createdAt: created }]);
};
Banner.countDocuments = async () => 1;
Banner.find = () => chain([{ _id: "b1", title: "Promo", __v: 0 }]);
const GAME = {
  _id: "g1", roomCode: "ABC123", gameMode: "twoPlayer", status: "completed", winner: "u1", entryFee: 10, prizePool: 20,
  players: [{ user: "u1", name: "Rohit", color: "Red" }, { user: "u2", name: "Pooja", color: "Green" }],
  history: [{ player: "u2", action: "MOVE", diceValue: 5, timestamp: created }],
};
GameSession.countDocuments = async () => 1;
GameSession.find = () => chain([GAME]);
GameSession.findById = () => ({ lean: async () => GAME });
stats.getDashboard = async () => ({ data: { live: { matches: 0, playersInMatch: 0 }, stats: {} }, cached: false });
stats.getHealth = async () => ({ backend: "Online", database: "Online" });

let server, base;
const token = jwt.sign({ id: ADMIN_ID, typ: "admin" }, config.jwt.secret, { algorithm: "HS256", issuer: config.jwt.issuer, expiresIn: "1h" });
const get = async (path) => {
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() };
};

test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test("/me returns createdAt (profile 'Member since')", async () => {
  const r = await get("/api/admin/me");
  assert.equal(r.status, 200);
  assert.match(selectArg, /createdAt/);
  assert.equal(new Date(r.body.data.admin.createdAt).toISOString(), created.toISOString());
});

test("games: winner is {id,name}; moves carry player name", async () => {
  const list = await get("/api/admin/games");
  assert.deepEqual(list.body.data.games[0].winner, { id: "u1", name: "Rohit" });
  assert.equal(list.body.data.games[0].players[1].userId, "u2");

  const detail = await get("/api/admin/games/64b000000000000000000009");
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.data.game.winner, { id: "u1", name: "Rohit" });
  assert.equal(detail.body.data.game.moves[0].player, "Pooja");
  assert.equal(detail.body.data.game.moves[0].diceValue, 5);
});

test("settings expose real config names (no invented keys)", async () => {
  const r = await get("/api/admin/settings");
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.rateLimit.globalPerMinute, config.rateLimit.globalPerMinute);
  assert.equal(d.rateLimit.adminAuthAttempts, config.rateLimit.adminAuthAttempts);
  assert.equal(d.game.matchDurationSeconds, config.game.matchDurationSeconds);
  assert.equal("maxSurrenders" in d.game, false);
});

test("audit-logs: action filter is a prefix match and meta is returned", async () => {
  const r = await get("/api/admin/audit-logs?action=Wallet.");
  assert.equal(r.status, 200);
  assert.ok(auditFilter.action instanceof RegExp);
  assert.ok(auditFilter.action.test("wallet.credit"));
  assert.ok(!auditFilter.action.test("user.wallet.credit"));
  assert.deepEqual(r.body.data.logs[0].meta, { amount: 50 });
  assert.equal(r.body.data.logs[0].requestId, "r1");
  assert.equal("__v" in r.body.data.logs[0], false);
});

test("audit-logs: regex characters in the filter are escaped", async () => {
  await get("/api/admin/audit-logs?action=.*");
  assert.ok(!auditFilter.action.test("wallet.credit"));
});

test("banners: default page is 50 and rows have an id", async () => {
  const r = await get("/api/admin/banners");
  assert.equal(bannerLimitSeen, 50);
  assert.equal(r.body.data.pagination.limit, 50);
  assert.equal(r.body.data.banners[0].id, "b1");
  const big = await get("/api/admin/banners?limit=100");
  assert.equal(big.body.data.pagination.limit, 100);
});

test("dashboard ?refresh=1 is limited to once per 10s, cached reads are not", async () => {
  assert.equal((await get("/api/admin/dashboard")).status, 200);
  assert.equal((await get("/api/admin/dashboard")).status, 200);
  assert.equal((await get("/api/admin/dashboard?refresh=1")).status, 200);
  const again = await get("/api/admin/dashboard?refresh=1");
  assert.equal(again.status, 429);
  assert.match(again.body.message, /refreshed/i);
  assert.equal((await get("/api/admin/dashboard")).status, 200); // normal read still fine
});

test("a MongoDB MaxTimeMSExpired error becomes a friendly 503", () => {
  let status, body;
  const res = { headersSent: false, status(s) { status = s; return this; }, json(b) { body = b; } };
  errorHandler({ code: 50, name: "MongoServerError" }, { id: "r1", originalUrl: "/api/admin/users" }, res, () => {});
  assert.equal(status, 503);
  assert.match(body.message, /too long/i);
});
