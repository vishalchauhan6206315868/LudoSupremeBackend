"use strict";

const express = require("express");
const { protect } = require("../../../../middleware/auth.middleware");
const { createRateLimiter } = require("../../../../middleware/rateLimit.middleware");
const { validateRequest } = require("../../auth/validations/auth.validation");
const c = require("../controllers/support.controller");

const router = express.Router();

// Player side: a user cannot flood the admin queue.
const ticketLimiter = createRateLimiter({
  windowMs: 60 * 60_000,
  max: 10,
  keyGenerator: (req) => (req.user ? String(req.user._id) : req.ip),
  message: "Too many support requests. Please try again later.",
});

router.post("/tickets", protect, ticketLimiter, c.createTicketValidation, validateRequest, c.createTicket);
router.get("/tickets/mine", protect, c.myTickets);
router.post("/tickets/:id/reply", protect, ticketLimiter, c.userReplyValidation, validateRequest, c.userReply);

module.exports = router;
