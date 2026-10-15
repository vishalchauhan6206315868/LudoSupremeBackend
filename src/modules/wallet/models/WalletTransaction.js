const mongoose = require("mongoose");

const walletTransactionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User reference is required"],
      index: true,
    },
    wallet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      required: [true, "Wallet reference is required"],
      index: true,
    },
    type: {
      type: String,
      enum: {
        values: ["credit", "debit"],
        message: "Transaction type must be either 'credit' or 'debit'",
      },
      required: [true, "Transaction type is required"],
    },
    amount: {
      type: Number,
      required: [true, "Transaction amount is required"],
      min: [0.000001, "Transaction amount must be greater than 0"],
      validate: {
        validator: function (val) {
          return Number.isFinite(val) && val > 0;
        },
        message: "Transaction amount must be a positive finite number",
      },
    },
    balanceBefore: {
      type: Number,
      required: [true, "Balance before transaction is required"],
      min: [0, "Balance before cannot be negative"],
    },
    balanceAfter: {
      type: Number,
      required: [true, "Balance after transaction is required"],
      min: [0, "Balance after cannot be negative"],
    },
    source: {
      type: String,
      enum: {
        values: [
          "game_reward",
          "game_entry",
          "bonus",
          "admin",
          "refund",
          "other",
        ],
        message: "Invalid transaction source",
      },
      default: "other",
      required: [true, "Transaction source is required"],
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    referenceId: {
      type: String,
      default: null,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound and standalone indexes for transaction history and audit queries
walletTransactionSchema.index({ user: 1, createdAt: -1 });
walletTransactionSchema.index({ createdAt: -1 });

// Idempotency guard: the same (user, source, type, referenceId) can only be applied ONCE.
// This is what stops a retried request / crashed-and-recovered job from paying twice.
// Transactions without a referenceId are not affected.
walletTransactionSchema.index(
  { user: 1, source: 1, type: 1, referenceId: 1 },
  { unique: true, partialFilterExpression: { referenceId: { $type: "string" } } }
);

module.exports = mongoose.model("WalletTransaction", walletTransactionSchema);
