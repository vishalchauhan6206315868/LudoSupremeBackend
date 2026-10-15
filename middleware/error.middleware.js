"use strict";

const logger = require("../utils/logger");

/**
 * Single place that turns any error into a safe JSON response.
 * Clients only ever see messages from AppError / known validation problems.
 * Internal messages (DB errors, stack traces) are logged, never returned.
 */
// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  let status = 500;
  let message = "Internal Server Error";
  let extra = {};

  if (err && err.isOperational) {
    status = err.status;
    message = err.message;
    extra = err.extra || {};
  } else if (err && err.name === "ValidationError") {
    status = 400;
    message = "Validation failed";
  } else if (err && err.name === "CastError") {
    status = 400;
    message = "Invalid identifier format";
  } else if (err && err.name === "VersionError") {
    // Two requests tried to change the same game at once (optimistic concurrency).
    status = 409;
    message = "The game state just changed. Please refresh and try again.";
  } else if (err && err.code === 50) {
    // MongoDB MaxTimeMSExpired: a search that would scan too much data.
    status = 503;
    message = "The query took too long. Please narrow your search and try again.";
  } else if (err && err.code === 11000) {
    status = 409;
    message = "This record already exists";
  } else if (err && (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError")) {
    status = 401;
    message = "Invalid or expired token. Please login again.";
  } else if (err && err.type === "entity.too.large") {
    status = 413;
    message = "Request body too large";
  } else if (err && err.type === "entity.parse.failed") {
    status = 400;
    message = "Malformed JSON body";
  } else if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    status = err.status;
    message = err.message || "Bad request";
  }

  if (status >= 500) {
    logger.error("unhandled_error", { requestId: req.id, path: req.originalUrl.split("?")[0], err });
  }

  if (res.headersSent) return;
  res.status(status).json({ success: false, message, ...extra, requestId: req.id });
};
