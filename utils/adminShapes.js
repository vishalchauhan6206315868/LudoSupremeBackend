"use strict";

/**
 * Pure response-shaping helpers for the admin API (no database access, unit-tested).
 * Keep these in sync with docs/admin-api.md and the Flutter admin panel.
 */

const idStr = (v) => (v === null || v === undefined ? null : String(v));

// ---------------------------------------------------------------- games
const playerView = (p) => ({
  userId: idStr(p.user),
  name: p.name || null,
  color: p.color || null,
  score: p.score || 0,
  outcome: p.outcome || null,
  prizeEarned: p.prizeEarned || 0,
  hasSurrendered: Boolean(p.hasSurrendered),
});

/** winner is stored as a user id; the admin panel needs the id AND a readable name. */
const winnerView = (winnerId, players = []) => {
  const id = idStr(winnerId);
  if (!id) return null;
  const p = players.find((x) => idStr(x.user) === id);
  return { id, name: p && p.name ? p.name : null };
};

const gameSummary = (g) => ({
  id: g._id,
  roomCode: g.roomCode,
  mode: g.gameMode,
  status: g.status,
  entryFee: g.entryFee,
  prizePool: g.prizePool,
  isPrizeDistributed: g.isPrizeDistributed,
  winner: winnerView(g.winner, g.players || []),
  settlementReason: g.settlement ? g.settlement.reason : null,
  players: (g.players || []).map(playerView),
  startedAt: g.startedAt,
  endedAt: g.endedAt,
  createdAt: g.createdAt,
});

/** A move log entry with the player's NAME (the log itself only stores the user id). */
const moveView = (m, players = []) => {
  const id = idStr(m.player);
  const p = id ? players.find((x) => idStr(x.user) === id) : null;
  return {
    playerId: id,
    player: p && p.name ? p.name : null,
    action: m.action,
    diceValue: m.diceValue ?? null,
    tokenId: m.tokenId ?? null,
    prevStep: m.prevStep ?? null,
    newStep: m.newStep ?? null,
    pointsEarned: m.pointsEarned || 0,
    timestamp: m.timestamp || null,
  };
};

const gameDetail = (g) => ({
  ...gameSummary(g),
  turnStatus: g.turnStatus,
  currentTurnPlayer: idStr(g.currentTurnPlayer),
  turnDeadline: g.turnDeadline || null,
  players: (g.players || []).map((p) => ({ ...playerView(p), tokens: p.tokens })),
  moves: (g.history || []).map((m) => moveView(m, g.players || [])),
});

// -------------------------------------------------------------- settings
// Explicit whitelist: a new config key (or secret) is never exposed by accident.
const pick = (obj = {}, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

const settingsView = (config, { version, nodeVersion } = {}) => ({
  environment: config.env,
  version: version || "1.2.0",
  node: nodeVersion || process.version,
  timezone: config.admin.timezone,
  game: pick(config.game, ["turnTimeoutSeconds", "turnTimeoutGraceMs", "matchDurationSeconds", "sweeperEnabled", "sweeperIntervalMs"]),
  economy: pick(config.economy, ["signupBonusCoins", "maxEntryFee", "platformFeePercent", "roomWaitingTtlMinutes"]),
  admin: pick(config.admin, ["jwtExpiresIn", "maxCoinAdjust", "dashboardCacheSeconds"]),
  rateLimit: pick(config.rateLimit, [
    "enabled", "globalPerMinute", "authAttempts", "authWindowMinutes", "registerPerHour",
    "gameActionsPerMinute", "adminAuthAttempts", "adminIpAttempts", "adminWritesPerMinute",
  ]),
  database: { requireReplicaSet: config.db.requireReplicaSet, maxPoolSize: config.db.maxPoolSize },
});

// ------------------------------------------------------------ audit log
const auditView = (l) => ({
  id: l._id,
  createdAt: l.createdAt,
  adminId: idStr(l.admin),
  adminEmail: l.adminEmail,
  action: l.action,
  targetType: l.targetType || null,
  targetId: l.targetId || null,
  meta: l.meta || {},
  ip: l.ip || null,
  requestId: l.requestId || null,
});

// --------------------------------------------------------------- banners
const bannerView = (b) => {
  const o = b && typeof b.toObject === "function" ? b.toObject() : { ...b };
  const { __v, ...rest } = o;
  return { ...rest, id: o._id };
};

module.exports = { idStr, playerView, winnerView, gameSummary, moveView, gameDetail, settingsView, auditView, bannerView };
