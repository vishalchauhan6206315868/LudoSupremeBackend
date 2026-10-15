"use strict";

// Blocks NoSQL-operator injection like {"email": {"$gt": ""}} by dropping any key that
// starts with "$" or contains "." from the request body (mutated in place).
const clean = (value, depth = 0) => {
  if (depth > 10 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v) => clean(v, depth + 1));
    return;
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith("$") || key.includes(".")) {
      delete value[key];
    } else {
      clean(value[key], depth + 1);
    }
  }
};

module.exports = (req, res, next) => {
  clean(req.body);
  next();
};
