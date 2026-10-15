"use strict";

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const config = require("../../../../config/env");
const User = require("../models/User");
const walletService = require("../../wallet/services/wallet.service");
const AppError = require("../../../../utils/AppError");
const asyncHandler = require("../../../../utils/asyncHandler");
const logger = require("../../../../utils/logger");

const BCRYPT_ROUNDS = 12;

// Used to burn the same CPU time when the email does not exist, so response time
// does not reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_ROUNDS);

const generateToken = (userId) =>
  jwt.sign({ id: String(userId) }, config.jwt.secret, {
    algorithm: config.jwt.algorithm,
    expiresIn: config.jwt.expiresIn,
    issuer: config.jwt.issuer,
  });

const normalizeEmail = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  avatar: user.avatar,
  role: user.role,
  isVerified: user.isVerified,
});

// ==========================
// Register User
// ==========================
exports.register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  const normalizedName = typeof name === "string" ? name.trim() : "";
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedName || !normalizedEmail || typeof password !== "string" || !password) {
    throw new AppError("Name, email, and password are required", 400);
  }

  const existingUser = await User.exists({ email: normalizedEmail });
  if (existingUser) {
    throw new AppError("Email already registered", 409);
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

  let user;
  try {
    user = await User.create({
      name: normalizedName,
      email: normalizedEmail,
      password: hashedPassword,
    });
  } catch (error) {
    // Two simultaneous sign-ups with the same email: the unique index decides.
    if (error.code === 11000) throw new AppError("Email already registered", 409);
    throw error;
  }

  // Welcome coins go through the ledger. Idempotent by referenceId, so it can never be granted twice.
  const bonus = config.economy.signupBonusCoins;
  if (bonus > 0) {
    try {
      await walletService.creditWallet(user._id, bonus, "bonus", "Signup bonus", `signup:${user._id}`);
    } catch (error) {
      // Do not fail the registration; ops can re-run the (idempotent) credit.
      logger.error("signup_bonus_failed", { userId: String(user._id), err: error });
    }
  }

  return res.status(201).json({
    success: true,
    message: "User registered successfully",
    data: { user: publicUser(user), token: generateToken(user._id) },
  });
});

// ==========================
// Login User
// ==========================
exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || typeof password !== "string" || !password) {
    throw new AppError("Email and password are required", 400);
  }

  const user = await User.findOne({ email: normalizedEmail }).select("+password");

  // Always run one bcrypt comparison (real or dummy hash) to keep timing uniform.
  const hashToCheck = user && user.password ? user.password : DUMMY_HASH;
  const passwordMatches = await bcrypt.compare(password, hashToCheck);

  if (!user || !user.password || !passwordMatches) {
    // Google-only accounts have no password; same generic message avoids leaking account type.
    throw new AppError("Invalid email or password", 401);
  }

  // Only reveal account state after the credentials were proven correct.
  if (!user.isActive) {
    throw new AppError("Your account is inactive", 403);
  }

  await User.updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } });

  return res.status(200).json({
    success: true,
    message: "Login successful",
    data: { user: publicUser(user), token: generateToken(user._id) },
  });
});
