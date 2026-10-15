"use strict";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../../config/env");
const s = require("../../utils/adminShapes");

const players = [
  { user: "u1", name: "Rohit", color: "Red", score: 40, outcome: "win", prizeEarned: 180, hasSurrendered: false },
  { user: "u2", name: "Pooja", color: "Green", score: 10, outcome: "loss" },
];

test("winner is {id, name} (id AND readable name), null when there is none", () => {
  assert.deepEqual(s.winnerView("u1", players), { id: "u1", name: "Rohit" });
  assert.deepEqual(s.winnerView("zzz", players), { id: "zzz", name: null });
  assert.equal(s.winnerView(null, players), null);
});

test("game summary uses the winner shape and exposes player user ids", () => {
  const g = s.gameSummary({ _id: "g1", roomCode: "ABC123", gameMode: "twoPlayer", status: "completed", winner: "u1", players });
  assert.deepEqual(g.winner, { id: "u1", name: "Rohit" });
  assert.equal(g.players[0].userId, "u1");
  assert.equal(g.players[1].prizeEarned, 0);
  assert.equal(g.players[1].hasSurrendered, false);
});

test("moves carry the player NAME and id (log only stores the id)", () => {
  const m = s.moveView({ player: "u2", action: "MOVE", diceValue: 6, tokenId: 1, prevStep: 3, newStep: 9, timestamp: "2026-10-12T10:00:00Z" }, players);
  assert.equal(m.player, "Pooja");
  assert.equal(m.playerId, "u2");
  assert.equal(m.diceValue, 6);
  assert.equal(m.newStep, 9);
  const unknown = s.moveView({ player: "ghost", action: "ROLL" }, players);
  assert.equal(unknown.player, null);
  assert.equal(unknown.diceValue, null);
});

test("game detail includes tokens and mapped moves", () => {
  const d = s.gameDetail({
    _id: "g1", roomCode: "ABC123", gameMode: "twoPlayer", status: "in_progress", winner: null,
    players: [{ ...players[0], tokens: [{ id: 0 }] }], history: [{ player: "u1", action: "ROLL", diceValue: 4 }],
  });
  assert.deepEqual(d.players[0].tokens, [{ id: 0 }]);
  assert.equal(d.moves[0].player, "Rohit");
  assert.equal(d.winner, null);
});

test("settings only expose whitelisted keys and the REAL config names", () => {
  const v = s.settingsView(config, { version: "1.2.0" });
  assert.equal(v.rateLimit.globalPerMinute, config.rateLimit.globalPerMinute);
  assert.equal(v.rateLimit.adminAuthAttempts, config.rateLimit.adminAuthAttempts);
  assert.equal(v.game.turnTimeoutSeconds, config.game.turnTimeoutSeconds);
  assert.equal(v.game.matchDurationSeconds, config.game.matchDurationSeconds);
  assert.equal(v.admin.maxCoinAdjust, config.admin.maxCoinAdjust);
  assert.equal(v.economy.platformFeePercent, config.economy.platformFeePercent);
  assert.equal("globalMax" in v.rateLimit, false); // old, never-existing key
  assert.equal("jwt" in v, false);
  assert.equal("secret" in JSON.parse(JSON.stringify(v)).admin, false);
});

test("audit view exposes meta + requestId and drops internals", () => {
  const a = s.auditView({
    _id: "l1", admin: "a1", adminEmail: "x@y.com", action: "wallet.credit", targetType: "user", targetId: "u1",
    meta: { amount: 50, reason: "bonus" }, ip: "1.2.3.4", requestId: "r-1", __v: 0,
  });
  assert.deepEqual(a.meta, { amount: 50, reason: "bonus" });
  assert.equal(a.requestId, "r-1");
  assert.equal(a.adminId, "a1");
  assert.equal("__v" in a, false);
});

test("banner view adds id and removes __v", () => {
  const b = s.bannerView({ _id: "b1", title: "Promo", __v: 3 });
  assert.equal(b.id, "b1");
  assert.equal(b._id, "b1");
  assert.equal("__v" in b, false);
});
