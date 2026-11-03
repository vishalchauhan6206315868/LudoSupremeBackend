"use strict";

const walletService = require("../services/wallet.service");
const paymentService = require("../services/payment.service");

// ==========================================
// 1. GET LOGGED-IN USER WALLET
// GET /api/wallet
// ==========================================
exports.getWallet = async (req, res) => {
  try {
    const userId = req.user._id;
    const wallet = await walletService.getOrCreateWallet(userId);

    return res.status(200).json({
      success: true,
      message: "Wallet fetched successfully",
      data: {
        wallet: {
          _id: wallet._id,
          user: wallet.user,
          balance: wallet.balance,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        },
      },
    });
  } catch (error) {
    console.error("Get Wallet Error:", error);
    return res.status(error.statusCode || error.status || 500).json({
      success: false,
      message: error.statusCode || error.status ? error.message : "Internal Server Error",
    });
  }
};

// ==========================================
// 2. GET CURRENT USER WALLET BALANCE
// GET /api/wallet/me
// ==========================================
exports.getMyBalance = async (req, res) => {
  try {
    const userId = req.user._id;
    const balance = await walletService.getBalance(userId);

    return res.status(200).json({
      success: true,
      message: "Wallet balance fetched successfully",
      data: {
        balance,
      },
    });
  } catch (error) {
    console.error("Get Wallet Balance Error:", error);
    return res.status(error.statusCode || error.status || 500).json({
      success: false,
      message: error.statusCode || error.status ? error.message : "Internal Server Error",
    });
  }
};

// ==========================================
// 3. GET WALLET TRANSACTION HISTORY
// GET /api/wallet/transactions
// ==========================================
exports.getTransactions = async (req, res) => {
  try {
    const userId = req.user._id;
    const { page, limit } = req.query;

    const result = await walletService.getWalletTransactions(
      userId,
      page,
      limit
    );

    return res.status(200).json({
      success: true,
      message: "Wallet transactions fetched successfully",
      data: {
        wallet: {
          balance: result.wallet.balance,
        },
        transactions: result.transactions,
        pagination: result.pagination,
      },
    });
  } catch (error) {
    console.error("Get Transactions Error:", error);
    return res.status(error.statusCode || error.status || 500).json({
      success: false,
      message: error.statusCode || error.status ? error.message : "Internal Server Error",
    });
  }
};

// ==========================================
// 4. CREATE DEPOSIT ORDER (RAZORPAY)
// POST /api/wallet/deposit/create-order
// ==========================================
exports.createDepositOrder = async (req, res) => {
  try {
    const userId = req.user._id;
    const { amount } = req.body;

    const result = await paymentService.createDepositOrder(userId, amount);

    return res.status(201).json({
      success: true,
      message: "Deposit order created successfully",
      data: result,
    });
  } catch (error) {
    console.error("Create Deposit Order Error:", error);
    return res.status(error.statusCode || error.status || 500).json({
      success: false,
      message: error.statusCode || error.status ? error.message : "Internal Server Error",
    });
  }
};

// ==========================================
// 5. VERIFY DEPOSIT PAYMENT
// POST /api/wallet/deposit/verify
// ==========================================
exports.verifyDepositPayment = async (req, res) => {
  try {
    const userId = req.user._id;
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

    const result = await paymentService.verifyDepositPayment(userId, {
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    return res.status(200).json({
      success: true,
      message: result.message,
      data: {
        balance: result.balance,
        order: result.order,
      },
    });
  } catch (error) {
    console.error("Verify Deposit Payment Error:", error);
    return res.status(error.statusCode || error.status || 500).json({
      success: false,
      message: error.statusCode || error.status ? error.message : "Internal Server Error",
    });
  }
};

// ==========================================
// 6. RAZORPAY WEBHOOK HANDLER
// POST /api/wallet/webhook/razorpay
// ==========================================
exports.handleRazorpayWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));

    const result = await paymentService.handleWebhook(rawBody, signature);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Razorpay Webhook Error:", error.message);
    return res.status(error.statusCode || error.status || 400).json({
      success: false,
      message: error.message || "Webhook processing error",
    });
  }
};

// ==========================================
// 7. REQUEST WITHDRAWAL
// POST /api/wallet/withdraw/request
// ==========================================
exports.requestWithdrawal = async (req, res) => {
  try {
    const userId = req.user._id;
    const { amount, payoutMode, payoutDetails } = req.body;

    const result = await paymentService.requestWithdrawal(userId, {
      amount,
      payoutMode,
      payoutDetails,
    });

    return res.status(201).json({
      success: true,
      message: "Withdrawal request submitted successfully",
      data: {
        withdrawal: result.withdrawal,
        remainingBalance: result.remainingBalance,
      },
    });
  } catch (error) {
    console.error("Request Withdrawal Error:", error);
    return res.status(error.statusCode || error.status || 500).json({
      success: false,
      message: error.statusCode || error.status ? error.message : "Internal Server Error",
    });
  }
};

// ==========================================
// 8. GET USER DEPOSIT HISTORY
// GET /api/wallet/deposit/history
// ==========================================
exports.getMyDeposits = async (req, res) => {
  try {
    const userId = req.user._id;
    const { page, limit } = req.query;

    const result = await paymentService.getUserDeposits(userId, page, limit);

    return res.status(200).json({
      success: true,
      message: "Deposit history fetched successfully",
      data: result,
    });
  } catch (error) {
    console.error("Get Deposit History Error:", error);
    return res.status(error.statusCode || error.status || 500).json({
      success: false,
      message: error.statusCode || error.status ? error.message : "Internal Server Error",
    });
  }
};

// ==========================================
// 9. GET USER WITHDRAWAL HISTORY
// GET /api/wallet/withdraw/history
// ==========================================
exports.getMyWithdrawals = async (req, res) => {
  try {
    const userId = req.user._id;
    const { page, limit } = req.query;

    const result = await paymentService.getUserWithdrawals(userId, page, limit);

    return res.status(200).json({
      success: true,
      message: "Withdrawal history fetched successfully",
      data: result,
    });
  } catch (error) {
    console.error("Get Withdrawal History Error:", error);
    return res.status(error.statusCode || error.status || 500).json({
      success: false,
      message: error.statusCode || error.status ? error.message : "Internal Server Error",
    });
  }
};
