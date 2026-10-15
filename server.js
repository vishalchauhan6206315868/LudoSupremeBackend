"use strict";

const http = require("http");
const config = require("./config/env"); // validates env first; exits with a clear message if invalid
const logger = require("./utils/logger");
const app = require("./app");
const connectDB = require("./config/db");
const { disconnectDB } = require("./config/db");
const { seedDefaultRewards } = require("./src/modules/rewards/controllers/reward.controller");
const { seedDevelopmentAdmin } = require("./src/modules/admin/seed/development-admin.seed");
const sweeper = require("./jobs/matchSweeper");
const Admin = require("./src/modules/admin/models/admin.model");

let server;
let stopSweeper = () => {};
let shuttingDown = false;

const startServer = async () => {
  await connectDB();
  await seedDefaultRewards();
  if (config.env === "development") {
    await seedDevelopmentAdmin();
  }

  if (config.isProd) {
    const origins = config.cors.origins;
    if (origins.length === 0 || origins.some((o) => /example\.com/i.test(o))) {
      logger.warn("cors_not_configured", {
        hint: "Set CLIENT_URL to your real web origin if the admin panel runs as Flutter Web. Mobile/desktop apps are not affected by CORS.",
      });
    }
    if ((await Admin.countDocuments({ role: "superadmin", isActive: true })) === 0) {
      logger.warn("no_superadmin", {
        hint: "Create one: ADMIN_EMAIL=you@x.com ADMIN_PASSWORD='...' node scripts/create-admin.js",
      });
    }
  }

  server = http.createServer(app);

  // Safe defaults for running behind a load balancer / reverse proxy.
  server.keepAliveTimeout = 65_000; // must be > the proxy's idle timeout (AWS ALB = 60s)
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  logger.info("server_started", { port: config.port, env: config.env });

  if (config.game.sweeperEnabled) {
    stopSweeper = sweeper.start();
  }
};

// Stop accepting new connections, let in-flight requests finish, then close the DB.
const shutdown = async (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown_started", { signal });

  const force = setTimeout(() => {
    logger.error("shutdown_forced");
    process.exit(1);
  }, 10_000);
  force.unref();

  try {
    stopSweeper();
    if (server) await new Promise((resolve) => server.close(resolve));
    await disconnectDB();
    logger.info("shutdown_complete");
    process.exit(exitCode);
  } catch (error) {
    logger.error("shutdown_error", { err: error });
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", { err: reason });
  shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (error) => {
  logger.error("uncaught_exception", { err: error });
  shutdown("uncaughtException", 1);
});

startServer().catch((error) => {
  logger.error("startup_failed", { err: error });
  process.exit(1);
});
