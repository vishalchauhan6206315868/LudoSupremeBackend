"use strict";

const LeaderboardStats = require("../models/LeaderboardStats");
const { WIN_LEADERBOARD_POINTS, LOSS_LEADERBOARD_POINTS } = require("../../games/engine/ludoEngine");

/**
 * Leaderboard numbers are written ONLY by the server when a match is settled.
 * (The old public POST /update-result let any user mark themselves as winning forever.)
 */
const recordResult = async (userId, outcome) => {
  const inc = { gamesPlayed: 1 };
  if (outcome === "win") {
    inc.wins = 1;
    inc.score = WIN_LEADERBOARD_POINTS;
  } else if (outcome === "loss") {
    inc.losses = 1;
    inc.score = LOSS_LEADERBOARD_POINTS;
  }

  await LeaderboardStats.updateOne({ user: userId }, { $inc: inc }, { upsert: true });

  if (outcome === "loss") {
    // score has min 0; updates skip schema validators, so clamp explicitly.
    await LeaderboardStats.updateOne({ user: userId, score: { $lt: 0 } }, { $set: { score: 0 } });
  }
};

module.exports = { recordResult };
