"use strict";

const asyncHandler = require("../../../../utils/asyncHandler");
const gameService = require("../services/game.service");

// All business rules live in services/game.service.js and engine/ludoEngine.js.
// Controllers only translate HTTP <-> service calls.

// 1. Start / initialise a match
const startGameSession = asyncHandler(async (req, res) => {
  const roomCode = req.body.roomCode.trim().toUpperCase();
  const { session, created } = await gameService.startGame(req.user._id, roomCode);

  return res.status(created ? 201 : 200).json({
    success: true,
    message: created ? "Game session started successfully" : "Game session already in progress",
    data: { session },
  });
});

// 2. Live state / reconnect (participants only)
const getGameSession = asyncHandler(async (req, res) => {
  const { session, remainingTimeSeconds } = await gameService.getSession(
    req.user._id,
    req.params.sessionId
  );
  return res.status(200).json({ success: true, data: { session, remainingTimeSeconds } });
});

// 3. Roll dice
const rollDice = asyncHandler(async (req, res) => {
  const { message, data } = await gameService.rollDice(req.user._id, req.params.sessionId);
  return res.status(200).json({ success: true, message, data });
});

// 4. Move token
const moveToken = asyncHandler(async (req, res) => {
  const { message, data } = await gameService.moveToken(
    req.user._id,
    req.params.sessionId,
    req.body.tokenId
  );
  return res.status(200).json({ success: true, message, data });
});

// 5. Turn timeout
const handleTurnTimeout = asyncHandler(async (req, res) => {
  const { gameCompleted, session } = await gameService.handleTurnTimeout(
    req.user._id,
    req.params.sessionId
  );
  return res.status(200).json({
    success: true,
    message: gameCompleted
      ? "Game completed due to player forfeits / timeouts"
      : "Turn timed out and passed to next player",
    data: gameCompleted ? { session, gameCompleted: true } : { session },
  });
});

// 6. Surrender
const surrenderMatch = asyncHandler(async (req, res) => {
  const { gameCompleted, session } = await gameService.surrenderMatch(
    req.user._id,
    req.params.sessionId
  );
  return res.status(200).json({
    success: true,
    message: gameCompleted ? "Match surrendered and ended" : "You have surrendered the match",
    data: gameCompleted ? { session, gameCompleted: true } : { session },
  });
});

// 7. Complete (only once the match clock has really run out)
const completeGameSession = asyncHandler(async (req, res) => {
  const session = await gameService.completeMatch(req.user._id, req.params.sessionId);
  return res.status(200).json({
    success: true,
    message: "Game session completed and prize distributed",
    data: { session },
  });
});

// 8. History
const getMyGameHistory = asyncHandler(async (req, res) => {
  const data = await gameService.getHistory(req.user._id, req.query.page, req.query.limit);
  return res.status(200).json({ success: true, data });
});

module.exports = {
  startGameSession,
  getGameSession,
  rollDice,
  moveToken,
  handleTurnTimeout,
  surrenderMatch,
  completeGameSession,
  getMyGameHistory,
};
