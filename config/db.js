"use strict";

const mongoose = require("mongoose");
const config = require("./env");
const logger = require("../utils/logger");

mongoose.set("strictQuery", true);

let listenersAttached = false;
const attachListeners = () => {
  if (listenersAttached) return;
  listenersAttached = true;
  mongoose.connection.on("disconnected", () => logger.warn("mongodb_disconnected"));
  mongoose.connection.on("reconnected", () => logger.info("mongodb_reconnected"));
  mongoose.connection.on("error", (err) => logger.error("mongodb_error", { err }));
};

/**
 * Wallet / entry-fee / prize logic uses multi-document transactions, which MongoDB only
 * supports on a replica set (MongoDB Atlas is always one). On a standalone server the code
 * falls back to single-document atomic operations, which is fine for development but NOT
 * what you want for real money flows.
 */
const isReplicaSet = async () => {
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  return Boolean(hello.setName) || hello.msg === "isdbgrid"; // replica set or mongos
};

const connectDB = async () => {
  attachListeners();

  await mongoose.connect(config.db.uri, {
    maxPoolSize: config.db.maxPoolSize,
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    autoIndex: config.db.autoIndex,
    retryWrites: true,
  });

  logger.info("mongodb_connected", { host: mongoose.connection.host, name: mongoose.connection.name });

  const replicaSet = await isReplicaSet();
  if (!replicaSet) {
    const msg =
      "MongoDB is a standalone server (no replica set): multi-document transactions are unavailable.";
    if (config.db.requireReplicaSet) {
      throw new Error(`${msg} Use MongoDB Atlas / a replica set, or set REQUIRE_REPLICA_SET=false (not recommended).`);
    }
    logger.warn(`${msg} Wallet operations fall back to single-document atomic updates.`);
  }
};

const disconnectDB = async () => {
  await mongoose.connection.close(false);
};

module.exports = connectDB;
module.exports.disconnectDB = disconnectDB;
