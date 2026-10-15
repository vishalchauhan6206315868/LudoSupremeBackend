"use strict";

const Reward = require("../models/Reward");
const RewardClaim = require("../models/RewardClaim");
const User = require("../../auth/models/User");
const walletService = require("../../wallet/services/wallet.service");
const AppError = require("../../../../utils/AppError");
const asyncHandler = require("../../../../utils/asyncHandler");
const logger = require("../../../../utils/logger");

const DEFAULT_REWARDS = [
  { title: "Daily Login Reward", description: "Login daily and claim your reward", rewardValue: 100, icon: "daily_login" },
  { title: "Welcome Bonus", description: "Welcome to Ludo Supreme! Enjoy your starter bonus", rewardValue: 500, icon: "welcome_bonus" },
  { title: "First Win Bonus", description: "Win your first match and get rewarded", rewardValue: 250, icon: "first_win", requirement: { metric: "wins", min: 1 } },
  { title: "Lucky Spin", description: "Try your luck with the daily spin reward", rewardValue: 150, icon: "lucky_spin" },
  { title: "Weekend Rush", description: "Special weekend play reward", rewardValue: 300, icon: "weekend_rush" },
  { title: "Referral Bonus", description: "Invite friends and claim bonus coins", rewardValue: 200, icon: "referral_bonus" },
  { title: "Master Player", description: "Play 10 games to unlock this reward", rewardValue: 1000, icon: "master_player", requirement: { metric: "totalGames", min: 10 } },
  { title: "Daily Streak Day 2", description: "Maintain your 2-day login streak", rewardValue: 150, icon: "streak_2" },
  { title: "Daily Streak Day 3", description: "Maintain your 3-day login streak", rewardValue: 200, icon: "streak_3" },
  { title: "Community Reward", description: "Join our community and claim your gift", rewardValue: 50, icon: "community" },
].map((r) => ({ rewardType: "coins", isActive: true, ...r }));

// Rewards created before the `requirement` field existed are matched by icon.
const LEGACY_REQUIREMENTS = {
  first_win: { metric: "wins", min: 1 },
  master_player: { metric: "totalGames", min: 10 },
};

const getRequirement = (reward) => {
  if (reward.requirement && reward.requirement.metric) return reward.requirement;
  return LEGACY_REQUIREMENTS[reward.icon] || null;
};

const isRequirementMet = (reward, stats) => {
  const req = getRequirement(reward);
  if (!req) return true;
  return (stats?.[req.metric] || 0) >= req.min;
};

/**
 * Run once at server start (NOT on every GET: parallel first requests used to insert duplicates).
 */
const seedDefaultRewards = async () => {
  const count = await Reward.estimatedDocumentCount();
  if (count === 0) {
    await Reward.insertMany(DEFAULT_REWARDS);
    logger.info("default_rewards_seeded", { count: DEFAULT_REWARDS.length });
  }
};

const loadStats = async (userId) => {
  const user = await User.findById(userId).select("statistics").lean();
  return user?.statistics || {};
};

// GET /api/rewards
exports.getRewards = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const [rewards, userClaims, stats] = await Promise.all([
    Reward.find({ isActive: true }).sort({ createdAt: 1 }),
    RewardClaim.find({ user: userId }).select("reward"),
    loadStats(userId),
  ]);
  const claimed = new Set(userClaims.map((c) => c.reward.toString()));

  return res.status(200).json({
    success: true,
    message: "Rewards fetched successfully",
    data: {
      rewards: rewards.map((reward) => {
        const isClaimed = claimed.has(reward._id.toString());
        const requirementMet = isRequirementMet(reward, stats);
        return {
          _id: reward._id,
          title: reward.title,
          description: reward.description,
          rewardType: reward.rewardType,
          rewardValue: reward.rewardValue,
          icon: reward.icon,
          isClaimed,
          requirementMet,
          canClaim: !isClaimed && reward.isActive && requirementMet,
        };
      }),
    },
  });
});

// GET /api/rewards/me
exports.getMyRewards = asyncHandler(async (req, res) => {
  const claims = await RewardClaim.find({ user: req.user._id })
    .sort({ claimedAt: -1 })
    .limit(200)
    .populate("reward", "title rewardType rewardValue");

  return res.status(200).json({
    success: true,
    message: "Reward history fetched successfully",
    data: {
      rewards: claims.map((claim) => {
        const doc = claim.reward;
        return {
          rewardId: doc && doc._id ? doc._id.toString() : String(claim.reward),
          title: claim.title || (doc && doc.title) || "Reward",
          rewardType: claim.rewardType || (doc && doc.rewardType) || "coins",
          rewardValue: claim.rewardValue !== undefined ? claim.rewardValue : (doc && doc.rewardValue) || 0,
          claimedAt: (claim.claimedAt || claim.createdAt || new Date()).toISOString(),
        };
      }),
    },
  });
});

// POST /api/rewards/:rewardId/claim
exports.claimReward = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const reward = await Reward.findById(req.params.rewardId);
  if (!reward) throw new AppError("Reward not found", 404);
  if (!reward.isActive) throw new AppError("Reward is currently not active", 400);

  const stats = await loadStats(userId);
  if (!isRequirementMet(reward, stats)) {
    throw new AppError("You have not unlocked this reward yet", 403);
  }

  // 1) Reserve the claim. The unique (user, reward) index makes double-claims impossible,
  //    even with two simultaneous requests.
  try {
    await RewardClaim.create({
      user: userId,
      reward: reward._id,
      title: reward.title,
      rewardType: reward.rewardType,
      rewardValue: reward.rewardValue,
      claimedAt: new Date(),
    });
  } catch (error) {
    if (error.code === 11000) throw new AppError("Reward already claimed", 400);
    throw error;
  }

  // 2) Pay through the wallet ledger. If this fails, release the claim so the user can retry
  //    (before: the claim was kept and the coins were lost).
  try {
    if (reward.rewardType === "coins" && reward.rewardValue > 0) {
      await walletService.creditWallet(
        userId,
        reward.rewardValue,
        "bonus",
        `Reward: ${reward.title}`,
        `reward:${reward._id}`
      );
    }
  } catch (error) {
    await RewardClaim.deleteOne({ user: userId, reward: reward._id }).catch((e) =>
      logger.error("reward_claim_rollback_failed", { userId: String(userId), rewardId: String(reward._id), err: e })
    );
    throw error;
  }

  return res.status(200).json({
    success: true,
    message: "Reward claimed successfully",
    data: {
      reward: {
        _id: reward._id,
        title: reward.title,
        rewardType: reward.rewardType,
        rewardValue: reward.rewardValue,
      },
    },
  });
});

// GET /api/rewards/summary
exports.getRewardsSummary = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const [activeRewards, userClaims] = await Promise.all([
    Reward.find({ isActive: true }).select("_id"),
    RewardClaim.find({ user: userId }),
  ]);
  const activeIds = new Set(activeRewards.map((r) => r._id.toString()));

  let claimedActiveCount = 0;
  let totalCoinsEarned = 0;
  for (const claim of userClaims) {
    if (claim.reward && activeIds.has(claim.reward.toString())) claimedActiveCount++;
    if (claim.rewardType === "coins") totalCoinsEarned += claim.rewardValue || 0;
  }

  return res.status(200).json({
    success: true,
    message: "Rewards summary fetched successfully",
    data: {
      totalRewards: activeRewards.length,
      claimedRewards: claimedActiveCount,
      availableRewards: Math.max(0, activeRewards.length - claimedActiveCount),
      totalCoinsEarned,
    },
  });
});

exports.seedDefaultRewards = seedDefaultRewards;
