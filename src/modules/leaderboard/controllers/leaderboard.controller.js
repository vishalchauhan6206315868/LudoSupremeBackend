const LeaderboardStats = require("../models/LeaderboardStats");

/**
 * Helper to get or create LeaderboardStats for a user
 */
const getOrCreateLeaderboardStats = async (userId) => {
  let stats = await LeaderboardStats.findOne({ user: userId });

  if (!stats) {
    try {
      stats = await LeaderboardStats.create({
        user: userId,
        score: 0,
        wins: 0,
        losses: 0,
        gamesPlayed: 0,
      });
    } catch (error) {
      if (error.code === 11000) {
        stats = await LeaderboardStats.findOne({ user: userId });
      } else {
        throw error;
      }
    }
  }

  return stats;
};

/**
 * Helper to calculate user's exact rank based on sorting logic:
 * score DESC -> wins DESC -> gamesPlayed DESC -> _id ASC
 */
const calculateUserRank = async (userStats) => {
  const higherRankedCount = await LeaderboardStats.countDocuments({
    $or: [
      { score: { $gt: userStats.score } },
      {
        score: userStats.score,
        wins: { $gt: userStats.wins },
      },
      {
        score: userStats.score,
        wins: userStats.wins,
        gamesPlayed: { $gt: userStats.gamesPlayed },
      },
      {
        score: userStats.score,
        wins: userStats.wins,
        gamesPlayed: userStats.gamesPlayed,
        _id: { $lt: userStats._id },
      },
    ],
  });

  return higherRankedCount + 1;
};

// ==========================================
// FEATURE 1: GET LEADERBOARD (Top Players)
// GET /api/leaderboard
// ==========================================
exports.getLeaderboard = async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    // Ensure authenticated user stats exist
    const currentUserStats = await getOrCreateLeaderboardStats(req.user._id);

    // Fetch top ranked players
    const topStats = await LeaderboardStats.find()
      .sort({ score: -1, wins: -1, gamesPlayed: -1, _id: 1 })
      .limit(limit)
      .populate("user", "name avatar");

    const leaderboard = topStats.map((item, index) => {
      const userDoc = item.user;
      return {
        rank: index + 1,
        user: {
          id: userDoc ? (userDoc._id ? userDoc._id.toString() : userDoc.toString()) : "",
          name: userDoc ? userDoc.name || "Player" : "Player",
          avatar: userDoc && userDoc.avatar ? userDoc.avatar : "",
        },
        score: item.score,
        wins: item.wins,
        gamesPlayed: item.gamesPlayed,
      };
    });

    // Determine current user's rank
    const currentUserInTop = topStats.findIndex(
      (item) =>
        item.user &&
        item.user._id &&
        item.user._id.toString() === req.user._id.toString()
    );

    let currentUserRank;
    if (currentUserInTop !== -1) {
      currentUserRank = currentUserInTop + 1;
    } else {
      currentUserRank = await calculateUserRank(currentUserStats);
    }

    return res.status(200).json({
      success: true,
      message: "Leaderboard fetched successfully",
      data: {
        leaderboard,
        currentUser: {
          rank: currentUserRank,
          score: currentUserStats.score,
          wins: currentUserStats.wins,
          gamesPlayed: currentUserStats.gamesPlayed,
        },
      },
    });
  } catch (error) {
    console.error("Get Leaderboard Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

// ==========================================
// FEATURE 2: GET USER RANKING
// GET /api/leaderboard/me
// ==========================================
exports.getMyRanking = async (req, res) => {
  try {
    const userStats = await getOrCreateLeaderboardStats(req.user._id);
    const rank = await calculateUserRank(userStats);

    return res.status(200).json({
      success: true,
      message: "User ranking fetched successfully",
      data: {
        rank,
        score: userStats.score,
        wins: userStats.wins,
        losses: userStats.losses,
        gamesPlayed: userStats.gamesPlayed,
      },
    });
  } catch (error) {
    console.error("Get My Ranking Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

// ==========================================
// DEPRECATED: POST /api/leaderboard/update-result
//
// This used to let any logged-in user send {"result":"win"} as many times as they wanted
// and climb the leaderboard forever. Results are now recorded by the server itself when a
// match is settled (see game.service.js -> leaderboard.service.js).
//
// The route is kept so older app builds do not crash: it ignores the body and simply
// returns the player's current (server-owned) numbers.
// ==========================================
exports.updateGameResult = async (req, res) => {
  try {
    const userStats = await getOrCreateLeaderboardStats(req.user._id);

    return res.status(200).json({
      success: true,
      message: "Results are recorded automatically by the server",
      data: {
        score: userStats.score,
        wins: userStats.wins,
        losses: userStats.losses,
        gamesPlayed: userStats.gamesPlayed,
      },
    });
  } catch (error) {
    console.error("Update Game Result Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};
