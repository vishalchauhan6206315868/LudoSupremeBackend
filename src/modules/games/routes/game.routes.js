const express = require("express");
const router = express.Router();

const { protect } = require("../../../../middleware/auth.middleware");
const { gameActionLimiter } = require("../../../../middleware/rateLimit.middleware");

const {
  startGameSession,
  getGameSession,
  rollDice,
  moveToken,
  handleTurnTimeout,
  surrenderMatch,
  completeGameSession,
  getMyGameHistory,
} = require("../controllers/game.controller");

const {
  validateRequest,
  startGameValidation,
  sessionIdParamValidation,
  moveTokenValidation,
  historyQueryValidation,
} = require("../validations/game.validation");

// ==========================================
// 1. Start / Initialize Game Session
// ==========================================
router.post(
  "/start",
  protect,
  startGameValidation,
  validateRequest,
  startGameSession
);

// ==========================================
// 2. Get Player Match History
// (Placed before :sessionId to avoid routing conflict)
// ==========================================
router.get(
  "/history/my-games",
  protect,
  historyQueryValidation,
  validateRequest,
  getMyGameHistory
);

// ==========================================
// 3. Get Active Game Session Live State
// ==========================================
router.get(
  "/session/:sessionId",
  protect,
  sessionIdParamValidation,
  validateRequest,
  getGameSession
);

// ==========================================
// 4. Roll Dice
// ==========================================
router.post(
  "/session/:sessionId/roll-dice",
  protect,
  gameActionLimiter,
  sessionIdParamValidation,
  validateRequest,
  rollDice
);

// ==========================================
// 5. Move Token & Update Score
// ==========================================
router.post(
  "/session/:sessionId/move-token",
  protect,
  gameActionLimiter,
  moveTokenValidation,
  validateRequest,
  moveToken
);

// ==========================================
// 6. Handle Turn Timeout
// ==========================================
router.post(
  "/session/:sessionId/timeout",
  protect,
  gameActionLimiter,
  sessionIdParamValidation,
  validateRequest,
  handleTurnTimeout
);

// ==========================================
// 7. Surrender / Forfeit Match
// ==========================================
router.post(
  "/session/:sessionId/surrender",
  protect,
  sessionIdParamValidation,
  validateRequest,
  surrenderMatch
);

// ==========================================
// 8. Complete & Settle Match
// ==========================================
router.post(
  "/session/:sessionId/complete",
  protect,
  sessionIdParamValidation,
  validateRequest,
  completeGameSession
);

module.exports = router;
