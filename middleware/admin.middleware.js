"use strict";

const jwt = require("jsonwebtoken");
const config = require("../config/env");
const Admin = require("../src/modules/admin/models/admin.model");
const AppError = require("../utils/AppError");
const asyncHandler = require("../utils/asyncHandler");

const ADMIN_ROLES = ["admin", "superadmin"];

const extractToken = (req) => {
  const header = (req.headers.authorization || "").trim();
  if (!header) return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return (match ? match[1] : header).trim();
};

const protectAdmin = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) {
    throw new AppError("Authentication required. Please login.", 401);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret, {
      algorithms: [config.jwt.algorithm],
      issuer: config.jwt.issuer,
    });
  } catch (error) {
    throw new AppError("Invalid or expired token. Please login again.", 401);
  }

  // Player tokens (no typ) can never be used here, even though they share the signing secret.
  if (!decoded || decoded.typ !== "admin" || typeof decoded.id !== "string") {
    throw new AppError("Invalid or expired token. Please login again.", 401);
  }

  const admin = await Admin.findById(decoded.id)
    .select("name email role avatar isActive lastLogin createdAt tokensValidAfter")
    .lean();

  if (!admin) {
    throw new AppError("Admin not found. Please login again.", 401);
  }
  if (!admin.isActive) {
    throw new AppError("Admin account is inactive.", 403);
  }
  if (!ADMIN_ROLES.includes(admin.role)) {
    throw new AppError("Admin access required.", 403);
  }
  // Password change / "log out everywhere" revokes all older tokens.
  if (admin.tokensValidAfter && decoded.iat < Math.floor(new Date(admin.tokensValidAfter).getTime() / 1000)) {
    throw new AppError("Session expired. Please login again.", 401);
  }

  req.admin = admin;
  next();
});

const requireSuperAdmin = (req, res, next) => {
  if (!req.admin || req.admin.role !== "superadmin") {
    return next(new AppError("Super admin access required.", 403));
  }
  next();
};

module.exports = { protectAdmin, requireSuperAdmin, ADMIN_ROLES };
