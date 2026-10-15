"use strict";

const mongoose = require("mongoose");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const AppError = require("../../../../utils/AppError");
const logger = require("../../../../utils/logger");

/**
 * THE ledger. Every coin that moves (entry fees, prizes, rewards, refunds, bonuses) goes
 * through creditWallet / debitWallet so that:
 *   - balance changes are atomic ($inc with a balance >= amount guard for debits)
 *   - the balance change and its transaction record commit together (replica set transactions)
 *   - passing a `referenceId` makes the call idempotent (safe to retry)
 */

const isTransactionNotSupportedError = (error) => {
  if (!error) return false;
  const msg = error.message || "";
  return (
    error.code === 20 ||
    msg.includes("Transaction numbers are only allowed on a replica set member") ||
    msg.includes("Transactions are not supported") ||
    msg.includes("replica set")
  );
};

const assertValidAmount = (amount, label) => {
  const n = Number(amount);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new AppError(`${label} amount must be a positive whole number`, 400);
  }
  return n;
};

/**
 * Get existing wallet or create one (race-safe through the unique index on `user`).
 */
const getOrCreateWallet = async (userId, session = null) => {
  const find = () => {
    const q = Wallet.findOne({ user: userId });
    return session ? q.session(session) : q;
  };

  let wallet = await find();
  if (wallet) return wallet;

  try {
    const [created] = await Wallet.create(
      [{ user: userId, balance: 0 }],
      session ? { session } : {}
    );
    return created;
  } catch (error) {
    if (error.code === 11000) return find(); // created concurrently by another request
    throw error;
  }
};

const findExistingTransaction = (userId, type, source, referenceId, session) => {
  const q = WalletTransaction.findOne({ user: userId, type, source, referenceId });
  return session ? q.session(session) : q;
};

/**
 * Core mutation. `session` is null when running without a transaction.
 */
const applyChange = async (params, session) => {
  const { userId, amount, type, source, description, referenceId } = params;
  const opts = session ? { session } : {};

  const wallet = await getOrCreateWallet(userId, session);

  // Idempotency: this exact operation was already applied -> return it, change nothing.
  if (referenceId) {
    const existing = await findExistingTransaction(userId, type, source, referenceId, session);
    if (existing) {
      const current = await Wallet.findById(wallet._id).session(session);
      return { wallet: current, transaction: existing, duplicate: true };
    }
  }

  const filter = { _id: wallet._id };
  if (type === "debit") filter.balance = { $gte: amount };

  const updatedWallet = await Wallet.findOneAndUpdate(
    filter,
    { $inc: { balance: type === "credit" ? amount : -amount } },
    { returnDocument: "after", runValidators: true, ...opts }
  );

  if (!updatedWallet) {
    throw new AppError("Insufficient wallet balance", 400);
  }

  const balanceAfter = updatedWallet.balance;
  const balanceBefore = type === "credit" ? balanceAfter - amount : balanceAfter + amount;

  try {
    const [transaction] = await WalletTransaction.create(
      [
        {
          user: userId,
          wallet: updatedWallet._id,
          type,
          amount,
          balanceBefore,
          balanceAfter,
          source,
          description,
          referenceId,
        },
      ],
      opts
    );
    return { wallet: updatedWallet, transaction, duplicate: false };
  } catch (error) {
    if (!session) {
      // No transaction to roll back: undo the balance change by hand so the ledger stays true.
      await Wallet.updateOne(
        { _id: wallet._id },
        { $inc: { balance: type === "credit" ? -amount : amount } }
      ).catch((undoError) =>
        logger.error("wallet_compensation_failed", { userId: String(userId), amount, type, err: undoError })
      );
    }
    throw error;
  }
};

const execute = async (type, userId, amount, source, description, referenceId) => {
  const params = {
    userId,
    amount: assertValidAmount(amount, type === "credit" ? "Credit" : "Debit"),
    type,
    source: source || "other",
    description: description || "",
    referenceId: referenceId ? String(referenceId) : null,
  };

  // Make sure the wallet document exists BEFORE opening a transaction
  // (creating it inside one turns a harmless duplicate-key race into an aborted transaction).
  await getOrCreateWallet(userId);

  const session = await mongoose.startSession();
  try {
    let result;
    // withTransaction retries automatically on transient errors (write conflicts, etc.)
    await session.withTransaction(async () => {
      result = await applyChange(params, session);
    });
    return result;
  } catch (error) {
    if (isTransactionNotSupportedError(error)) {
      // Standalone MongoDB (development). Still atomic per document.
      return applyChange(params, null).catch(async (innerError) => {
        if (innerError.code === 11000 && params.referenceId) {
          return duplicateResult(params);
        }
        throw innerError;
      });
    }
    if (error.code === 11000 && params.referenceId) {
      return duplicateResult(params);
    }
    throw error;
  } finally {
    session.endSession();
  }
};

const duplicateResult = async (params) => {
  const existing = await findExistingTransaction(
    params.userId,
    params.type,
    params.source,
    params.referenceId,
    null
  );
  const wallet = await getOrCreateWallet(params.userId);
  return { wallet, transaction: existing, duplicate: true };
};

/**
 * Add coins. Pass a stable `referenceId` (e.g. `prize:<sessionId>:<userId>`) whenever the
 * operation could be retried - the second call becomes a harmless no-op.
 * @returns {Promise<{wallet, transaction, duplicate: boolean}>}
 */
const creditWallet = (userId, amount, source = "other", description = "", referenceId = null) =>
  execute("credit", userId, amount, source, description, referenceId);

/**
 * Remove coins. Throws AppError(400, "Insufficient wallet balance") when funds are short.
 * The balance check happens inside the database update, so concurrent debits can never
 * push a wallet below zero.
 */
const debitWallet = (userId, amount, source = "other", description = "", referenceId = null) =>
  execute("debit", userId, amount, source, description, referenceId);

const getBalance = async (userId) => {
  const wallet = await getOrCreateWallet(userId);
  return wallet.balance;
};

/**
 * Fetch wallet transactions for user with pagination
 */
const getWalletTransactions = async (userId, page = 1, limit = 20) => {
  const wallet = await getOrCreateWallet(userId);

  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (parsedPage - 1) * parsedLimit;
  const filter = { user: userId };

  const [total, transactions] = await Promise.all([
    WalletTransaction.countDocuments(filter),
    WalletTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parsedLimit).lean(),
  ]);

  return {
    wallet: { balance: wallet.balance },
    transactions: transactions.map((tx) => ({
      _id: tx._id,
      type: tx.type,
      amount: tx.amount,
      source: tx.source,
      description: tx.description,
      balanceBefore: tx.balanceBefore,
      balanceAfter: tx.balanceAfter,
      referenceId: tx.referenceId,
      createdAt: tx.createdAt,
    })),
    pagination: {
      page: parsedPage,
      limit: parsedLimit,
      total,
      totalPages: Math.ceil(total / parsedLimit) || 1,
    },
  };
};

module.exports = {
  getOrCreateWallet,
  getBalance,
  creditWallet,
  debitWallet,
  getWalletTransactions,
};
