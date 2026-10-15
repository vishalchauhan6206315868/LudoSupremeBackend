"use strict";

const jwt = require("jsonwebtoken");
const config = require("../config/env");
const User = require("../src/modules/auth/models/User");
const AppError = require("../utils/AppError");
const asyncHandler = require("../utils/asyncHandler");

const extractToken = (req) => {
  const header = (req.headers.authorization || "").trim();
  if (!header) return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  // Older app builds sent the bare token without "Bearer " - still accepted.
  return (match ? match[1] : header).trim();
};

// Verify JWT and attach the (lean) user to req.user
exports.protect = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) {
    throw new AppError("Authentication required. Please login.", 401);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret, {
      algorithms: [config.jwt.algorithm], // blocks "alg: none" / algorithm confusion
    });
  } catch (error) {
    throw new AppError("Invalid or expired token. Please login again.", 401);
  }

  // Admin tokens carry typ:"admin" and are only valid on /api/admin routes.
  if (!decoded || decoded.typ === "admin" || typeof decoded.id !== "string") {
    throw new AppError("Invalid or expired token. Please login again.", 401);
  }

  const user = await User.findById(decoded.id)
    .select("name email username avatar role isVerified isActive")
    .lean();

  if (!user) {
    throw new AppError("User not found. Please login again.", 401);
  }
  if (!user.isActive) {
    throw new AppError("Your account is inactive.", 403);
  }

  req.user = user;
  next();
});

// Role guard: router.use(protect, authorize("admin"))
exports.authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new AppError("You do not have permission to perform this action.", 403));
  }
  next();
};
