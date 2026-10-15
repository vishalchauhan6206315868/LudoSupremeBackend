const express = require("express");

const router = express.Router();

const { protect } = require("../../../../middleware/auth.middleware");
const {
  getLeaderboard,
  getMyRanking,
  updateGameResult,
} = require("../controllers/leaderboard.controller");
const {
  updateResultValidation,
  validateRequest,
} = require("../validations/leaderboard.validation");

// ==========================
// 1. Get Ranked Leaderboard
// GET /api/leaderboard
// ==========================
router.get("/", protect, getLeaderboard);

// ==========================
// 2. Get Logged-in User Ranking
// GET /api/leaderboard/me
// ==========================
router.get("/me", protect, getMyRanking);

// ==========================
// 3. Update Player Game Result
// POST /api/leaderboard/update-result
// ==========================
router.post(
  "/update-result",
  protect,
  updateResultValidation,
  validateRequest,
  updateGameResult
);

module.exports = router;
