"use strict";

const AdminAuditLog = require("../models/adminAuditLog.model");
const logger = require("../../../../utils/logger");

/**
 * Record an admin action. Never throws: the action itself has already happened and must not be
 * reported as failed just because the log write failed (the failure is logged loudly instead).
 * NEVER put passwords / tokens in `meta`.
 */
const record = async (req, action, { targetType = null, targetId = null, meta = {} } = {}) => {
  try {
    await AdminAuditLog.create({
      admin: req.admin._id,
      adminEmail: req.admin.email,
      action,
      targetType,
      targetId: targetId ? String(targetId) : null,
      meta,
      ip: req.ip || null,
      requestId: req.id || null,
    });
  } catch (err) {
    logger.error("audit_write_failed", { action, adminId: String(req.admin._id), err });
  }
};

module.exports = { record };
