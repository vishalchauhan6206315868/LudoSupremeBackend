const mongoose = require("mongoose");

const leaderboardStatsSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User is required"],
      unique: true,
    },
    score: {
      type: Number,
      default: 0,
      min: 0,
    },
    wins: {
      type: Number,
      default: 0,
      min: 0,
    },
    losses: {
      type: Number,
      default: 0,
      min: 0,
    },
    gamesPlayed: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

leaderboardStatsSchema.index({ score: -1, wins: -1, gamesPlayed: -1, _id: 1 });

module.exports = mongoose.model("LeaderboardStats", leaderboardStatsSchema);
