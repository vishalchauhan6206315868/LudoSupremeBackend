

const express = require("express");

const router = express.Router();

const {
  loginLimiter,
  registerLimiter,
} = require("../../../../middleware/rateLimit.middleware");

const {
  register,
  login,
} = require("../controllers/auth.controller");

const {
  registerValidation,
  loginValidation,
  validateRequest,
} = require("../validations/auth.validation");

// ==========================
// Register API
// ==========================
router.post(
  "/register",
  registerLimiter,
  registerValidation,
  validateRequest,
  register
);

// ==========================
// Login API
// ==========================
router.post(
  "/login",
  loginLimiter,
  loginValidation,
  validateRequest,
  login
);

module.exports = router;