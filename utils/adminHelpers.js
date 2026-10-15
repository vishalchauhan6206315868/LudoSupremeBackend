"use strict";

/** Small pure helpers shared by the admin controllers (unit-tested). */

// Query values can be arrays when a key is repeated (?a=1&a=2). Only plain strings are accepted.
const qs = (value) => (typeof value === "string" ? value : "");

const parsePagination = (query = {}, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const page = Math.min(100000, Math.max(1, parseInt(qs(query.page), 10) || 1));
  const limit = Math.min(maxLimit, Math.max(1, parseInt(qs(query.limit), 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};

const pageMeta = (page, limit, total) => ({
  page,
  limit,
  total,
  totalPages: Math.ceil(total / limit) || 1,
});

// User input is never put into a RegExp unescaped (ReDoS / regex injection).
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseDate = (value) => {
  const v = qs(value);
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// -> { $gte, $lte } | null
const dateRange = (from, to) => {
  const f = parseDate(from);
  const t = parseDate(to);
  if (!f && !t) return null;
  const range = {};
  if (f) range.$gte = f;
  if (t) range.$lte = t;
  return range;
};

/**
 * The last `n` calendar days (oldest first) as { key: "2026-10-09", label: "Oct 9" },
 * evaluated in `timeZone` so they line up with MongoDB's $dateToString({ timezone }).
 */
const lastDays = (n, timeZone, now = new Date()) => {
  const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const labelFmt = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" });
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    out.push({ key: keyFmt.format(d), label: labelFmt.format(d) });
  }
  return out;
};

const timeAgo = (date, now = new Date()) => {
  const s = Math.max(0, Math.round((now - new Date(date)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

module.exports = { qs, parsePagination, pageMeta, escapeRegex, parseDate, dateRange, lastDays, timeAgo };
