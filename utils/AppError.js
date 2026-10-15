"use strict";

/**
 * Operational error: safe to show its message to the client.
 * Anything that is NOT an AppError is treated as a bug and returned as a generic 500.
 */
class AppError extends Error {
  constructor(message, status = 500, extra = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.isOperational = true;
    this.extra = extra; // optional safe fields merged into the response body
    Error.captureStackTrace?.(this, this.constructor);
  }
}

module.exports = AppError;
