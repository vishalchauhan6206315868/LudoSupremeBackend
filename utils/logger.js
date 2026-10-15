"use strict";

/**
 * Tiny dependency-free structured logger.
 * Production: one JSON object per line (works with Docker/CloudWatch/Datadog).
 * Development: readable single-line output.
 * NEVER pass passwords, tokens or full request bodies into these calls.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const isProd = process.env.NODE_ENV === "production";
const threshold = () =>
  LEVELS[process.env.LOG_LEVEL || (isProd ? "info" : "debug")] ?? LEVELS.info;

const serializeError = (err) =>
  err instanceof Error
    ? { name: err.name, message: err.message, code: err.code, stack: isProd ? undefined : err.stack }
    : err;

const write = (level, message, meta = {}) => {
  if (LEVELS[level] > threshold()) return;
  if (process.env.NODE_ENV === "test" && !process.env.LOG_IN_TESTS) return;

  const safeMeta = { ...meta };
  if (safeMeta.err) safeMeta.err = serializeError(safeMeta.err);

  const entry = { time: new Date().toISOString(), level, message, ...safeMeta };
  const line = isProd
    ? JSON.stringify(entry)
    : `${entry.time} ${level.toUpperCase().padEnd(5)} ${message}${
        Object.keys(safeMeta).length ? " " + JSON.stringify(safeMeta) : ""
      }`;

  (level === "error" ? process.stderr : process.stdout).write(line + "\n");
};

module.exports = {
  error: (m, meta) => write("error", m, meta),
  warn: (m, meta) => write("warn", m, meta),
  info: (m, meta) => write("info", m, meta),
  debug: (m, meta) => write("debug", m, meta),
};
