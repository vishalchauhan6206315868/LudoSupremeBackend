"use strict";

const WEAK = ["password", "admin123", "123456", "qwerty", "letmein", "ludosupreme"];

// Admin passwords: 10-72 chars (72 = bcrypt limit), at least one letter and one digit, nothing obvious.
const isStrongPassword = (value) =>
  typeof value === "string" &&
  value.length >= 10 &&
  value.length <= 72 &&
  /[A-Za-z]/.test(value) &&
  /\d/.test(value) &&
  !WEAK.some((w) => value.toLowerCase().includes(w));

const POLICY_MSG = "Password must be 10-72 characters, contain a letter and a number, and not be a common password";

module.exports = { isStrongPassword, POLICY_MSG };
