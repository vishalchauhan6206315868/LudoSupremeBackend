"use strict";

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const config = require("../../../../config/env");
const AppError = require("../../../../utils/AppError");
const asyncHandler = require("../../../../utils/asyncHandler");
const logger = require("../../../../utils/logger");
const { qs, parsePagination, pageMeta } = require("../../../../utils/adminHelpers");
const Admin = require("../models/admin.model");
const audit = require("../services/audit.service");

const BCRYPT_ROUNDS = 12;
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_ROUNDS);

const normalizeEmail = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

const publicAdmin = (admin) => ({
  id: admin._id,
  name: admin.name,
  email: admin.email,
  role: admin.role,
  avatar: admin.avatar,
  isActive: admin.isActive,
  lastLogin: admin.lastLogin || null,
  createdAt: admin.createdAt,
});

// typ:"admin" keeps these tokens from ever being accepted on player routes (see auth.middleware).
const signAdminToken = (admin) =>
  jwt.sign({ id: String(admin._id), typ: "admin" }, config.jwt.secret, {
    algorithm: config.jwt.algorithm,
    expiresIn: config.admin.jwtExpiresIn,
    issuer: config.jwt.issuer,
  });

// ==========================
// POST /api/admin/login
// ==========================
exports.loginAdmin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || typeof password !== "string" || !password) {
    throw new AppError("Email and password are required", 400);
  }

  const admin = await Admin.findOne({ email: normalizedEmail }).select("+password");
  if (!admin) {
    await bcrypt.compare(password, DUMMY_HASH); // same cost whether or not the email exists
    logger.warn("admin_login_failed", { ip: req.ip, reason: "unknown_email", requestId: req.id });
    throw new AppError("Invalid email or password", 401);
  }

  const passwordMatches = await bcrypt.compare(password, admin.password);
  if (!passwordMatches) {
    logger.warn("admin_login_failed", { ip: req.ip, adminId: String(admin._id), reason: "bad_password", requestId: req.id });
    throw new AppError("Invalid email or password", 401);
  }
  // Checked AFTER the password so inactive accounts cannot be discovered by guessing emails.
  if (!admin.isActive) {
    throw new AppError("This admin account is inactive", 403);
  }

  const token = signAdminToken(admin);
  const lastLogin = new Date();
  await Admin.updateOne({ _id: admin._id }, { $set: { lastLogin } });
  logger.info("admin_login", { adminId: String(admin._id), ip: req.ip, requestId: req.id });

  return res.status(200).json({
    success: true,
    message: "Admin login successful",
    data: { admin: { ...publicAdmin(admin), lastLogin }, token, expiresIn: config.admin.jwtExpiresIn },
  });
});

// GET /api/admin/me
exports.getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { admin: publicAdmin(req.admin) } });
});

// POST /api/admin/change-password   (revokes every older token, returns a fresh one)
exports.changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const admin = await Admin.findById(req.admin._id).select("+password");
  if (!admin || !(await bcrypt.compare(currentPassword, admin.password))) {
    throw new AppError("Current password is incorrect", 400);
  }
  if (currentPassword === newPassword) {
    throw new AppError("New password must be different from the current one", 400);
  }

  admin.password = newPassword; // hashed by the model's pre-save hook
  admin.tokensValidAfter = new Date();
  await admin.save();
  await audit.record(req, "admin.password_change", { targetType: "admin", targetId: admin._id });

  res.json({
    success: true,
    message: "Password changed. All other sessions were signed out.",
    data: { token: signAdminToken(admin), expiresIn: config.admin.jwtExpiresIn },
  });
});

// POST /api/admin/logout-all   (the JWT is stateless, so "logout" = revoke everything issued so far)
exports.logoutAll = asyncHandler(async (req, res) => {
  await Admin.updateOne({ _id: req.admin._id }, { $set: { tokensValidAfter: new Date() } });
  await audit.record(req, "admin.logout_all", { targetType: "admin", targetId: req.admin._id });
  res.json({ success: true, message: "Signed out from all devices" });
});

// ==========================
// Admin management (superadmin only)
// ==========================
exports.listAdmins = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const [total, admins] = await Promise.all([
    Admin.countDocuments(),
    Admin.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({ success: true, data: { admins: admins.map(publicAdmin), pagination: pageMeta(page, limit, total) } });
});

exports.createAdmin = asyncHandler(async (req, res) => {
  const { name, email, password, role = "admin" } = req.body;
  const admin = new Admin({ name, email: normalizeEmail(email), password, role, createdBy: req.admin._id });
  await admin.save(); // duplicate email -> 409 via the global error handler
  await audit.record(req, "admin.create", { targetType: "admin", targetId: admin._id, meta: { email: admin.email, role } });
  res.status(201).json({ success: true, data: { admin: publicAdmin(admin) } });
});

exports.setAdminStatus = asyncHandler(async (req, res) => {
  const { isActive } = req.body;
  const target = await Admin.findById(req.params.id);
  if (!target) throw new AppError("Admin not found", 404);

  if (String(target._id) === String(req.admin._id) && isActive === false) {
    throw new AppError("You cannot deactivate your own account", 400);
  }
  if (isActive === false && target.role === "superadmin") {
    const others = await Admin.countDocuments({ role: "superadmin", isActive: true, _id: { $ne: target._id } });
    if (others === 0) throw new AppError("Cannot deactivate the last active super admin", 400);
  }

  const patch = { isActive };
  if (!isActive) patch.tokensValidAfter = new Date(); // kick them out immediately
  await Admin.updateOne({ _id: target._id }, { $set: patch });
  target.isActive = isActive;
  await audit.record(req, isActive ? "admin.activate" : "admin.deactivate", { targetType: "admin", targetId: target._id });
  res.json({ success: true, data: { admin: publicAdmin(target) } });
});

exports._test = { signAdminToken, publicAdmin, qs };
