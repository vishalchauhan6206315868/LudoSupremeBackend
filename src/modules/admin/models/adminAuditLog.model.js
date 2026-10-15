"use strict";

const mongoose = require("mongoose");

// Append-only record of every state-changing admin action. There is intentionally
// no update / delete API for this collection.
const auditSchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
    adminEmail: { type: String, required: true },
    action: { type: String, required: true, index: true }, // e.g. user.block, wallet.credit
    targetType: { type: String, default: null }, // user | admin | banner | ticket | ...
    targetId: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: { type: String, default: null },
    requestId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditSchema.index({ createdAt: -1 });
auditSchema.index({ admin: 1, createdAt: -1 });
auditSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

module.exports = mongoose.model("AdminAuditLog", auditSchema);
