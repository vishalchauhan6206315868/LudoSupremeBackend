const { param, validationResult } = require("express-validator");
const mongoose = require("mongoose");

// ==========================
// Claim Reward Param Validation
// ==========================
const claimRewardValidation = [
  param("rewardId")
    .trim()
    .notEmpty()
    .withMessage("Reward ID is required")
    .custom((value) => {
      if (!mongoose.Types.ObjectId.isValid(value)) {
        throw new Error("Invalid reward ID");
      }
      return true;
    }),
];

// ==========================
// Validation Error Handler
// ==========================
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const firstError = errors.array()[0];
    return res.status(400).json({
      success: false,
      message: firstError.msg || "Validation error",
      errors: errors.array().map((error) => ({
        field: error.path,
        message: error.msg,
      })),
    });
  }

  next();
};

module.exports = {
  claimRewardValidation,
  validateRequest,
};
