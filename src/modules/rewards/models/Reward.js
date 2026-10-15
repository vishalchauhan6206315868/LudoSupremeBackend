const mongoose = require("mongoose");

const rewardSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Reward title is required"],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    rewardType: {
      type: String,
      required: [true, "Reward type is required"],
      enum: ["coins"],
      default: "coins",
    },
    rewardValue: {
      type: Number,
      required: [true, "Reward value is required"],
      min: [0, "Reward value cannot be negative"],
    },
    icon: {
      type: String,
      default: "daily_login",
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Optional eligibility rule, checked on the server when claiming.
    // metric: which user statistic to look at, min: how much of it is required.
    requirement: {
      metric: { type: String, enum: ["wins", "totalGames", null], default: null },
      min: { type: Number, default: 0, min: 0 },
    },
  },
  {
    timestamps: true,
  }
);

rewardSchema.index({ isActive: 1, createdAt: -1 });

module.exports = mongoose.model("Reward", rewardSchema);
