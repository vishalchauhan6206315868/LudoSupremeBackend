const express = require("express");

const router = express.Router();

const { protect } = require("../../../../middleware/auth.middleware");

const {
  createRoom,
  joinRoom,
  getRoomDetails,
  leaveRoom,
} = require("../controllers/room.controller");

const {
  validateRequest,
  createRoomValidation,
  joinRoomValidation,
  roomCodeParamValidation,
} = require("../validations/room.validation");

// ==========================
// 1. Create New Game Room
// ==========================
router.post(
  "/create",
  protect,
  createRoomValidation,
  validateRequest,
  createRoom
);

// ==========================
// 2. Join Game Room by Code
// ==========================
router.post(
  "/join",
  protect,
  joinRoomValidation,
  validateRequest,
  joinRoom
);

// ==========================
// 3. Leave / Cancel Game Room
// ==========================
router.post(
  "/leave",
  protect,
  joinRoomValidation,
  validateRequest,
  leaveRoom
);

// ==========================
// 4. Get Room Details
// ==========================
router.get(
  "/:roomCode",
  protect,
  roomCodeParamValidation,
  validateRequest,
  getRoomDetails
);

module.exports = router;