"use strict";

const express = require("express");
const { protect } = require("../../../../middleware/auth.middleware");
const asyncHandler = require("../../../../utils/asyncHandler");
const Banner = require("../models/Banner");

const router = express.Router();

// GET /api/banners  -> active banners / events for the app home screen
router.get(
  "/",
  protect,
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const banners = await Banner.find({
      isActive: true,
      $and: [
        { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
        { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
      ],
    })
      .sort({ priority: -1, createdAt: -1 })
      .limit(20)
      .select("title subtitle imageUrl linkUrl type startsAt endsAt priority")
      .lean();
    res.json({ success: true, data: { banners } });
  })
);

module.exports = router;
