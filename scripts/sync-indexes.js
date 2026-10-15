"use strict";

/**
 * Creates/updates all MongoDB indexes declared in the models.
 * Run after deploying if you set MONGO_AUTO_INDEX=false:  node scripts/sync-indexes.js
 *
 * IMPORTANT for existing databases: the new unique indexes (one live session per room,
 * wallet transaction idempotency) will fail to build if duplicate rows already exist.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const models = [
  "../src/modules/auth/models/User",
  "../src/modules/wallet/models/Wallet",
  "../src/modules/wallet/models/WalletTransaction",
  "../src/modules/rooms/models/GameRoom",
  "../src/modules/games/models/GameSession",
  "../src/modules/leaderboard/models/LeaderboardStats",
  "../src/modules/rewards/models/Reward",
  "../src/modules/rewards/models/RewardClaim",
];

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  for (const path of models) {
    const Model = require(path);
    const created = await Model.syncIndexes();
    console.log(`${Model.modelName}: indexes synced`, created.length ? `(dropped: ${created.join(", ")})` : "");
  }
  await mongoose.disconnect();
})().catch((error) => {
  console.error("Index sync failed:", error.message);
  process.exit(1);
});
