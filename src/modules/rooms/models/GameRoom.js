const mongoose = require("mongoose");

const playerSlotSchema = new mongoose.Schema(
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
    isReady: {
      type: Boolean,
      default: true,
    },
    isHost: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const gameRoomSchema = new mongoose.Schema(
  {
    // Unique 6-character Room Code
    roomCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      minlength: 6,
      maxlength: 6,
      index: true,
    },

    // Room Host
    host: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Players inside the room with seat & color
    players: [playerSlotSchema],

    // Maximum Players allowed
    maxPlayers: {
      type: Number,
      required: true,
      enum: [2, 4],
      default: 2,
    },

    // Game Mode
    gameMode: {
      type: String,
      required: true,
      enum: ["twoPlayer", "fourPlayer"],
      default: "twoPlayer",
    },

    // Entry Fee in Coins
    entryFee: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Total Prize Pool for the Winner
    prizePool: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Room Status
    status: {
      type: String,
      enum: ["waiting", "starting", "playing", "finished", "cancelled"],
      default: "waiting",
    },
  },
  {
    timestamps: true,
  }
);

// "Which active room is this user in?" and the stale-room cleanup job.
gameRoomSchema.index({ "players.user": 1, status: 1 });
gameRoomSchema.index({ status: 1, updatedAt: 1 });

module.exports = mongoose.model("GameRoom", gameRoomSchema);