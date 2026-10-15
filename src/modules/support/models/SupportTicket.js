"use strict";

const mongoose = require("mongoose");

const replySchema = new mongoose.Schema(
  {
    authorType: { type: String, enum: ["user", "admin"], required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, required: true },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ticketSchema = new mongoose.Schema(
  {
    ticketNo: { type: String, required: true, unique: true }, // TKT-123456
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subject: { type: String, required: true, trim: true, minlength: 3, maxlength: 120 },
    message: { type: String, required: true, trim: true, minlength: 5, maxlength: 2000 },
    category: {
      type: String,
      enum: ["payment", "game", "account", "bug", "other"],
      default: "other",
    },
    status: { type: String, enum: ["open", "in_progress", "resolved", "closed"], default: "open" },
    priority: { type: String, enum: ["low", "normal", "high"], default: "normal" },
    replies: { type: [replySchema], default: [] },
  },
  { timestamps: true }
);

ticketSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("SupportTicket", ticketSchema);
