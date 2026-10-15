"use strict";

const AppError = require("../../../../utils/AppError");
const asyncHandler = require("../../../../utils/asyncHandler");
const { qs, parsePagination, pageMeta, escapeRegex, dateRange } = require("../../../../utils/adminHelpers");
const GameSession = require("../../games/models/GameSession");
const { gameSummary, gameDetail } = require("../../../../utils/adminShapes");

const MODES = ["twoPlayer", "fourPlayer"];
const STATUSES = ["in_progress", "completed", "abandoned"];

// GET /api/admin/games?page&limit&status&mode&roomCode&userId&from&to
exports.listGames = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};

  const status = qs(req.query.status);
  if (STATUSES.includes(status)) filter.status = status;
  const mode = qs(req.query.mode);
  if (MODES.includes(mode)) filter.gameMode = mode;

  const code = qs(req.query.roomCode).trim().toUpperCase().slice(0, 12);
  if (code) filter.roomCode = new RegExp(`^${escapeRegex(code)}`);

  const userId = qs(req.query.userId);
  if (userId) filter["players.user"] = userId;

  const range = dateRange(req.query.from, req.query.to);
  if (range) filter.createdAt = range;

  const [total, games] = await Promise.all([
    GameSession.countDocuments(filter),
    GameSession.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .select("-history -players.tokens").lean(),
  ]);

  res.json({ success: true, data: { games: games.map(gameSummary), pagination: pageMeta(page, limit, total) } });
});

// GET /api/admin/games/:id   (full board state + the last 200 moves)
exports.getGame = asyncHandler(async (req, res) => {
  const game = await GameSession.findById(req.params.id, { history: { $slice: -200 } }).lean();
  if (!game) throw new AppError("Game not found", 404);
  res.json({ success: true, data: { game: gameDetail(game) } });
});
