"use strict";

const config = require("../../../../config/env");
const AppError = require("../../../../utils/AppError");
const asyncHandler = require("../../../../utils/asyncHandler");
const { qs, parsePagination, pageMeta, dateRange, escapeRegex } = require("../../../../utils/adminHelpers");
const Banner = require("../../banners/models/Banner");
const AdminAuditLog = require("../models/adminAuditLog.model");
const audit = require("../services/audit.service");
const { bannerView, settingsView, auditView } = require("../../../../utils/adminShapes");

// ---------- Banners & Events ----------
const BANNER_FIELDS = ["title", "subtitle", "imageUrl", "linkUrl", "type", "startsAt", "endsAt", "isActive", "priority"];
const pickBanner = (body) => Object.fromEntries(BANNER_FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

exports.listBanners = asyncHandler(async (req, res) => {
  // Default 50 (max 100): the admin panel shows every banner on one screen.
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50 });
  const [total, banners] = await Promise.all([
    Banner.countDocuments(),
    Banner.find().sort({ priority: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({ success: true, data: { banners: banners.map(bannerView), pagination: pageMeta(page, limit, total) } });
});

exports.createBanner = asyncHandler(async (req, res) => {
  const banner = await Banner.create({ ...pickBanner(req.body), createdBy: req.admin._id });
  await audit.record(req, "banner.create", { targetType: "banner", targetId: banner._id, meta: { title: banner.title } });
  res.status(201).json({ success: true, data: { banner: bannerView(banner) } });
});

exports.updateBanner = asyncHandler(async (req, res) => {
  const banner = await Banner.findById(req.params.id);
  if (!banner) throw new AppError("Banner not found", 404);
  banner.set(pickBanner(req.body));
  if (banner.startsAt && banner.endsAt && banner.endsAt <= banner.startsAt) {
    throw new AppError("endsAt must be after startsAt", 400);
  }
  await banner.save();
  await audit.record(req, "banner.update", { targetType: "banner", targetId: banner._id, meta: { fields: Object.keys(pickBanner(req.body)) } });
  res.json({ success: true, data: { banner: bannerView(banner) } });
});

exports.deleteBanner = asyncHandler(async (req, res) => {
  const banner = await Banner.findByIdAndDelete(req.params.id).lean();
  if (!banner) throw new AppError("Banner not found", 404);
  await audit.record(req, "banner.delete", { targetType: "banner", targetId: banner._id, meta: { title: banner.title } });
  res.json({ success: true, message: "Banner deleted" });
});

// ---------- Settings (read-only; change them via environment variables + restart) ----------
exports.getSettings = asyncHandler(async (_req, res) => {
  res.json({
    success: true,
    data: settingsView(config, { version: process.env.npm_package_version, nodeVersion: process.version }),
  });
});

// ---------- Audit log (superadmin) ----------
exports.listAuditLogs = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 50 });
  const filter = {};
  // Prefix match ("user" finds user.block / user.unblock). Actions are lower-case, so the
  // case-sensitive anchored regex can still use the { action: 1 } index.
  const action = qs(req.query.action).trim().toLowerCase().slice(0, 60);
  if (action) filter.action = new RegExp(`^${escapeRegex(action)}`);
  const adminId = qs(req.query.adminId);
  if (adminId) filter.admin = adminId;
  const targetId = qs(req.query.targetId).slice(0, 40);
  if (targetId) filter.targetId = targetId;
  const range = dateRange(req.query.from, req.query.to);
  if (range) filter.createdAt = range;

  const [total, logs] = await Promise.all([
    AdminAuditLog.countDocuments(filter),
    AdminAuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({ success: true, data: { logs: logs.map(auditView), pagination: pageMeta(page, limit, total) } });
});
