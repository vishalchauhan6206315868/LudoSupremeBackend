const mongoose = require("mongoose");

const tokenSchema = new mongoose.Schema(
  {
    tokenId: {
      type: Number,
      required: true,
      min: 0,
      max: 3,
    },
    // Step on player's track: 0 = Starting tile, 1..55 = Path, 56 = Home
    step: {
      type: Number,
      default: 0,
      min: 0,
      max: 56,
    },
    isHome: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const gamePlayerSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    avatar: {
      type: String,
      default: "",
    },
    seatIndex: {
      type: Number,
      required: true,
      min: 0,
      max: 3,
    },
    color: {
      type: String,
      required: true,
      enum: ["Red", "Green", "Yellow", "Blue"],
    },
    score: {
      type: Number,
      default: 0,
      min: 0,
    },
    tokens: {
      type: [tokenSchema],
      default: [
        { tokenId: 0, step: 0, isHome: false },
        { tokenId: 1, step: 0, isHome: false },
        { tokenId: 2, step: 0, isHome: false },
        { tokenId: 3, step: 0, isHome: false },
      ],
    },
    missedTurns: {
      type: Number,
      default: 0,
      min: 0,
    },
    hasSurrendered: {
      type: Boolean,
      default: false,
    },
    rank: {
      type: Number,
      default: null,
    },
    prizeEarned: {
      type: Number,
      default: 0,
    },
    outcome: {
      type: String,
      enum: ["win", "loss", "draw", null],
      default: null,
    },
  },
  { _id: false }
);

const moveLogSchema = new mongoose.Schema(
  {
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    action: {
      type: String,
      enum: ["ROLL", "MOVE", "PASS", "TIMEOUT", "SURRENDER"],
      required: true,
    },
    diceValue: {
      type: Number,
      min: 1,
      max: 6,
    },
    tokenId: {
      type: Number,
      min: 0,
      max: 3,
    },
    prevStep: Number,
    newStep: Number,
    pointsEarned: {
      type: Number,
      default: 0,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const gameSessionSchema = new mongoose.Schema(
  {
    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GameRoom",
      required: true,
    },
    roomCode: {
      type: String,
      required: true,
      uppercase: true,
      index: true,
    },
    gameMode: {
      type: String,
      enum: ["twoPlayer", "fourPlayer"],
      default: "twoPlayer",
    },
    entryFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    prizePool: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ["in_progress", "completed", "abandoned"],
      default: "in_progress",
      index: true,
    },
    matchDurationSeconds: {
      type: Number,
      default: 600, // 10 minutes default
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    endedAt: {
      type: Date,
      default: null,
    },

    // Turn control
    currentTurnPlayer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    currentTurnSeat: {
      type: Number,
      required: true,
      default: 0,
    },
    turnStatus: {
      type: String,
      enum: ["WAITING_FOR_ROLL", "WAITING_FOR_MOVE", "TURN_COMPLETED"],
      default: "WAITING_FOR_ROLL",
    },
    lastDiceValue: {
      type: Number,
      min: 1,
      max: 6,
      default: null,
    },
    consecutiveSixes: {
      type: Number,
      default: 0,
    },
    turnDeadline: {
      type: Date,
    },

    // Players list with board state & scores
    players: [gamePlayerSchema],

    // Winner & settlement
    winner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    isPrizeDistributed: {
      type: Boolean,
      default: false,
    },
    // Set atomically when a match is closed; lets a crashed settlement be recomputed + resumed.
    settlement: {
      reason: { type: String, default: null }, // time_up | all_tokens_home | forfeit | ...
      forcedWinner: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    // Flipped exactly once so user / leaderboard stats can never be counted twice.
    statsApplied: {
      type: Boolean,
      default: false,
    },

    // Move audit trail
    history: [moveLogSchema],
  },
  {
    timestamps: true,
    // save() fails with VersionError if someone else changed the document meanwhile.
    // Prevents two parallel requests (double-tap, retry, sweeper) from corrupting a turn.
    optimisticConcurrency: true,
  }
);

// One live session per room, enforced by the database.
gameSessionSchema.index(
  { room: 1 },
  { unique: true, partialFilterExpression: { status: "in_progress" } }
);
// Sweeper: find overdue turns / matches quickly.
gameSessionSchema.index({ status: 1, turnDeadline: 1 });
// Admin dashboard / reports
gameSessionSchema.index({ createdAt: -1 });
gameSessionSchema.index({ status: 1, isPrizeDistributed: 1, endedAt: -1 });
gameSessionSchema.index({ status: 1, startedAt: 1 });
// Match history per player.
gameSessionSchema.index({ "players.user": 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("GameSession", gameSessionSchema);
