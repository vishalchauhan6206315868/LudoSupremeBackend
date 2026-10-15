
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: 2,
      maxlength: 50,
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email"],
    },

    password: {
      type: String,
      required: function () {
        return !this.googleId;
      },
      minlength: 8,
      select: false,
    },

    googleId: {
      type: String,
      unique: true,
      sparse: true,
    },

    avatar: {
      type: String,
      default: "",
    },

    username: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      minlength: 3,
      maxlength: 20,
    },

    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    lastLogin: {
      type: Date,
      default: null,
    },

    // DEPRECATED: legacy balance. The Wallet collection is the single source of truth for
    // coins now (see wallet.service.js). Kept only so old data can be migrated with
    // scripts/migrate-coins-to-wallet.js. Do not read or write this field in new code.
    coins: {
      type: Number,
      default: 0,
      min: 0,
    },

    gems: {
      type: Number,
      default: 10,
      min: 0,
    },

    experience: {
      type: Number,
      default: 0,
      min: 0,
    },

    level: {
      type: Number,
      default: 1,
      min: 1,
    },

    statistics: {
      totalGames: {
        type: Number,
        default: 0,
      },

      wins: {
        type: Number,
        default: 0,
      },

      losses: {
        type: Number,
        default: 0,
      },

      draws: {
        type: Number,
        default: 0,
      },
    },
  },
  {
    timestamps: true,
  }
);

userSchema.index({ role: 1 });
userSchema.index({ createdAt: -1 });
// Admin panel: sort=name and status filters (without these Mongo sorts in memory, which fails on big data).
userSchema.index({ name: 1 });
userSchema.index({ isActive: 1, createdAt: -1 });

module.exports = mongoose.model("User", userSchema);