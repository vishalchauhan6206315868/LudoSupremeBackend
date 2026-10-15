"use strict";

const User = require("../../auth/models/User");
const walletService = require("../../wallet/services/wallet.service");
const AppError = require("../../../../utils/AppError");
const asyncHandler = require("../../../../utils/asyncHandler");

// Get Logged-in User Profile
exports.getMyProfile = asyncHandler(async (req, res) => {
  const [user, coins] = await Promise.all([
    User.findById(req.user._id).select("-password -__v").lean(),
    walletService.getBalance(req.user._id), // wallet = single source of truth for coins
  ]);

  if (!user) throw new AppError("User profile not found.", 404);

  return res.status(200).json({
    success: true,
    message: "Profile fetched successfully",
    data: {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        role: user.role,
        isVerified: user.isVerified,
        coins,
        gems: user.gems,
        experience: user.experience,
        level: user.level,
        statistics: user.statistics,
        createdAt: user.createdAt,
      },
    },
  });
});
