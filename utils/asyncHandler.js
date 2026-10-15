"use strict";

// Express 5 already forwards rejected promises, but this keeps handlers explicit
// and works the same on Express 4 if you ever downgrade.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
