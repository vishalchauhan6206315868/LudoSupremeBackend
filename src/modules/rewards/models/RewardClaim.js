const mongoose = require("mongoose");

const rewardClaimSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User reference is required"],
      index: true,
    },
    reward: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Reward",
      required: [true, "Reward reference is required"],
      index: true,
    },
    title: {
      type: String,
      trim: true,
      default: "",
    },
    rewardType: {
      type: String,
      enum: ["coins"],
      default: "coins",
    },
    rewardValue: {
      type: Number,
      required: [true, "Reward value is required"],
      min: 0,
    },
    claimedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Prevent the same user from claiming the same reward multiple times
rewardClaimSchema.index({ user: 1, reward: 1 }, { unique: true });
rewardClaimSchema.index({ user: 1, claimedAt: -1 });

module.exports = mongoose.model("RewardClaim", rewardClaimSchema);
