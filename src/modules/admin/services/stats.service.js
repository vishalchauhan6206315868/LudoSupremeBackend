"use strict";

/**
 * Aggregations behind the dashboard, reports and economy summary.
 *
 * Definitions (keep the Flutter labels in sync with these):
 *  - activePlayers   : distinct players who were seated in a match created in the period.
 *  - coinVolume      : coins wagered = sum of prizePool of settled (completed) matches.
 *  - platformRevenue : coins the platform kept = prizePool - prizes paid out, of settled matches.
 *                      (0 while PLATFORM_FEE_PERCENT=0, because the winner takes the whole pool.)
 *  - online users    : players seated in a match that is in_progress right now (no sockets yet).
 */
const mongoose = require("mongoose");
const config = require("../../../../config/env");
const User = require("../../auth/models/User");
const GameSession = require("../../games/models/GameSession");
const SupportTicket = require("../../support/models/SupportTicket");
const AdminAuditLog = require("../models/adminAuditLog.model");
const { lastDays, timeAgo } = require("../../../../utils/adminHelpers");

const DAY = 86_400_000;
const tz = () => config.admin.timezone;
const dayExpr = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: field, timezone: tz() } });
const MAX_PLAYERS = { twoPlayer: 2, fourPlayer: 4 };
const MODE_LABEL = { twoPlayer: "2 Player", fourPlayer: "4 Player" };

const growth = (current, previous) => {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
};

// ---- building blocks -------------------------------------------------------------------------

const distinctPlayers = async (range) => {
  const [r] = await GameSession.aggregate([
    { $match: { createdAt: range } },
    { $unwind: "$players" },
    { $group: { _id: "$players.user" } },
    { $count: "n" },
  ]);
  return r ? r.n : 0;
};

const revenueTotals = async (range = null) => {
  const match = { status: "completed", isPrizeDistributed: true };
  if (range) match.endedAt = range;
  const [r] = await GameSession.aggregate([
    { $match: match },
    { $group: { _id: null, volume: { $sum: "$prizePool" }, paid: { $sum: { $sum: "$players.prizeEarned" } } } },
  ]);
  const volume = r ? r.volume : 0;
  const paid = r ? r.paid : 0;
  return { coinVolume: volume, platformRevenue: Math.max(0, volume - paid) };
};

/** One row per day for the last `days` days (oldest first). Also feeds /reports/daily. */
const dailySeries = async (days) => {
  const keys = lastDays(days, tz());
  const start = new Date(Date.now() - (days + 1) * DAY);

  const [newUsersAgg, gamesAgg, activeAgg, revAgg, totalUsers] = await Promise.all([
    User.aggregate([{ $match: { createdAt: { $gte: start } } }, { $group: { _id: dayExpr("$createdAt"), n: { $sum: 1 } } }]),
    GameSession.aggregate([{ $match: { createdAt: { $gte: start } } }, { $group: { _id: dayExpr("$createdAt"), n: { $sum: 1 } } }]),
    GameSession.aggregate([
      { $match: { createdAt: { $gte: start } } },
      { $unwind: "$players" },
      { $group: { _id: { d: dayExpr("$createdAt"), u: "$players.user" } } },
      { $group: { _id: "$_id.d", n: { $sum: 1 } } },
    ]),
    GameSession.aggregate([
      { $match: { status: "completed", isPrizeDistributed: true, endedAt: { $gte: start } } },
      { $group: { _id: dayExpr("$endedAt"), volume: { $sum: "$prizePool" }, paid: { $sum: { $sum: "$players.prizeEarned" } } } },
    ]),
    User.estimatedDocumentCount(),
  ]);

  const toMap = (arr, f = (x) => x.n) => Object.fromEntries(arr.map((x) => [x._id, f(x)]));
  const newBy = toMap(newUsersAgg);
  const gamesBy = toMap(gamesAgg);
  const activeBy = toMap(activeAgg);
  const volBy = toMap(revAgg, (x) => x.volume);
  const platBy = toMap(revAgg, (x) => Math.max(0, x.volume - x.paid));

  // total users at the END of each day = totalNow - users created on later days
  let newAfter = 0;
  const totals = new Array(keys.length);
  for (let i = keys.length - 1; i >= 0; i--) {
    totals[i] = Math.max(0, totalUsers - newAfter);
    newAfter += newBy[keys[i].key] || 0;
  }

  return keys.map((k, i) => ({
    date: k.key,
    label: k.label,
    totalUsers: totals[i],
    newUsers: newBy[k.key] || 0,
    activePlayers: activeBy[k.key] || 0,
    games: gamesBy[k.key] || 0,
    coinVolume: volBy[k.key] || 0,
    platformRevenue: platBy[k.key] || 0,
  }));
};

// ---- dashboard ---------------------------------------------------------------------------------

const buildDashboard = async () => {
  const now = Date.now();
  const cur = { $gte: new Date(now - 30 * DAY) };
  const prev = { $gte: new Date(now - 60 * DAY), $lt: new Date(now - 30 * DAY) };

  const [
    totalUsers, newCur, newPrev, activeCur, activePrev,
    totalGames, gamesCur, gamesPrev,
    revAll, revCur, revPrev,
    modeAgg, recentSessions, recentUsers, liveMatches, livePlayers, series,
    openTickets, recentTickets, recentAudit,
  ] = await Promise.all([
    User.estimatedDocumentCount(),
    User.countDocuments({ createdAt: cur }),
    User.countDocuments({ createdAt: prev }),
    distinctPlayers(cur),
    distinctPlayers(prev),
    GameSession.estimatedDocumentCount(),
    GameSession.countDocuments({ createdAt: cur }),
    GameSession.countDocuments({ createdAt: prev }),
    revenueTotals(),
    revenueTotals(cur),
    revenueTotals(prev),
    GameSession.aggregate([{ $group: { _id: "$gameMode", count: { $sum: 1 } } }]),
    GameSession.find().sort({ createdAt: -1 }).limit(5).select("roomCode gameMode status players.user createdAt").lean(),
    User.find().sort({ createdAt: -1 }).limit(5).select("name email username isActive createdAt").lean(),
    GameSession.countDocuments({ status: "in_progress" }),
    GameSession.aggregate([
      { $match: { status: "in_progress" } },
      { $unwind: "$players" },
      { $group: { _id: "$players.user", name: { $first: "$players.name" }, mode: { $first: "$gameMode" }, at: { $max: "$updatedAt" } } },
      { $sort: { at: -1 } },
      { $facet: { count: [{ $count: "n" }], list: [{ $limit: 5 }] } },
    ]),
    dailySeries(7),
    SupportTicket.countDocuments({ status: { $in: ["open", "in_progress"] } }),
    SupportTicket.find().sort({ createdAt: -1 }).limit(3).select("ticketNo subject createdAt").lean(),
    AdminAuditLog.find().sort({ createdAt: -1 }).limit(3).select("action adminEmail createdAt").lean(),
  ]);

  // modes
  const counts = Object.fromEntries(modeAgg.filter((m) => m._id).map((m) => [m._id, m.count]));
  const modeTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  const modes = ["twoPlayer", "fourPlayer"].map((name) => ({
    name,
    label: MODE_LABEL[name],
    count: counts[name] || 0,
    percent: modeTotal ? Math.round(((counts[name] || 0) / modeTotal) * 100) : 0,
  }));

  // live / "online"
  const playersFacet = livePlayers[0] || { count: [], list: [] };
  const playersInMatch = playersFacet.count[0] ? playersFacet.count[0].n : 0;
  const onlineList = playersFacet.list.map((p) => ({
    name: p.name,
    where: `In Game (${MODE_LABEL[p.mode] || p.mode})`,
    ago: timeAgo(p.at),
  }));

  // activity feed from real events only
  const feed = [
    ...recentUsers.slice(0, 3).map((u) => ({ title: "New user registered", sub: u.name, at: u.createdAt })),
    ...recentSessions.slice(0, 3).map((g) => ({
      title: g.status === "completed" ? "Game completed" : g.status === "abandoned" ? "Game abandoned" : "Game started",
      sub: `Room ${g.roomCode} (${MODE_LABEL[g.gameMode] || g.gameMode})`,
      at: g.createdAt,
    })),
    ...recentTickets.map((t) => ({ title: "Support ticket raised", sub: `#${t.ticketNo}: ${t.subject}`, at: t.createdAt })),
    ...recentAudit.map((a) => ({ title: `Admin action: ${a.action}`, sub: a.adminEmail, at: a.createdAt })),
  ]
    .filter((e) => e.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 6)
    .map((e) => ({ title: e.title, sub: e.sub, time: new Date(e.at).toISOString() }));

  return {
    stats: {
      totalUsers,
      usersGrowth: growth(newCur, newPrev),
      activePlayers: activeCur,
      playersGrowth: growth(activeCur, activePrev),
      totalGames,
      gamesGrowth: growth(gamesCur, gamesPrev),
      // Coins the platform actually kept (0 while PLATFORM_FEE_PERCENT=0).
      totalRevenue: revAll.platformRevenue,
      revenueGrowth: growth(revCur.platformRevenue, revPrev.platformRevenue),
      // Coins wagered in settled matches (what the old dashboard called "revenue").
      coinVolume: revAll.coinVolume,
      coinVolumeGrowth: growth(revCur.coinVolume, revPrev.coinVolume),
      openTickets,
    },
    growth: {
      labels: series.map((d) => d.label),
      total: series.map((d) => d.totalUsers),
      active: series.map((d) => d.activePlayers),
    },
    modes,
    topGames: recentSessions.map((s) => {
      const max = MAX_PLAYERS[s.gameMode] || 2;
      const n = Array.isArray(s.players) ? s.players.length : 0;
      return {
        roomId: s.roomCode,
        mode: s.gameMode,
        modeLabel: MODE_LABEL[s.gameMode] || s.gameMode,
        players: n,
        maxPlayers: max,
        playersLabel: `${n}/${max}`,
        status: s.status,
        createdAt: s.createdAt.toISOString(),
      };
    }),
    revenue: {
      labels: series.map((d) => d.label),
      values: series.map((d) => d.coinVolume), // alias of `volume`, kept for older clients
      volume: series.map((d) => d.coinVolume),
      platform: series.map((d) => d.platformRevenue),
    },
    recentUsers: recentUsers.map((u) => ({
      id: u._id,
      name: u.name || "Unknown",
      email: u.email || "",
      joinedOn: u.createdAt ? u.createdAt.toISOString() : "",
      status: u.isActive === false ? "Blocked" : "Active",
    })),
    activities: feed,
    onlineUsers: { count: playersInMatch, list: onlineList },
    live: { matches: liveMatches, playersInMatch },
  };
};

let cache = { at: 0, data: null };
let inflight = null;

/** Cached for ADMIN_DASHBOARD_CACHE_SECONDS; concurrent callers share one computation. */
const getDashboard = async ({ fresh = false } = {}) => {
  const ttl = config.admin.dashboardCacheSeconds * 1000;
  if (!fresh && ttl > 0 && cache.data && Date.now() - cache.at < ttl) return { data: cache.data, cached: true };
  if (!inflight) {
    inflight = buildDashboard()
      .then((data) => { cache = { at: Date.now(), data }; return data; })
      .finally(() => { inflight = null; });
  }
  return { data: await inflight, cached: false };
};

const clearDashboardCache = () => { cache = { at: 0, data: null }; };

/** Live health block (never cached). */
const getHealth = async (live) => {
  const up = mongoose.connection.readyState === 1;
  let dbPingMs = null;
  if (up) {
    const t = process.hrtime.bigint();
    try {
      await mongoose.connection.db.admin().ping();
      dbPingMs = Math.round(Number(process.hrtime.bigint() - t) / 1e6);
    } catch (_e) { /* reported as null */ }
  }
  return {
    backend: "Online",
    database: up && dbPingMs !== null ? "Online" : "Offline",
    dbPingMs,
    apiResponseMs: dbPingMs, // kept for older clients: round-trip to the database
    // No websockets yet: this is the number of players inside a live match.
    activeConnections: live ? live.playersInMatch : 0,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
  };
};

module.exports = { dailySeries, revenueTotals, getDashboard, clearDashboardCache, getHealth, growth };
