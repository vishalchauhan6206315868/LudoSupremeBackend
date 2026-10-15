"use strict";

const asyncHandler = require("../../../../utils/asyncHandler");
const { qs } = require("../../../../utils/adminHelpers");
const stats = require("../services/stats.service");

// GET /api/admin/dashboard[?refresh=1]
exports.getDashboard = asyncHandler(async (req, res) => {
  const { data, cached } = await stats.getDashboard({ fresh: qs(req.query.refresh) === "1" });
  const health = await stats.getHealth(data.live);
  res.status(200).json({ success: true, cached, generatedAt: new Date().toISOString(), data: { ...data, health } });
});
