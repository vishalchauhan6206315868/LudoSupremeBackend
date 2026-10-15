const { body, param, query, validationResult } = require("express-validator");
const mongoose = require("mongoose");

// Validation Error Handler
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: "Validation Failed",
      errors: errors.array().map((error) => ({
        field: error.path,
        message: error.msg,
      })),
    });
  }

  next();
};

// Start Game Session Validation
const startGameValidation = [
  body("roomCode")
    .trim()
    .notEmpty()
    .withMessage("Room code is required")
    .isLength({ min: 6, max: 6 })
    .withMessage("Room code must be exactly 6 characters")
    .isAlphanumeric()
    .withMessage("Room code must contain only letters and numbers"),
];

// Session ID Param Validation
const sessionIdParamValidation = [
  param("sessionId")
    .trim()
    .notEmpty()
    .withMessage("Session ID is required")
    .custom((val) => mongoose.Types.ObjectId.isValid(val))
    .withMessage("Invalid Session ID format"),
];

// Move Token Validation
const moveTokenValidation = [
  param("sessionId")
    .trim()
    .notEmpty()
    .withMessage("Session ID is required")
    .custom((val) => mongoose.Types.ObjectId.isValid(val))
    .withMessage("Invalid Session ID format"),
  body("tokenId")
    .notEmpty()
    .withMessage("tokenId is required")
    .isInt({ min: 0, max: 3 })
    .withMessage("tokenId must be an integer between 0 and 3"),
];

// Game History Query Validation
const historyQueryValidation = [
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("page must be an integer >= 1"),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage("limit must be an integer between 1 and 50"),
];

module.exports = {
  validateRequest,
  startGameValidation,
  sessionIdParamValidation,
  moveTokenValidation,
  historyQueryValidation,
};
