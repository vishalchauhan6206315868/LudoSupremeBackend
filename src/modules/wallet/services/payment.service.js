"use strict";

const crypto = require("crypto");
const Razorpay = require("razorpay");
const config = require("../../../../config/env");
const AppError = require("../../../../utils/AppError");
const logger = require("../../../../utils/logger");
const PaymentOrder = require("../models/PaymentOrder");
const WithdrawalRequest = require("../models/WithdrawalRequest");
const walletService = require("./wallet.service");
const { escapeRegex } = require("../../../../utils/adminHelpers");

/**
 * Constant-time signature comparison to prevent timing attacks.
 * Validates that both inputs are strings, non-empty, and identical in byte length before comparing.
 */
const safeCompareSignatures = (expected, provided) => {
  if (typeof expected !== "string" || typeof provided !== "string") {
    return false;
  }
  const cleanExpected = expected.trim().toLowerCase();
  const cleanProvided = provided.trim().toLowerCase();
  if (!cleanExpected || !cleanProvided) {
    return false;
  }
  const expectedBuf = Buffer.from(cleanExpected, "utf8");
  const providedBuf = Buffer.from(cleanProvided, "utf8");
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
};

let razorpayClient = null;

const getRazorpayInstance = () => {
  if (razorpayClient) return razorpayClient;

  if (!config.razorpay.keyId || !config.razorpay.keySecret) {
    throw new AppError(
      "Payment gateway is not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env",
      503
    );
  }

  razorpayClient = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });

  return razorpayClient;
};

// ==========================================
// 1. DEPOSIT - CREATE RAZORPAY ORDER
// ==========================================
const createDepositOrder = async (userId, amount) => {
  const numericAmount = Number(amount);
  if (!Number.isSafeInteger(numericAmount) || numericAmount <= 0) {
    throw new AppError("Deposit amount must be a positive whole number", 400);
  }

  if (numericAmount < config.payment.minDeposit) {
    throw new AppError(`Minimum deposit amount is ₹${config.payment.minDeposit}`, 400);
  }
  if (numericAmount > config.payment.maxDeposit) {
    throw new AppError(`Maximum deposit amount is ₹${config.payment.maxDeposit}`, 400);
  }

  const rzp = getRazorpayInstance();
  const internalOrderId = `ORD_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;

  // Razorpay expects amount in paise (1 INR = 100 paise)
  const options = {
    amount: numericAmount * 100,
    currency: "INR",
    receipt: internalOrderId,
    notes: {
      userId: String(userId),
      orderId: internalOrderId,
    },
  };

  let rzpOrder;
  try {
    rzpOrder = await rzp.orders.create(options);
  } catch (err) {
    logger.error("razorpay_order_create_failed", { userId: String(userId), error: err.message });
    throw new AppError(`Failed to initiate payment: ${err.message || "Gateway error"}`, 502);
  }

  const paymentOrder = await PaymentOrder.create({
    user: userId,
    orderId: internalOrderId,
    razorpayOrderId: rzpOrder.id,
    amount: numericAmount,
    currency: "INR",
    status: "pending",
    metadata: {
      receipt: internalOrderId,
      notes: options.notes,
    },
  });

  return {
    orderId: internalOrderId,
    razorpayOrderId: rzpOrder.id,
    amount: numericAmount,
    currency: "INR",
    keyId: config.razorpay.keyId,
    paymentOrder,
  };
};

// ==========================================
// 2. DEPOSIT - VERIFY PAYMENT SIGNATURE
// ==========================================
const verifyDepositPayment = async (userId, { razorpayOrderId, razorpayPaymentId, razorpaySignature }) => {
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw new AppError("Missing payment verification details", 400);
  }

  const order = await PaymentOrder.findOne({ razorpayOrderId, user: userId });
  if (!order) {
    throw new AppError("Payment order not found", 404);
  }

  // Idempotency: if already processed, return current wallet state
  if (order.status === "success") {
    const balance = await walletService.getBalance(userId);
    return {
      success: true,
      message: "Payment already verified",
      balance,
      order,
    };
  }

  // HMAC SHA256 signature verification with timing-safe comparison
  const generatedSignature = crypto
    .createHmac("sha256", config.razorpay.keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");

  if (!safeCompareSignatures(generatedSignature, razorpaySignature)) {
    order.status = "failed";
    order.errorDetails = { reason: "Signature mismatch" };
    await order.save();
    throw new AppError("Payment verification failed: Invalid signature", 400);
  }

  // Deterministic idempotency reference ID for deposit order
  const depositRefId = `deposit:${order.razorpayOrderId}`;

  // Atomic state transition: pending -> success
  const updatedOrder = await PaymentOrder.findOneAndUpdate(
    { _id: order._id, status: { $ne: "success" } },
    {
      $set: {
        status: "success",
        razorpayPaymentId,
        razorpaySignature,
      },
    },
    { returnDocument: "after" }
  );

  if (!updatedOrder) {
    // Another concurrent worker (e.g. webhook) marked it success
    const balance = await walletService.getBalance(userId);
    const latestOrder = await PaymentOrder.findById(order._id);
    return {
      success: true,
      message: "Payment already verified",
      balance,
      order: latestOrder || order,
    };
  }

  // Credit user's wallet with deterministic idempotency reference
  const creditResult = await walletService.creditWallet(
    userId,
    updatedOrder.amount,
    "deposit",
    `Deposit via Razorpay (${razorpayPaymentId})`,
    depositRefId
  );

  logger.info("deposit_successful", {
    userId: String(userId),
    amount: updatedOrder.amount,
    orderId: updatedOrder.orderId,
    razorpayPaymentId,
  });

  return {
    success: true,
    message: "Deposit successful",
    balance: creditResult.wallet.balance,
    order: updatedOrder,
  };
};

// ==========================================
// 3. DEPOSIT - RAZORPAY WEBHOOK HANDLER
// ==========================================
const handleWebhook = async (rawBody, signature) => {
  if (!config.razorpay.webhookSecret) {
    throw new AppError("Razorpay webhook secret is not configured", 503);
  }

  if (!rawBody || !signature) {
    throw new AppError("Missing webhook payload or signature", 400);
  }

  const expectedSignature = crypto
    .createHmac("sha256", config.razorpay.webhookSecret)
    .update(rawBody)
    .digest("hex");

  if (!safeCompareSignatures(expectedSignature, signature)) {
    logger.warn("razorpay_webhook_signature_invalid");
    throw new AppError("Invalid webhook signature", 400);
  }

  const event = JSON.parse(rawBody.toString("utf8"));
  const eventType = event.event;

  logger.info("razorpay_webhook_event_received", { eventType });

  if (eventType === "order.paid" || eventType === "payment.captured") {
    const paymentEntity = event.payload?.payment?.entity;
    const orderEntity = event.payload?.order?.entity;

    const rzpOrderId = orderEntity?.id || paymentEntity?.order_id;
    const rzpPaymentId = paymentEntity?.id;

    if (!rzpOrderId) {
      return { handled: false, reason: "No order ID in event payload" };
    }

    const order = await PaymentOrder.findOne({ razorpayOrderId: rzpOrderId });
    if (!order) {
      logger.warn("webhook_order_not_found", { rzpOrderId });
      return { handled: false, reason: "Order not found" };
    }

    if (order.status === "success") {
      return { handled: true, status: "success", duplicate: true };
    }

    const depositRefId = `deposit:${order.razorpayOrderId}`;

    const updatedOrder = await PaymentOrder.findOneAndUpdate(
      { _id: order._id, status: { $ne: "success" } },
      {
        $set: {
          status: "success",
          razorpayPaymentId: rzpPaymentId || order.razorpayPaymentId,
          paymentMethod: paymentEntity?.method || order.paymentMethod,
        },
      },
      { returnDocument: "after" }
    );

    if (!updatedOrder) {
      // Concurrently transitioned by verify API or duplicate webhook
      return { handled: true, status: "success", duplicate: true };
    }

    // Credit wallet idempotently using deterministic referenceId
    await walletService.creditWallet(
      updatedOrder.user,
      updatedOrder.amount,
      "deposit",
      `Deposit via Razorpay Webhook (${rzpPaymentId || updatedOrder.razorpayOrderId})`,
      depositRefId
    );

    logger.info("webhook_deposit_credited", {
      userId: String(updatedOrder.user),
      amount: updatedOrder.amount,
      orderId: updatedOrder.orderId,
    });

    return { handled: true, status: "success" };
  }

  if (eventType === "payment.failed") {
    const paymentEntity = event.payload?.payment?.entity;
    const rzpOrderId = paymentEntity?.order_id;

    if (rzpOrderId) {
      const order = await PaymentOrder.findOne({ razorpayOrderId: rzpOrderId });
      if (order && order.status === "pending") {
        order.status = "failed";
        order.errorDetails = paymentEntity?.error_description || "Payment failed at gateway";
        await order.save();
      }
    }

    return { handled: true, status: "failed" };
  }

  return { handled: true, status: "ignored" };
};

// ==========================================
// 4. WITHDRAWAL - USER REQUEST
// ==========================================
const requestWithdrawal = async (userId, { amount, payoutMode, payoutDetails }) => {
  const numericAmount = Number(amount);
  if (!Number.isSafeInteger(numericAmount) || numericAmount <= 0) {
    throw new AppError("Withdrawal amount must be a positive whole number", 400);
  }

  if (numericAmount < config.payment.minWithdrawal) {
    throw new AppError(`Minimum withdrawal amount is ₹${config.payment.minWithdrawal}`, 400);
  }
  if (numericAmount > config.payment.maxWithdrawal) {
    throw new AppError(`Maximum withdrawal amount is ₹${config.payment.maxWithdrawal}`, 400);
  }

  if (!["upi", "bank_transfer"].includes(payoutMode)) {
    throw new AppError("Invalid payout mode. Must be 'upi' or 'bank_transfer'", 400);
  }

  if (payoutMode === "upi") {
    if (!payoutDetails?.upiId || !payoutDetails.upiId.includes("@")) {
      throw new AppError("Valid UPI ID is required for UPI payout", 400);
    }
  } else if (payoutMode === "bank_transfer") {
    if (!payoutDetails?.accountNumber || !payoutDetails?.ifscCode || !payoutDetails?.accountHolderName) {
      throw new AppError("Account number, IFSC code, and Account holder name are required for Bank Transfer", 400);
    }
  }

  // Prevent multiple pending withdrawal requests from spamming
  const pendingCount = await WithdrawalRequest.countDocuments({
    user: userId,
    status: "pending",
  });
  if (pendingCount >= 2) {
    throw new AppError("You already have pending withdrawal requests. Please wait for them to be processed.", 400);
  }

  const requestNo = `WTH-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

  // Immediately debit wallet atomically. Throws AppError(400, "Insufficient wallet balance") if short on funds.
  const debitResult = await walletService.debitWallet(
    userId,
    numericAmount,
    "withdrawal",
    `Withdrawal request: ${requestNo}`,
    `wth_debit:${requestNo}`
  );

  let withdrawal;
  try {
    withdrawal = await WithdrawalRequest.create({
      user: userId,
      requestNo,
      amount: numericAmount,
      payoutMode,
      payoutDetails: {
        upiId: payoutDetails.upiId ? payoutDetails.upiId.trim() : null,
        accountNumber: payoutDetails.accountNumber ? payoutDetails.accountNumber.trim() : null,
        ifscCode: payoutDetails.ifscCode ? payoutDetails.ifscCode.trim().toUpperCase() : null,
        accountHolderName: payoutDetails.accountHolderName ? payoutDetails.accountHolderName.trim() : null,
        bankName: payoutDetails.bankName ? payoutDetails.bankName.trim() : null,
      },
      status: "pending",
    });
  } catch (creationError) {
    logger.error("withdrawal_creation_failed_refunding", {
      userId: String(userId),
      amount: numericAmount,
      requestNo,
      error: creationError.message,
    });

    // Compensation: automatically refund the debited coins idempotently
    await walletService
      .creditWallet(
        userId,
        numericAmount,
        "refund",
        `Compensation refund for failed withdrawal: ${requestNo}`,
        `wth_fail_refund:${requestNo}`
      )
      .catch((refundErr) => {
        logger.error("withdrawal_compensation_refund_failed", {
          userId: String(userId),
          requestNo,
          err: refundErr.message,
        });
      });

    throw creationError;
  }

  logger.info("withdrawal_requested", {
    userId: String(userId),
    amount: numericAmount,
    requestNo,
  });

  return {
    withdrawal,
    remainingBalance: debitResult.wallet.balance,
  };
};

// ==========================================
// 5. USER HISTORY
// ==========================================
const getUserDeposits = async (userId, page = 1, limit = 20) => {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (p - 1) * l;
  const filter = { user: userId };

  const [total, deposits] = await Promise.all([
    PaymentOrder.countDocuments(filter),
    PaymentOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(l).lean(),
  ]);

  return {
    deposits,
    pagination: {
      page: p,
      limit: l,
      total,
      totalPages: Math.ceil(total / l) || 1,
    },
  };
};

const getUserWithdrawals = async (userId, page = 1, limit = 20) => {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (p - 1) * l;
  const filter = { user: userId };

  const [total, withdrawals] = await Promise.all([
    WithdrawalRequest.countDocuments(filter),
    WithdrawalRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(l).lean(),
  ]);

  return {
    withdrawals,
    pagination: {
      page: p,
      limit: l,
      total,
      totalPages: Math.ceil(total / l) || 1,
    },
  };
};

// ==========================================
// 6. ADMIN - WITHDRAWAL MANAGEMENT
// ==========================================
const listAdminWithdrawals = async ({ status, page = 1, limit = 20, search }) => {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (p - 1) * l;

  const filter = {};
  if (status && ["pending", "approved", "rejected"].includes(status)) {
    filter.status = status;
  }
  const trimmedSearch = typeof search === "string" ? search.trim() : "";
  if (trimmedSearch) {
    const escaped = escapeRegex(trimmedSearch);
    const regex = new RegExp(escaped, "i");
    filter.$or = [
      { requestNo: regex },
      { "payoutDetails.upiId": regex },
      { "payoutDetails.accountNumber": regex },
    ];
  }

  const [total, withdrawals] = await Promise.all([
    WithdrawalRequest.countDocuments(filter),
    WithdrawalRequest.find(filter)
      .populate("user", "name email phone username")
      .populate("reviewedBy", "name email role")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(l)
      .lean(),
  ]);

  return {
    withdrawals,
    pagination: {
      page: p,
      limit: l,
      total,
      totalPages: Math.ceil(total / l) || 1,
    },
  };
};

const approveWithdrawal = async (requestId, adminId, { transactionRef, adminNote }) => {
  const cleanRef = transactionRef ? String(transactionRef).trim() : null;
  if (!cleanRef) {
    throw new AppError("Payout transaction reference (UTR) is required to approve withdrawal", 400);
  }

  // Atomic conditional transition: only matches if status is currently "pending"
  const request = await WithdrawalRequest.findOneAndUpdate(
    { _id: requestId, status: "pending" },
    {
      $set: {
        status: "approved",
        transactionRef: cleanRef,
        adminNote: adminNote ? String(adminNote).trim() : "",
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    },
    { returnDocument: "after", runValidators: true }
  );

  if (!request) {
    const existing = await WithdrawalRequest.findById(requestId);
    if (!existing) {
      throw new AppError("Withdrawal request not found", 404);
    }
    throw new AppError(`Cannot approve request with status '${existing.status}'`, 400);
  }

  logger.info("withdrawal_approved", {
    requestId: String(request._id),
    requestNo: request.requestNo,
    adminId: String(adminId),
    transactionRef: request.transactionRef,
  });

  return request;
};

const rejectWithdrawal = async (requestId, adminId, { rejectionReason, adminNote }) => {
  const existing = await WithdrawalRequest.findById(requestId);
  if (!existing) {
    throw new AppError("Withdrawal request not found", 404);
  }

  if (existing.status !== "pending") {
    throw new AppError(`Cannot reject request with status '${existing.status}'`, 400);
  }

  // Atomic conditional transition: only matches if status is currently "pending"
  const request = await WithdrawalRequest.findOneAndUpdate(
    { _id: requestId, status: "pending" },
    {
      $set: {
        status: "rejected",
        rejectionReason: rejectionReason ? String(rejectionReason).trim() : "Rejected by admin",
        adminNote: adminNote ? String(adminNote).trim() : "",
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    },
    { returnDocument: "after", runValidators: true }
  );

  if (!request) {
    const current = await WithdrawalRequest.findById(requestId);
    throw new AppError(`Cannot reject request with status '${current ? current.status : "unknown"}'`, 400);
  }

  // Refund user's debited coins back to wallet atomically with unique idempotency reference
  try {
    await walletService.creditWallet(
      request.user,
      request.amount,
      "refund",
      `Refund for rejected withdrawal: ${request.requestNo}`,
      `wth_refund:${request.requestNo}`
    );
  } catch (refundError) {
    logger.error("withdrawal_refund_failed_reverting_status", {
      requestId: String(request._id),
      requestNo: request.requestNo,
      error: refundError.message,
    });
    // Revert status to pending so it is not permanently rejected without refund
    await WithdrawalRequest.updateOne(
      { _id: request._id, status: "rejected" },
      {
        $set: {
          status: "pending",
          reviewedBy: null,
          reviewedAt: null,
          rejectionReason: "",
        },
      }
    ).catch((revertErr) => {
      logger.error("withdrawal_revert_status_failed", {
        requestId: String(request._id),
        error: revertErr.message,
      });
    });
    throw new AppError(`Failed to process refund: ${refundError.message}`, 500);
  }

  logger.info("withdrawal_rejected_and_refunded", {
    requestId: String(request._id),
    requestNo: request.requestNo,
    adminId: String(adminId),
    amount: request.amount,
  });

  return request;
};

// ==========================================
// 7. ADMIN - DEPOSITS MANAGEMENT
// ==========================================
const listAdminDeposits = async ({ status, page = 1, limit = 20, search }) => {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (p - 1) * l;

  const filter = {};
  if (status && ["pending", "success", "failed", "cancelled"].includes(status)) {
    filter.status = status;
  }
  const trimmedSearch = typeof search === "string" ? search.trim() : "";
  if (trimmedSearch) {
    const escaped = escapeRegex(trimmedSearch);
    const regex = new RegExp(escaped, "i");
    filter.$or = [
      { orderId: regex },
      { razorpayOrderId: regex },
      { razorpayPaymentId: regex },
    ];
  }

  const [total, deposits] = await Promise.all([
    PaymentOrder.countDocuments(filter),
    PaymentOrder.find(filter)
      .populate("user", "name email phone username")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(l)
      .lean(),
  ]);

  return {
    deposits,
    pagination: {
      page: p,
      limit: l,
      total,
      totalPages: Math.ceil(total / l) || 1,
    },
  };
};

module.exports = {
  createDepositOrder,
  verifyDepositPayment,
  handleWebhook,
  requestWithdrawal,
  getUserDeposits,
  getUserWithdrawals,
  listAdminWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  listAdminDeposits,
};
