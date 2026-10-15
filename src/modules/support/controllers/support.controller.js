"use strict";

const crypto = require("crypto");
const { body, param } = require("express-validator");
const AppError = require("../../../../utils/AppError");
const asyncHandler = require("../../../../utils/asyncHandler");
const { qs, parsePagination, pageMeta, escapeRegex } = require("../../../../utils/adminHelpers");
require("../../auth/models/User"); // registers the model used by populate("user")
const SupportTicket = require("../models/SupportTicket");
const audit = require("../../admin/services/audit.service");
const { clearDashboardCache } = require("../../admin/services/stats.service");

const MAX_OPEN_PER_USER = 5;
const MAX_REPLIES = 100;

const newTicketNo = () => `TKT-${crypto.randomInt(100000, 1000000)}`;

const userView = (t) => ({
  id: t._id, ticketNo: t.ticketNo, subject: t.subject, message: t.message, category: t.category,
  status: t.status, replies: t.replies, createdAt: t.createdAt, updatedAt: t.updatedAt,
});

// ======================== player side (/api/support) ========================
const createTicketValidation = [
  body("subject").isString().trim().isLength({ min: 3, max: 120 }).withMessage("subject must be 3-120 characters"),
  body("message").isString().trim().isLength({ min: 5, max: 2000 }).withMessage("message must be 5-2000 characters"),
  body("category").optional().isIn(["payment", "game", "account", "bug", "other"]),
];
const userReplyValidation = [
  param("id").isMongoId(),
  body("message").isString().trim().isLength({ min: 1, max: 2000 }).withMessage("message must be 1-2000 characters"),
];

const createTicket = asyncHandler(async (req, res) => {
  const open = await SupportTicket.countDocuments({ user: req.user._id, status: { $in: ["open", "in_progress"] } });
  if (open >= MAX_OPEN_PER_USER) {
    throw new AppError("You already have several open tickets. Please wait for a reply.", 429);
  }
  let ticket;
  for (let attempt = 0; attempt < 5 && !ticket; attempt++) {
    try {
      ticket = await SupportTicket.create({
        ticketNo: newTicketNo(), user: req.user._id,
        subject: req.body.subject, message: req.body.message, category: req.body.category || "other",
      });
    } catch (e) {
      if (e.code !== 11000) throw e; // ticket number collision -> try another one
    }
  }
  if (!ticket) throw new AppError("Could not create the ticket. Please try again.", 503);
  clearDashboardCache();
  res.status(201).json({ success: true, data: { ticket: userView(ticket) } });
});

const myTickets = asyncHandler(async (req, res) => {
  const tickets = await SupportTicket.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(30).lean();
  res.json({ success: true, data: { tickets: tickets.map(userView) } });
});

const userReply = asyncHandler(async (req, res) => {
  const ticket = await SupportTicket.findOne({ _id: req.params.id, user: req.user._id });
  if (!ticket) throw new AppError("Ticket not found", 404);
  if (ticket.status === "closed") throw new AppError("This ticket is closed", 409);
  if (ticket.replies.length >= MAX_REPLIES) throw new AppError("This ticket has too many replies", 409);
  ticket.replies.push({ authorType: "user", authorId: req.user._id, message: req.body.message });
  if (ticket.status !== "open") ticket.status = "open"; // customer answered -> back in the admin queue
  await ticket.save();
  res.status(201).json({ success: true, data: { ticket: userView(ticket) } });
});

// ======================== admin side (/api/admin/support) ========================
const adminView = (t) => ({
  id: t._id, ticketNo: t.ticketNo, subject: t.subject, message: t.message, category: t.category,
  status: t.status, priority: t.priority, replyCount: (t.replies || []).length,
  user: t.user && t.user._id ? { id: t.user._id, name: t.user.name, email: t.user.email } : null,
  createdAt: t.createdAt, updatedAt: t.updatedAt,
});

// GET /api/admin/support/tickets?page&limit&status&priority&category&ticketNo
const listTickets = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  const status = qs(req.query.status);
  if (["open", "in_progress", "resolved", "closed"].includes(status)) filter.status = status;
  const priority = qs(req.query.priority);
  if (["low", "normal", "high"].includes(priority)) filter.priority = priority;
  const category = qs(req.query.category);
  if (["payment", "game", "account", "bug", "other"].includes(category)) filter.category = category;
  const no = qs(req.query.ticketNo).trim().toUpperCase().slice(0, 14);
  if (no) filter.ticketNo = new RegExp(`^${escapeRegex(no)}`);

  const [total, tickets] = await Promise.all([
    SupportTicket.countDocuments(filter),
    SupportTicket.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("user", "name email").lean(),
  ]);
  res.json({ success: true, data: { tickets: tickets.map(adminView), pagination: pageMeta(page, limit, total) } });
});

const getTicket = asyncHandler(async (req, res) => {
  const t = await SupportTicket.findById(req.params.id).populate("user", "name email").lean();
  if (!t) throw new AppError("Ticket not found", 404);
  res.json({ success: true, data: { ticket: { ...adminView(t), replies: t.replies } } });
});

const replyTicket = asyncHandler(async (req, res) => {
  const t = await SupportTicket.findById(req.params.id);
  if (!t) throw new AppError("Ticket not found", 404);
  if (t.status === "closed") throw new AppError("This ticket is closed", 409);
  if (t.replies.length >= MAX_REPLIES) throw new AppError("This ticket has too many replies", 409);
  t.replies.push({ authorType: "admin", authorId: req.admin._id, message: req.body.message });
  if (t.status === "open") t.status = "in_progress";
  await t.save();
  clearDashboardCache();
  await audit.record(req, "ticket.reply", { targetType: "ticket", targetId: t._id, meta: { ticketNo: t.ticketNo } });
  res.status(201).json({ success: true, data: { ticket: { ...adminView(t.toObject()), replies: t.replies } } });
});

const setTicketStatus = asyncHandler(async (req, res) => {
  const patch = {};
  if (req.body.status) patch.status = req.body.status;
  if (req.body.priority) patch.priority = req.body.priority;
  const t = await SupportTicket.findByIdAndUpdate(req.params.id, { $set: patch }, { returnDocument: "after", runValidators: true }).populate("user", "name email").lean();
  if (!t) throw new AppError("Ticket not found", 404);
  clearDashboardCache();
  await audit.record(req, "ticket.update", { targetType: "ticket", targetId: t._id, meta: { ticketNo: t.ticketNo, ...patch } });
  res.json({ success: true, data: { ticket: adminView(t) } });
});

module.exports = {
  createTicketValidation, userReplyValidation, createTicket, myTickets, userReply,
  listTickets, getTicket, replyTicket, setTicketStatus,
};
