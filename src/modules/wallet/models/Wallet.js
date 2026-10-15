const mongoose = require("mongoose");

const walletSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User reference is required"],
      unique: true,
      index: true,
    },
    balance: {
      type: Number,
      required: [true, "Balance is required"],
      default: 0,
      min: [0, "Wallet balance cannot be negative"],
      validate: {
        validator: function (val) {
          return Number.isFinite(val) && val >= 0;
        },
        message: "Balance must be a non-negative finite number",
      },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Wallet", walletSchema);
