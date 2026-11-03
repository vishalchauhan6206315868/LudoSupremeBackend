"use strict";

const express = require("express");

const router = express.Router();

const { protect } = require("../../../../middleware/auth.middleware");
const {
  getWallet,
  getMyBalance,
  getTransactions,
  createDepositOrder,
  verifyDepositPayment,
  handleRazorpayWebhook,
  requestWithdrawal,
  getMyDeposits,
  getMyWithdrawals,
} = require("../controllers/wallet.controller");
const {
  getTransactionsValidation,
  createDepositValidation,
  verifyDepositValidation,
  withdrawRequestValidation,
  validateRequest,
} = require("../validations/wallet.validation");

// ==========================
// 1. Get Wallet
// GET /api/wallet
// ==========================
router.get("/", protect, getWallet);

// ==========================
// 2. Get My Wallet Balance
// GET /api/wallet/me
// ==========================
router.get("/me", protect, getMyBalance);

// ==========================
// 3. Get Transactions History
// GET /api/wallet/transactions
// ==========================
router.get(
  "/transactions",
  protect,
  getTransactionsValidation,
  validateRequest,
  getTransactions
);

// ==========================
// 4. Deposit: Create Razorpay Order
// POST /api/wallet/deposit/create-order
// ==========================
router.post(
  "/deposit/create-order",
  protect,
  createDepositValidation,
  validateRequest,
  createDepositOrder
);

// ==========================
// 5. Deposit: Verify Razorpay Signature
// POST /api/wallet/deposit/verify
// ==========================
router.post(
  "/deposit/verify",
  protect,
  verifyDepositValidation,
  validateRequest,
  verifyDepositPayment
);

// ==========================
// 6. Deposit: History
// GET /api/wallet/deposit/history
// ==========================
router.get(
  "/deposit/history",
  protect,
  getTransactionsValidation,
  validateRequest,
  getMyDeposits
);

// ==========================
// 7. Razorpay Webhook (Server-to-Server)
// POST /api/wallet/webhook/razorpay
// ==========================
router.post("/webhook/razorpay", handleRazorpayWebhook);

// ==========================
// 8. Withdrawal: Request Cashout
// POST /api/wallet/withdraw/request
// ==========================
router.post(
  "/withdraw/request",
  protect,
  withdrawRequestValidation,
  validateRequest,
  requestWithdrawal
);

// ==========================
// 9. Withdrawal: History
// GET /api/wallet/withdraw/history
// ==========================
router.get(
  "/withdraw/history",
  protect,
  getTransactionsValidation,
  validateRequest,
  getMyWithdrawals
);

module.exports = router;
