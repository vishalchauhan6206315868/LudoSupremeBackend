"use strict";

const asyncHandler = require("../../../../utils/asyncHandler");
const { qs, parsePagination, pageMeta, dateRange } = require("../../../../utils/adminHelpers");
const Wallet = require("../../wallet/models/Wallet");
const WalletTransaction = require("../../wallet/models/WalletTransaction");
const { dailySeries, revenueTotals } = require("../services/stats.service");

const DAY = 86_400_000;
const SOURCES = ["game_reward", "game_entry", "bonus", "admin", "refund", "other"];

// GET /api/admin/transactions?page&limit&type=credit|debit&source&userId&from&to
exports.listTransactions = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  const type = qs(req.query.type);
  if (type === "credit" || type === "debit") filter.type = type;
  const source = qs(req.query.source);
  if (SOURCES.includes(source)) filter.source = source;
  const userId = qs(req.query.userId);
  if (userId) filter.user = userId;
  const range = dateRange(req.query.from, req.query.to);
  if (range) filter.createdAt = range;

  const [total, rows] = await Promise.all([
    WalletTransaction.countDocuments(filter),
    WalletTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("user", "name email").lean(),
  ]);

  res.json({
    success: true,
    data: {
      transactions: rows.map((t) => ({
        id: t._id,
        user: t.user ? { id: t.user._id, name: t.user.name, email: t.user.email } : null,
        type: t.type, amount: t.amount, source: t.source, description: t.description,
        balanceBefore: t.balanceBefore, balanceAfter: t.balanceAfter, referenceId: t.referenceId, createdAt: t.createdAt,
      })),
      pagination: pageMeta(page, limit, total),
    },
  });
});

// GET /api/admin/economy/summary   (Coins & Economy screen)
exports.economySummary = asyncHandler(async (_req, res) => {
  const since = new Date(Date.now() - 30 * DAY);
  const [circ, flows, rev30, revAll] = await Promise.all([
    Wallet.aggregate([{ $group: { _id: null, total: { $sum: "$balance" }, wallets: { $sum: 1 } } }]),
    WalletTransaction.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { type: "$type", source: "$source" }, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    revenueTotals({ $gte: since }),
    revenueTotals(),
  ]);

  const rows = flows.map((f) => ({ type: f._id.type, source: f._id.source, amount: f.amount, count: f.count }));
  const sum = (type) => rows.filter((r) => r.type === type).reduce((a, r) => a + r.amount, 0);

  res.json({
    success: true,
    data: {
      coinsInCirculation: circ[0] ? circ[0].total : 0,
      wallets: circ[0] ? circ[0].wallets : 0,
      last30Days: { credited: sum("credit"), debited: sum("debit"), flows: rows },
      platformRevenue: { last30Days: rev30.platformRevenue, allTime: revAll.platformRevenue },
      coinVolume: { last30Days: rev30.coinVolume, allTime: revAll.coinVolume },
    },
  });
});

// GET /api/admin/reports/daily?days=7..90
exports.dailyReport = asyncHandler(async (req, res) => {
  const days = Math.min(90, Math.max(7, parseInt(qs(req.query.days), 10) || 30));
  const rows = await dailySeries(days);
  const totals = rows.reduce(
    (a, r) => ({
      newUsers: a.newUsers + r.newUsers, games: a.games + r.games,
      coinVolume: a.coinVolume + r.coinVolume, platformRevenue: a.platformRevenue + r.platformRevenue,
    }),
    { newUsers: 0, games: 0, coinVolume: 0, platformRevenue: 0 }
  );
  res.json({ success: true, data: { days, rows, totals } });
});
