
const express = require("express");

const router = express.Router();

const { protect } = require("../../../../middleware/auth.middleware");

const {
  getMyProfile,
} = require("../controllers/user.controller");

// Get Logged-in User Profile
router.get("/me", protect, getMyProfile);

module.exports = router;