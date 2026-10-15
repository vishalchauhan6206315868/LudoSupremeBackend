"use strict";
/**
 * Runs the real dashboard builder against stubbed Mongoose models (no database needed) to check
 * the response shape, the maths and the mapping. The aggregation pipelines themselves are only
 * truly verified by the integration suite on a real MongoDB.
 */
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../../config/env");
const { lastDays } = require("../../utils/adminHelpers");
const User = require("../../src/modules/auth/models/User");
const GameSession = require("../../src/modules/games/models/GameSession");
const SupportTicket = require("../../src/modules/support/models/SupportTicket");
const AdminAuditLog = require("../../src/modules/admin/models/adminAuditLog.model");
const stats = require("../../src/modules/admin/services/stats.service");

const chain = (result) => {
  const c = { sort: () => c, limit: () => c, skip: () => c, select: () => c, populate: () => c, lean: async () => result };
  return c;
};
const today = lastDays(7, config.admin.timezone)[6].key;
const now = new Date();

User.estimatedDocumentCount = async () => 100;
User.countDocuments = async () => 6;
User.find = () => chain([{ _id: "u1", name: "Rohit", email: "r@x.com", isActive: true, createdAt: now }, { _id: "u2", name: "Pooja", email: "p@x.com", isActive: false, createdAt: now }]);
User.aggregate = async () => [{ _id: today, n: 4 }];

GameSession.estimatedDocumentCount = async () => 40;
GameSession.countDocuments = async (f) => (f && f.status === "in_progress" ? 2 : 12);
GameSession.find = () => chain([{ roomCode: "ABC123", gameMode: "twoPlayer", status: "completed", players: [{ user: "u1" }, { user: "u2" }], createdAt: now }]);
GameSession.aggregate = async (pipeline) => {
  const j = JSON.stringify(pipeline);
  if (j.includes('"in_progress"')) return [{ count: [{ n: 2 }], list: [{ _id: "u1", name: "Rohit", mode: "twoPlayer", at: now }] }];
  if (j.includes('"isPrizeDistributed"') && j.includes('"$dateToString"')) return [{ _id: today, volume: 600, paid: 500 }];
  if (j.includes('"isPrizeDistributed"')) return [{ _id: null, volume: 1000, paid: 900 }];
  if (j.includes('"$count":"n"')) return [{ n: 50 }];
  if (j.includes('"$dateToString"') && j.includes('"$unwind"')) return [{ _id: today, n: 7 }];
  if (j.includes('"$dateToString"')) return [{ _id: today, n: 9 }];
  return [{ _id: "twoPlayer", count: 3 }, { _id: "fourPlayer", count: 1 }];
};
SupportTicket.countDocuments = async () => 3;
SupportTicket.find = () => chain([{ ticketNo: "TKT-100001", subject: "Coins missing", createdAt: now }]);
AdminAuditLog.find = () => chain([{ action: "user.block", adminEmail: "a@x.com", createdAt: now }]);

test("dashboard payload has the shape the admin panel expects", async () => {
  stats.clearDashboardCache();
  const { data } = await stats.getDashboard({ fresh: true });

  assert.equal(data.stats.totalUsers, 100);
  assert.equal(data.stats.totalGames, 40);
  assert.equal(data.stats.activePlayers, 50);
  assert.equal(data.stats.coinVolume, 1000);
  assert.equal(data.stats.totalRevenue, 100); // platform kept 1000 - 900
  assert.equal(data.stats.openTickets, 3);
  assert.equal(data.stats.usersGrowth, 0); // 6 vs 6

  assert.equal(data.growth.labels.length, 7);
  assert.equal(data.growth.total.length, 7);
  assert.equal(data.growth.total[6], 100); // today's total = all users
  assert.equal(data.growth.total[5], 96); // 4 users joined today
  assert.equal(data.growth.active[6], 7);

  assert.deepEqual(data.modes.map((m) => [m.name, m.percent, m.count]), [["twoPlayer", 75, 3], ["fourPlayer", 25, 1]]);
  assert.equal(data.modes[0].label, "2 Player");

  assert.equal(data.topGames[0].playersLabel, "2/2");
  assert.equal(data.topGames[0].status, "completed");
  assert.equal(typeof data.topGames[0].createdAt, "string");

  assert.equal(data.revenue.volume[6], 600);
  assert.equal(data.revenue.platform[6], 100);
  assert.deepEqual(data.revenue.values, data.revenue.volume);

  assert.deepEqual(data.recentUsers.map((u) => u.status), ["Active", "Blocked"]);
  assert.equal(data.onlineUsers.count, 2);
  assert.equal(data.onlineUsers.list[0].where, "In Game (2 Player)");
  assert.ok(data.activities.length > 0 && data.activities.length <= 6);
  assert.ok(data.activities.every((a) => a.title && a.time));
  assert.deepEqual(data.live, { matches: 2, playersInMatch: 2 });
});

test("dashboard is cached and concurrent callers share one computation", async () => {
  stats.clearDashboardCache();
  let calls = 0;
  const orig = User.estimatedDocumentCount;
  User.estimatedDocumentCount = async () => { calls++; return 100; };
  try {
    const [a, b] = await Promise.all([stats.getDashboard(), stats.getDashboard()]);
    assert.equal(a.data, b.data);
    const c = await stats.getDashboard();
    assert.equal(c.cached, true);
    assert.equal(calls, 2); // one dashboard build = 2 estimatedDocumentCount calls (stats + series), not 3 builds
  } finally { User.estimatedDocumentCount = orig; }
});

test("daily report series is consistent", async () => {
  const rows = await stats.dailySeries(7);
  assert.equal(rows.length, 7);
  const last = rows[6];
  assert.equal(last.newUsers, 4);
  assert.equal(last.games, 9);
  assert.equal(last.platformRevenue, 100);
  assert.equal(last.totalUsers, 100);
  assert.equal(rows[0].totalUsers, 96);
});
