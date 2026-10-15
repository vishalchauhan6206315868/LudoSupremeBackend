"use strict";

const { body, param, query } = require("express-validator");
const config = require("../../../../config/env");
const { validateRequest } = require("../../auth/validations/auth.validation");

// NOTE: sanitizers (trim/toInt/...) are only used on `body`. On Express 5, req.query is read-only,
// so query/param rules are validators only and the controllers parse the values themselves.

const { isStrongPassword, POLICY_MSG } = require("../../../../utils/passwordPolicy");

const idParam = param("id").isMongoId().withMessage("Invalid id");

const listQuery = [
  query("page").optional().isInt({ min: 1, max: 100000 }).withMessage("page must be a positive integer"),
  query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("limit must be between 1 and 100"),
  query("from").optional().isISO8601().withMessage("from must be an ISO date"),
  query("to").optional().isISO8601().withMessage("to must be an ISO date"),
  query("userId").optional().isMongoId().withMessage("Invalid userId"),
  query("adminId").optional().isMongoId().withMessage("Invalid adminId"),
];

const adminLoginValidation = [
  body("email").trim().notEmpty().withMessage("Email is required").bail().isEmail().withMessage("Please enter a valid email").normalizeEmail(),
  body("password")
    .isString().withMessage("Password is required").bail()
    .notEmpty().withMessage("Password is required").bail()
    .isLength({ min: 6, max: 72 }).withMessage("Password must be between 6 and 72 characters"),
];

const changePasswordValidation = [
  body("currentPassword").isString().notEmpty().withMessage("Current password is required"),
  body("newPassword").custom(isStrongPassword).withMessage(POLICY_MSG),
];

const createAdminValidation = [
  body("name").trim().isLength({ min: 2, max: 50 }).withMessage("Name must be 2-50 characters"),
  body("email").trim().isEmail().withMessage("Please enter a valid email").normalizeEmail(),
  body("password").custom(isStrongPassword).withMessage(POLICY_MSG),
  body("role").optional().isIn(["admin", "superadmin"]).withMessage("role must be admin or superadmin"),
];

const activeFlag = body("isActive").isBoolean({ strict: true }).withMessage("isActive must be true or false");

const adminStatusValidation = [idParam, activeFlag];

const userStatusValidation = [
  idParam,
  activeFlag,
  body("reason").optional({ values: "null" }).isString().trim().isLength({ max: 200 }).withMessage("reason must be at most 200 characters"),
  body("reason").custom((value, { req }) => req.body.isActive !== false || (typeof value === "string" && value.trim().length >= 3))
    .withMessage("A reason (min 3 characters) is required to block a user"),
];

const coinAdjustValidation = [
  idParam,
  body("type").isIn(["credit", "debit"]).withMessage("type must be credit or debit"),
  body("amount")
    .isInt({ min: 1, max: config.admin.maxCoinAdjust })
    .withMessage(`amount must be a whole number between 1 and ${config.admin.maxCoinAdjust}`)
    .bail()
    .toInt(),
  body("reason").isString().trim().isLength({ min: 3, max: 200 }).withMessage("reason is required (3-200 characters)"),
  body("idempotencyKey").optional().matches(/^[\w-]{8,64}$/).withMessage("idempotencyKey must be 8-64 chars (letters, digits, - _)"),
];

const bannerRules = (partial) => {
  const opt = (chain) => (partial ? chain.optional() : chain);
  return [
    opt(body("title")).trim().isLength({ min: 2, max: 80 }).withMessage("title must be 2-80 characters"),
    body("subtitle").optional({ values: "null" }).isString().trim().isLength({ max: 200 }),
    opt(body("imageUrl")).isURL({ protocols: ["https"], require_protocol: true }).withMessage("imageUrl must be an https URL").isLength({ max: 500 }),
    body("linkUrl").optional({ values: "falsy" }).isURL({ protocols: ["https"], require_protocol: true }).withMessage("linkUrl must be an https URL"),
    body("type").optional().isIn(["banner", "event"]),
    body("startsAt").optional({ values: "null" }).isISO8601().withMessage("startsAt must be an ISO date"),
    body("endsAt").optional({ values: "null" }).isISO8601().withMessage("endsAt must be an ISO date"),
    body("isActive").optional().isBoolean({ strict: true }),
    body("priority").optional().isInt({ min: 0, max: 100 }).toInt(),
    body("endsAt").custom((v, { req }) => !v || !req.body.startsAt || new Date(v) > new Date(req.body.startsAt)).withMessage("endsAt must be after startsAt"),
  ];
};
const bannerCreateValidation = bannerRules(false);
const bannerUpdateValidation = [idParam, ...bannerRules(true)];

const ticketReplyValidation = [idParam, body("message").isString().trim().isLength({ min: 1, max: 2000 }).withMessage("message must be 1-2000 characters")];
const ticketStatusValidation = [
  idParam,
  body("status").optional().isIn(["open", "in_progress", "resolved", "closed"]),
  body("priority").optional().isIn(["low", "normal", "high"]),
  body().custom((v) => v && (v.status || v.priority)).withMessage("Provide status and/or priority"),
];

module.exports = {
  validateRequest,
  isStrongPassword,
  idParam,
  listQuery,
  adminLoginValidation,
  changePasswordValidation,
  createAdminValidation,
  adminStatusValidation,
  userStatusValidation,
  coinAdjustValidation,
  bannerCreateValidation,
  bannerUpdateValidation,
  ticketReplyValidation,
  ticketStatusValidation,
};
