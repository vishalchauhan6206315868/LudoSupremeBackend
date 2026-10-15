const express = require("express");

const router = express.Router();

const { protect } = require("../../../../middleware/auth.middleware");
const {
  getRewards,
  getMyRewards,
  getRewardsSummary,
  claimReward,
} = require("../controllers/reward.controller");
const {
  claimRewardValidation,
  validateRequest,
} = require("../validations/reward.validation");

// ==========================
// 1. Get Rewards List
// GET /api/rewards
// ==========================
router.get("/", protect, getRewards);

// ==========================
// 2. Get My Rewards History
// GET /api/rewards/me
// ==========================
router.get("/me", protect, getMyRewards);

// ==========================
// 3. Get Rewards Summary
// GET /api/rewards/summary
// ==========================
router.get("/summary", protect, getRewardsSummary);

// ==========================
// 4. Claim Reward
// POST /api/rewards/:rewardId/claim
// ==========================
router.post(
  "/:rewardId/claim",
  protect,
  claimRewardValidation,
  validateRequest,
  claimReward
);

module.exports = router;
