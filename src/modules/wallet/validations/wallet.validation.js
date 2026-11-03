"use strict";

const { query, body, validationResult } = require("express-validator");

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

const createDepositValidation = [
  body("amount")
    .isInt({ min: 1 })
    .withMessage("Amount must be a positive whole number (in INR)"),
];

const verifyDepositValidation = [
  body("razorpayOrderId")
    .trim()
    .notEmpty()
    .withMessage("razorpayOrderId is required"),
  body("razorpayPaymentId")
    .trim()
    .notEmpty()
    .withMessage("razorpayPaymentId is required"),
  body("razorpaySignature")
    .trim()
    .notEmpty()
    .withMessage("razorpaySignature is required"),
];

const withdrawRequestValidation = [
  body("amount")
    .isInt({ min: 1 })
    .withMessage("Withdrawal amount must be a positive whole number"),
  body("payoutMode")
    .isIn(["upi", "bank_transfer"])
    .withMessage("Payout mode must be either 'upi' or 'bank_transfer'"),
  body("payoutDetails")
    .isObject()
    .withMessage("payoutDetails object is required"),
  body("payoutDetails.upiId")
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^[\w.\-_]{2,}@[a-zA-Z]{2,}$/)
    .withMessage("Invalid UPI ID format (e.g. username@bank)"),
  body("payoutDetails.accountNumber")
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ min: 8, max: 20 })
    .withMessage("Bank account number must be between 8 and 20 digits"),
  body("payoutDetails.ifscCode")
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^[A-Z]{4}0[A-Z0-9]{6}$/)
    .withMessage("Invalid IFSC code format (e.g. SBIN0001234)"),
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
  createDepositValidation,
  verifyDepositValidation,
  withdrawRequestValidation,
  validateRequest,
};
