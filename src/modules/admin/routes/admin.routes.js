"use strict";

const express = require("express");
const {
  adminLoginLimiter, adminIpLimiter, adminWriteLimiter, adminRefreshLimiter,
} = require("../../../../middleware/rateLimit.middleware");
const { protectAdmin, requireSuperAdmin } = require("../../../../middleware/admin.middleware");
const v = require("../validations/admin.validation");
const adminCtl = require("../controllers/admin.controller");
const dashboardCtl = require("../controllers/dashboard.controller");
const usersCtl = require("../controllers/users.controller");
const gamesCtl = require("../controllers/games.controller");
const economyCtl = require("../controllers/economy.controller");
const contentCtl = require("../controllers/content.controller");
const supportCtl = require("../../support/controllers/support.controller");

const router = express.Router();
const { qs } = require("../../../../utils/adminHelpers");
// Only ?refresh=1 (cache bypass) is limited; normal cached reads are not.
const refreshGuard = (req, res, next) => (qs(req.query.refresh) === "1" ? adminRefreshLimiter(req, res, next) : next());
const check = v.validateRequest;

// ---- public --------------------------------------------------------------------------------
router.post("/login", adminIpLimiter, adminLoginLimiter, v.adminLoginValidation, check, adminCtl.loginAdmin);

// ---- everything below needs a valid admin token ---------------------------------------------
router.use(protectAdmin);

router.get("/me", adminCtl.getMe);
router.post("/change-password", adminWriteLimiter, v.changePasswordValidation, check, adminCtl.changePassword);
router.post("/logout-all", adminWriteLimiter, adminCtl.logoutAll);

router.get("/dashboard", refreshGuard, dashboardCtl.getDashboard);
router.get("/settings", contentCtl.getSettings);

// Users
router.get("/users", v.listQuery, check, usersCtl.listUsers);
router.get("/users/:id", v.idParam, check, usersCtl.getUser);
router.patch("/users/:id/status", adminWriteLimiter, v.userStatusValidation, check, usersCtl.setUserStatus);
router.post("/users/:id/coins", requireSuperAdmin, adminWriteLimiter, v.coinAdjustValidation, check, usersCtl.adjustCoins);

// Games
router.get("/games", v.listQuery, check, gamesCtl.listGames);
router.get("/games/:id", v.idParam, check, gamesCtl.getGame);

// Coins & economy, reports
router.get("/transactions", v.listQuery, check, economyCtl.listTransactions);
router.get("/economy/summary", economyCtl.economySummary);
router.get("/reports/daily", economyCtl.dailyReport);

// Banners & events
router.get("/banners", v.listQuery, check, contentCtl.listBanners);
router.post("/banners", adminWriteLimiter, v.bannerCreateValidation, check, contentCtl.createBanner);
router.patch("/banners/:id", adminWriteLimiter, v.bannerUpdateValidation, check, contentCtl.updateBanner);
router.delete("/banners/:id", adminWriteLimiter, v.idParam, check, contentCtl.deleteBanner);

// Support / complaints
router.get("/support/tickets", v.listQuery, check, supportCtl.listTickets);
router.get("/support/tickets/:id", v.idParam, check, supportCtl.getTicket);
router.post("/support/tickets/:id/reply", adminWriteLimiter, v.ticketReplyValidation, check, supportCtl.replyTicket);
router.patch("/support/tickets/:id/status", adminWriteLimiter, v.ticketStatusValidation, check, supportCtl.setTicketStatus);

// Super admin only
router.get("/audit-logs", requireSuperAdmin, v.listQuery, check, contentCtl.listAuditLogs);
router.get("/admins", requireSuperAdmin, v.listQuery, check, adminCtl.listAdmins);
router.post("/admins", requireSuperAdmin, adminWriteLimiter, v.createAdminValidation, check, adminCtl.createAdmin);
router.patch("/admins/:id/status", requireSuperAdmin, adminWriteLimiter, v.adminStatusValidation, check, adminCtl.setAdminStatus);

module.exports = router;
