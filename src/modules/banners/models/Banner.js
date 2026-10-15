"use strict";

const mongoose = require("mongoose");

const bannerSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    subtitle: { type: String, trim: true, maxlength: 200, default: "" },
    imageUrl: { type: String, required: true, trim: true, maxlength: 500 },
    linkUrl: { type: String, trim: true, maxlength: 500, default: "" },
    type: { type: String, enum: ["banner", "event"], default: "banner" },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    priority: { type: Number, min: 0, max: 100, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

bannerSchema.index({ isActive: 1, priority: -1, createdAt: -1 });

module.exports = mongoose.model("Banner", bannerSchema);
