"use strict";

const config = require("../config/env");

/**
 * Dependency-free fixed-window rate limiter (in-memory).
 *
 * Good for a single instance. If you run several instances behind a load balancer,
 * swap the store for Redis (e.g. `rate-limit-redis`) - the middleware signature stays the same.
 * Remember to set TRUST_PROXY so req.ip is the real client IP and not your proxy.
 */
const createRateLimiter = ({
  windowMs,
  max,
  message = "Too many requests. Please try again later.",
  keyGenerator = (req) => req.ip,
  skipSuccessfulRequests = false,
}) => {
  const hits = new Map(); // key -> { count, resetAt }

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.min(windowMs, 60_000));
  cleanup.unref();

  const middleware = (req, res, next) => {
    if (!config.rateLimit.enabled) return next();

    const key = keyGenerator(req);
    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);

    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil((entry.resetAt - now) / 1000)));

    if (skipSuccessfulRequests) {
      res.on("finish", () => {
        if (res.statusCode < 400 && entry.count > 0) entry.count -= 1;
      });
    }

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ success: false, message });
    }

    return next();
  };

  middleware.reset = () => hits.clear(); // for tests
  return middleware;
};

const rl = config.rateLimit;
const emailOf = (req) =>
  typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 100) : "";

module.exports = {
  createRateLimiter,

  // Whole API, per IP.
  globalLimiter: createRateLimiter({
    windowMs: 60_000,
    max: rl.globalPerMinute,
  }),

  // Login: per IP + email so one attacker cannot hammer one account,
  // and one shared NAT does not lock everybody out.
  // Only FAILED attempts count against the budget.
  loginLimiter: createRateLimiter({
    windowMs: rl.authWindowMinutes * 60_000,
    max: rl.authAttempts,
    keyGenerator: (req) => `${req.ip}|${emailOf(req)}`,
    skipSuccessfulRequests: true,
    message: "Too many login attempts. Please try again later.",
  }),

  // Admin login: stricter than player login. Per IP+email (failed attempts only) ...
  adminLoginLimiter: createRateLimiter({
    windowMs: rl.authWindowMinutes * 60_000,
    max: rl.adminAuthAttempts,
    keyGenerator: (req) => `admin|${req.ip}|${emailOf(req)}`,
    skipSuccessfulRequests: true,
    message: "Too many login attempts. Please try again later.",
  }),

  // ... and per IP only, so one attacker cannot spray many emails from one address.
  adminIpLimiter: createRateLimiter({
    windowMs: rl.authWindowMinutes * 60_000,
    max: rl.adminIpAttempts,
    keyGenerator: (req) => `admin-ip|${req.ip}`,
    skipSuccessfulRequests: true,
    message: "Too many login attempts. Please try again later.",
  }),

  // Every state-changing admin call (block user, coins, banners...), per admin.
  adminWriteLimiter: createRateLimiter({
    windowMs: 60_000,
    max: rl.adminWritesPerMinute,
    keyGenerator: (req) => `admin-write|${req.admin ? String(req.admin._id) : req.ip}`,
    message: "Too many admin actions. Please slow down.",
  }),

  // "Refresh" on the dashboard bypasses the cache and runs heavy aggregations: 1 per 10 s per admin.
  adminRefreshLimiter: createRateLimiter({
    windowMs: 10_000,
    max: 1,
    keyGenerator: (req) => `admin-refresh|${req.admin ? String(req.admin._id) : req.ip}`,
    message: "Dashboard was refreshed a moment ago. Please wait a few seconds.",
  }),

  // Registration: stops mass account creation from one IP.
  registerLimiter: createRateLimiter({
    windowMs: 60 * 60_000,
    max: rl.registerPerHour,
    message: "Too many accounts created from this network. Please try again later.",
  }),

  // Dice / move spam, per authenticated user.
  gameActionLimiter: createRateLimiter({
    windowMs: 60_000,
    max: rl.gameActionsPerMinute,
    keyGenerator: (req) => (req.user ? String(req.user._id) : req.ip),
  }),
};
