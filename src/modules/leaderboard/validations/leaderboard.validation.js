const { body, validationResult } = require("express-validator");

// ==========================
// Update Game Result Validation
// ==========================
const updateResultValidation = [
  body("result")
    .trim()
    .notEmpty()
    .withMessage("Invalid result. Allowed values are win or loss")
    .isIn(["win", "loss"])
    .withMessage("Invalid result. Allowed values are win or loss"),
];

// ==========================
// Validation Error Handler
// ==========================
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message:
        errors.array()[0].msg ||
        "Invalid result. Allowed values are win or loss",
      errors: errors.array().map((error) => ({
        field: error.path,
        message: error.msg,
      })),
    });
  }

  next();
};

module.exports = {
  updateResultValidation,
  validateRequest,
};
