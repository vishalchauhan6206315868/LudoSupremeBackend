"use strict";

const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const BCRYPT_ROUNDS = 12;

const adminSchema = new mongoose.Schema(
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
      required: true,
      minlength: 6,
      maxlength: 72,
      select: false,
    },
    role: {
      type: String,
      // admin      = day-to-day operations (users, games, support, banners)
      // superadmin = also money (coin adjustments), admin management, audit logs
      enum: ["admin", "superadmin"],
      default: "admin",
    },
    avatar: {
      type: String,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastLogin: {
      type: Date,
      default: null,
    },
    // Every token issued before this moment is rejected (password change / "log out everywhere").
    tokensValidAfter: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.password;
        delete ret.__v;
        return ret;
      },
    },
    toObject: {
      transform(_doc, ret) {
        delete ret.password;
        delete ret.__v;
        return ret;
      },
    },
  }
);

adminSchema.pre("save", async function hashPassword() {
  if (this.isModified("password")) {
    this.password = await bcrypt.hash(this.password, BCRYPT_ROUNDS);
  }
});

module.exports = mongoose.model("Admin", adminSchema);
