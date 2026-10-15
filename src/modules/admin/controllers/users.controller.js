"use strict";

const crypto = require("crypto");
const AppError = require("../../../../utils/AppError");
const asyncHandler = require("../../../../utils/asyncHandler");
const { qs, parsePagination, pageMeta, escapeRegex } = require("../../../../utils/adminHelpers");
const User = require("../../auth/models/User");
const Wallet = require("../../wallet/models/Wallet");
const WalletTransaction = require("../../wallet/models/WalletTransaction");
const GameSession = require("../../games/models/GameSession");
const walletService = require("../../wallet/services/wallet.service");
const audit = require("../services/audit.service");
const { clearDashboardCache } = require("../services/stats.service");

const USER_FIELDS = "name email username avatar role isActive isVerified lastLogin createdAt level experience gems statistics";
const SORTS = { newest: { createdAt: -1 }, oldest: { createdAt: 1 }, name: { name: 1 } };

const shape = (u, balance) => ({
  id: u._id,
  name: u.name,
  email: u.email,
  username: u.username || null,
  avatar: u.avatar || "",
  role: u.role,
  status: u.isActive === false ? "Blocked" : "Active",
  isActive: u.isActive !== false,
  isVerified: Boolean(u.isVerified),
  level: u.level,
  statistics: u.statistics,
  coins: balance ?? 0,
  lastLogin: u.lastLogin || null,
  joinedOn: u.createdAt,
});

// GET /api/admin/users?page&limit&search&status=active|blocked&sort=newest|oldest|name
exports.listUsers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};

  const search = qs(req.query.search).trim().slice(0, 50);
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: rx }, { email: rx }, { username: rx }];
  }
  const status = qs(req.query.status);
  if (status === "active") filter.isActive = { $ne: false };
  else if (status === "blocked") filter.isActive = false;

  const sort = SORTS[qs(req.query.sort)] || SORTS.newest;

  const [total, users] = await Promise.all([
    User.countDocuments(filter).maxTimeMS(8000),
    User.find(filter).sort(sort).skip(skip).limit(limit).select(USER_FIELDS).maxTimeMS(8000).lean(),
  ]);
  const wallets = await Wallet.find({ user: { $in: users.map((u) => u._id) } }).select("user balance").lean();
  const balances = new Map(wallets.map((w) => [String(w.user), w.balance]));

  res.json({
    success: true,
    data: { users: users.map((u) => shape(u, balances.get(String(u._id)))), pagination: pageMeta(page, limit, total) },
  });
});

// GET /api/admin/users/:id
exports.getUser = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const user = await User.findById(id).select(USER_FIELDS).lean();
  if (!user) throw new AppError("User not found", 404);

  const [wallet, txs, games] = await Promise.all([
    Wallet.findOne({ user: id }).select("balance").lean(),
    WalletTransaction.find({ user: id }).sort({ createdAt: -1 }).limit(10)
      .select("type amount source description balanceAfter createdAt").lean(),
    GameSession.find({ "players.user": id }).sort({ createdAt: -1 }).limit(10)
      .select("roomCode gameMode status entryFee prizePool createdAt endedAt players.user players.outcome players.prizeEarned").lean(),
  ]);

  res.json({
    success: true,
    data: {
      user: shape(user, wallet ? wallet.balance : 0),
      recentTransactions: txs,
      recentGames: games.map((g) => {
        const me = g.players.find((p) => String(p.user) === id) || {};
        return {
          id: g._id, roomCode: g.roomCode, mode: g.gameMode, status: g.status, entryFee: g.entryFee,
          prizePool: g.prizePool, outcome: me.outcome || null, prizeEarned: me.prizeEarned || 0,
          createdAt: g.createdAt, endedAt: g.endedAt,
        };
      }),
    },
  });
});

// PATCH /api/admin/users/:id/status   { isActive: bool, reason }
// Blocking takes effect on the player's very next request (auth.middleware rejects inactive users).
exports.setUserStatus = asyncHandler(async (req, res) => {
  const { isActive } = req.body;
  const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";

  const user = await User.findById(req.params.id).select(USER_FIELDS);
  if (!user) throw new AppError("User not found", 404);

  if ((user.isActive !== false) === isActive) {
    return res.json({ success: true, changed: false, data: { user: shape(user.toObject()) } });
  }

  // updateOne (not save): the password field is not loaded here and must not be re-validated.
  await User.updateOne({ _id: user._id }, { $set: { isActive } });
  user.isActive = isActive;
  clearDashboardCache();
  await audit.record(req, isActive ? "user.unblock" : "user.block", {
    targetType: "user", targetId: user._id, meta: { reason, email: user.email },
  });
  res.json({ success: true, changed: true, data: { user: shape(user.toObject()) } });
});

// POST /api/admin/users/:id/coins   { type: credit|debit, amount, reason, idempotencyKey? }   (superadmin)
// Goes through the same ledger as the game (atomic, never below zero). Send an idempotencyKey so a
// retried request (bad network, double click) is applied only once.
exports.adjustCoins = asyncHandler(async (req, res) => {
  const { type, amount, reason } = req.body;
  const user = await User.findById(req.params.id).select("_id email isActive").lean();
  if (!user) throw new AppError("User not found", 404);

  const key = req.body.idempotencyKey || crypto.randomUUID();
  const referenceId = `admin:${req.admin._id}:${key}`;
  const op = type === "credit" ? walletService.creditWallet : walletService.debitWallet;
  const result = await op(user._id, amount, "admin", `Admin ${type}: ${reason}`, referenceId);

  if (!result.duplicate) {
    clearDashboardCache();
    await audit.record(req, `wallet.${type}`, {
      targetType: "user", targetId: user._id,
      meta: { amount, reason, balanceAfter: result.wallet.balance, transactionId: String(result.transaction._id) },
    });
  }

  res.status(result.duplicate ? 200 : 201).json({
    success: true,
    duplicate: result.duplicate,
    data: {
      balance: result.wallet.balance,
      transaction: {
        id: result.transaction._id, type: result.transaction.type, amount: result.transaction.amount,
        source: result.transaction.source, balanceAfter: result.transaction.balanceAfter, createdAt: result.transaction.createdAt,
      },
    },
  });
});
