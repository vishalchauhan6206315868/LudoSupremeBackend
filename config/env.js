"use strict";

/**
 * Central, validated configuration.
 * The app refuses to boot in production if something critical is missing or weak.
 */
require("dotenv").config();

const crypto = require("crypto");

const toInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const toNumber = (value, fallback) => {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toBool = (value, fallback) => {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const toList = (value) =>
  String(value || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);

const parseTrustProxy = (value) => {
  if (value === undefined || value === "") return false;
  const v = String(value).toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  const n = Number(v);
  return Number.isInteger(n) ? n : value; // e.g. "loopback" or a CIDR list
};

const WEAK_SECRET_HINTS = ["secret", "changeme", "change-me", "password", "ludo", "default", "12345"];

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const isProd = nodeEnv === "production";
  const isTest = nodeEnv === "test";
  const problems = [];

  // ---- JWT -------------------------------------------------------------
  let jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    if (isProd) {
      problems.push("JWT_SECRET is required in production");
    } else {
      // Dev/test convenience only: random per-process secret (tokens die on restart).
      jwtSecret = crypto.randomBytes(48).toString("hex");
    }
  } else if (isProd) {
    if (jwtSecret.length < 32) {
      problems.push("JWT_SECRET must be at least 32 characters in production");
    }
    const lowered = jwtSecret.toLowerCase();
    if (WEAK_SECRET_HINTS.some((hint) => lowered.includes(hint))) {
      problems.push("JWT_SECRET looks guessable (contains a common word). Generate a random one");
    }
  }

  // ---- Database --------------------------------------------------------
  const mongoUri = env.MONGO_URI;
  if (!mongoUri && !isTest) {
    problems.push("MONGO_URI is required");
  }

  const config = {
    env: nodeEnv,
    isProd,
    isTest,
    port: toInt(env.PORT, 4000),
    host: env.HOST || "0.0.0.0",
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logLevel: env.LOG_LEVEL || (isProd ? "info" : "debug"),

    jwt: {
      secret: jwtSecret,
      expiresIn: env.JWT_EXPIRES_IN || "7d",
      issuer: "ludo-supreme",
      algorithm: "HS256",
    },

    cors: {
      origins: toList(env.CLIENT_URL),
    },

    db: {
      uri: mongoUri,
      maxPoolSize: toInt(env.MONGO_MAX_POOL_SIZE, 20),
      autoIndex: toBool(env.MONGO_AUTO_INDEX, true),
      // Money movements use multi-document transactions => needs a replica set.
      requireReplicaSet: toBool(env.REQUIRE_REPLICA_SET, isProd),
    },

    rateLimit: {
      enabled: toBool(env.RATE_LIMIT_ENABLED, !isTest),
      globalPerMinute: toInt(env.RATE_LIMIT_GLOBAL_PER_MIN, 300),
      authAttempts: toInt(env.RATE_LIMIT_AUTH_ATTEMPTS, 10),
      authWindowMinutes: toInt(env.RATE_LIMIT_AUTH_WINDOW_MIN, 15),
      registerPerHour: toInt(env.RATE_LIMIT_REGISTER_PER_HOUR, 20),
      gameActionsPerMinute: toInt(env.RATE_LIMIT_GAME_PER_MIN, 90),
      adminAuthAttempts: toInt(env.RATE_LIMIT_ADMIN_AUTH_ATTEMPTS, 5),
      adminIpAttempts: toInt(env.RATE_LIMIT_ADMIN_IP_ATTEMPTS, 30),
      adminWritesPerMinute: toInt(env.RATE_LIMIT_ADMIN_WRITES_PER_MIN, 30),
    },

    admin: {
      // Admin sessions are deliberately shorter than player sessions.
      jwtExpiresIn: env.ADMIN_JWT_EXPIRES_IN || "8h",
      // Day buckets for dashboard / reports (IANA name, e.g. Asia/Kolkata).
      timezone: env.ADMIN_TIMEZONE || "Asia/Kolkata",
      dashboardCacheSeconds: toInt(env.ADMIN_DASHBOARD_CACHE_SECONDS, 30),
      // Hard cap for ONE manual coin credit/debit.
      maxCoinAdjust: toInt(env.ADMIN_MAX_COIN_ADJUST, 100000),
    },

    game: {
      turnTimeoutSeconds: toInt(env.TURN_TIMEOUT_SECONDS, 15),
      // Small cushion so a client that fires /timeout a hair early is not rejected.
      turnTimeoutGraceMs: toInt(env.TURN_TIMEOUT_GRACE_MS, 1000),
      matchDurationSeconds: toInt(env.MATCH_DURATION_SECONDS, 600),
      sweeperEnabled: toBool(env.ENABLE_SWEEPER, !isTest),
      sweeperIntervalMs: toInt(env.SWEEPER_INTERVAL_MS, 5000),
    },

    economy: {
      signupBonusCoins: toInt(env.SIGNUP_BONUS_COINS, 1000),
      maxEntryFee: toInt(env.MAX_ENTRY_FEE, 10000),
      // % of the prize pool kept by the platform. 0 = winner takes everything.
      platformFeePercent: toNumber(env.PLATFORM_FEE_PERCENT, 0),
      roomWaitingTtlMinutes: toInt(env.ROOM_WAITING_TTL_MIN, 30),
    },
  };

  if (config.economy.platformFeePercent < 0 || config.economy.platformFeePercent > 50) {
    problems.push("PLATFORM_FEE_PERCENT must be between 0 and 50");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: config.admin.timezone });
  } catch (_e) {
    problems.push(`ADMIN_TIMEZONE "${config.admin.timezone}" is not a valid IANA time zone`);
  }
  if (config.admin.maxCoinAdjust < 1) {
    problems.push("ADMIN_MAX_COIN_ADJUST must be >= 1");
  }
  if (config.game.turnTimeoutSeconds < 5) {
    problems.push("TURN_TIMEOUT_SECONDS must be >= 5");
  }

  if (problems.length > 0) {
    const error = new Error(
      `Invalid environment configuration:\n - ${problems.join("\n - ")}`
    );
    error.code = "INVALID_CONFIG";
    throw error;
  }

  return config;
}

module.exports = loadConfig();
module.exports.loadConfig = loadConfig;
