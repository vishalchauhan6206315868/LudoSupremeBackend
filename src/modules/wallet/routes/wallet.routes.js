const express = require("express");

const router = express.Router();

const { protect } = require("../../../../middleware/auth.middleware");
const {
  getWallet,
  getMyBalance,
  getTransactions,
} = require("../controllers/wallet.controller");
const {
  getTransactionsValidation,
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

module.exports = router;
