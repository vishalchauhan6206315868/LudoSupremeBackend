"use strict";

const mongoose = require("mongoose");

const paymentOrderSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User reference is required"],
      index: true,
    },
    orderId: {
      type: String,
      required: [true, "Internal order ID is required"],
      unique: true,
      trim: true,
      index: true,
    },
    razorpayOrderId: {
      type: String,
      required: [true, "Razorpay order ID is required"],
      unique: true,
      trim: true,
      index: true,
    },
    razorpayPaymentId: {
      type: String,
      default: null,
      trim: true,
      sparse: true,
      index: true,
    },
    razorpaySignature: {
      type: String,
      default: null,
      trim: true,
    },
    amount: {
      type: Number,
      required: [true, "Deposit amount is required"],
      min: [1, "Amount must be at least 1"],
      validate: {
        validator: function (val) {
          return Number.isFinite(val) && val > 0;
        },
        message: "Amount must be a positive finite number",
      },
    },
    currency: {
      type: String,
      default: "INR",
      uppercase: true,
    },
    status: {
      type: String,
      enum: {
        values: ["pending", "success", "failed", "cancelled"],
        message: "Status must be pending, success, failed, or cancelled",
      },
      default: "pending",
      index: true,
    },
    paymentMethod: {
      type: String,
      default: null,
    },
    errorDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

paymentOrderSchema.index({ user: 1, createdAt: -1 });
paymentOrderSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("PaymentOrder", paymentOrderSchema);
