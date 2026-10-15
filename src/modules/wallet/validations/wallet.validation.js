const { query, validationResult } = require("express-validator");

/**
 * Validation rules for GET /api/wallet/transactions query parameters
 */
const getTransactionsValidation = [
  query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("Page must be a positive integer greater than or equal to 1"),
  query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("Limit must be an integer between 1 and 100"),
];

/**
 * Middleware to check validation results and return formatted error response
 */
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
  getTransactionsValidation,
  validateRequest,
};
