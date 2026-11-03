"use strict";

const mongoose = require("mongoose");

const withdrawalRequestSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User reference is required"],
      index: true,
    },
    requestNo: {
      type: String,
      required: [true, "Request number is required"],
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    amount: {
      type: Number,
      required: [true, "Withdrawal amount is required"],
      min: [1, "Withdrawal amount must be at least 1"],
      validate: {
        validator: function (val) {
          return Number.isFinite(val) && val > 0;
        },
        message: "Amount must be a positive finite number",
      },
    },
    payoutMode: {
      type: String,
      enum: {
        values: ["upi", "bank_transfer"],
        message: "Payout mode must be either 'upi' or 'bank_transfer'",
      },
      required: [true, "Payout mode is required"],
    },
    payoutDetails: {
      upiId: {
        type: String,
        trim: true,
        default: null,
      },
      accountNumber: {
        type: String,
        trim: true,
        default: null,
      },
      ifscCode: {
        type: String,
        trim: true,
        uppercase: true,
        default: null,
      },
      accountHolderName: {
        type: String,
        trim: true,
        default: null,
      },
      bankName: {
        type: String,
        trim: true,
        default: null,
      },
    },
    status: {
      type: String,
      enum: {
        values: ["pending", "approved", "rejected"],
        message: "Status must be pending, approved, or rejected",
      },
      default: "pending",
      index: true,
    },
    adminNote: {
      type: String,
      trim: true,
      default: "",
      maxlength: 500,
    },
    rejectionReason: {
      type: String,
      trim: true,
      default: "",
      maxlength: 500,
    },
    transactionRef: {
      type: String,
      trim: true,
      default: null,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

withdrawalRequestSchema.index({ user: 1, createdAt: -1 });
withdrawalRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("WithdrawalRequest", withdrawalRequestSchema);
