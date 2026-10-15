"use strict";

/**
 * One-time migration for databases that already contain users from the OLD code,
 * where coins lived in users.coins. The wallet ledger is now the only source of truth.
 *
 *   1. STOP the API (so nobody spends coins while this runs).
 *   2. node scripts/migrate-coins-to-wallet.js --dry-run     (see what would happen)
 *   3. node scripts/migrate-coins-to-wallet.js               (do it)
 *
 * Safe to run more than once: the wallet credit is idempotent (referenceId migrate-coins:<userId>).
 * A brand-new database does not need this.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../src/modules/auth/models/User");
const walletService = require("../src/modules/wallet/services/wallet.service");

const dryRun = process.argv.includes("--dry-run");

(async () => {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");
  await mongoose.connect(process.env.MONGO_URI);

  const cursor = User.find({ coins: { $gt: 0 } }).select("coins email").cursor();
  let migrated = 0;
  let total = 0;

  for await (const user of cursor) {
    const coins = Math.floor(user.coins);
    if (coins <= 0) continue;
    total += coins;

    if (dryRun) {
      console.log(`[dry-run] ${user.email}: ${coins} coins -> wallet`);
      continue;
    }

    await walletService.creditWallet(
      user._id,
      coins,
      "other",
      "Migrated legacy coins balance",
      `migrate-coins:${user._id}`
    );
    // Zero the legacy field only after the ledger entry exists.
    await User.updateOne({ _id: user._id, coins: user.coins }, { $set: { coins: 0 } });
    migrated += 1;
  }

  console.log(dryRun ? `Dry run: ${total} coins would be moved.` : `Migrated ${migrated} users (${total} coins).`);
  await mongoose.disconnect();
})().catch((error) => {
  console.error("Migration failed:", error.message);
  process.exit(1);
});
