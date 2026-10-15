"use strict";

const crypto = require("crypto");
const logger = require("../utils/logger");

// Adds a request id (also returned as X-Request-Id so a user can quote it in a bug report)
// and logs one line per finished request. Query strings and bodies are never logged.
module.exports = (req, res, next) => {
  const incoming = req.headers["x-request-id"];
  req.id =
    typeof incoming === "string" && /^[\w-]{8,64}$/.test(incoming)
      ? incoming
      : crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);

  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const path = req.originalUrl.split("?")[0];
    if (path === "/health" || path === "/api/health") return; // keep logs quiet for probes
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger[level]("request", {
      requestId: req.id,
      method: req.method,
      path,
      status: res.statusCode,
      ms: Math.round(ms),
      userId: req.user ? String(req.user._id) : undefined,
      ip: req.ip,
    });
  });

  next();
};
