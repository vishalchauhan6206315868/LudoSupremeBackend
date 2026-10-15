"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../../src/modules/games/engine/ludoEngine");

const mkPlayer = (user, seatIndex, overrides = {}) => ({
  user,
  seatIndex,
  color: ["Red", "Green", "Yellow", "Blue"][seatIndex],
  score: 0,
  hasSurrendered: false,
  tokens: [0, 1, 2, 3].map((tokenId) => ({ tokenId, step: 0, isHome: false })),
  ...overrides,
});

test("global board index: shared track only", () => {
  assert.equal(E.getGlobalBoardIndex(0, 0), -1);
  assert.equal(E.getGlobalBoardIndex(0, 51), -1);
  assert.equal(E.getGlobalBoardIndex(0, 20), 20);
  assert.equal(E.getGlobalBoardIndex(1, 7), 20); // same tile as seat 0 / step 20
  assert.equal(E.getGlobalBoardIndex(3, 20), (39 + 20) % 52);
});

test("movable tokens cannot overshoot home", () => {
  const tokens = [
    { tokenId: 0, step: 55, isHome: false },
    { tokenId: 1, step: 56, isHome: true },
    { tokenId: 2, step: 10, isHome: false },
    { tokenId: 3, step: 51, isHome: false },
  ];
  assert.deepEqual(E.getMovableTokenIds(tokens, 1), [0, 2, 3]);
  assert.deepEqual(E.getMovableTokenIds(tokens, 6), [2]);
});

test("next player: works with non-contiguous seats and skips surrendered", () => {
  const players = [mkPlayer("a", 0), mkPlayer("b", 2), mkPlayer("c", 3)];
  assert.equal(E.getNextActivePlayer(players, 0).user, "b");
  assert.equal(E.getNextActivePlayer(players, 2).user, "c");
  assert.equal(E.getNextActivePlayer(players, 3).user, "a"); // wraps
  players[1].hasSurrendered = true;
  assert.equal(E.getNextActivePlayer(players, 0).user, "c");
  players[2].hasSurrendered = true;
  assert.equal(E.getNextActivePlayer(players, 0).user, "a"); // only one left
  players[0].hasSurrendered = true;
  assert.equal(E.getNextActivePlayer(players, 0), null);
});

test("move: advances token and scores dice value", () => {
  const players = [mkPlayer("a", 0), mkPlayer("b", 1)];
  const r = E.applyMove({ players, userId: "a", tokenId: 2, diceValue: 4 });
  assert.equal(r.newStep, 4);
  assert.equal(r.pointsEarned, 4);
  assert.equal(players[0].score, 4);
  assert.equal(r.captured, null);
});

test("move: reaching home gives +56 bonus and flags the token", () => {
  const players = [mkPlayer("a", 0), mkPlayer("b", 1)];
  players[0].tokens[0].step = 52;
  const r = E.applyMove({ players, userId: "a", tokenId: 0, diceValue: 4 });
  assert.equal(r.reachedHome, true);
  assert.equal(r.pointsEarned, 4 + 56);
  assert.equal(players[0].tokens[0].isHome, true);
});

test("move: overshoot, finished token and bad dice are rejected", () => {
  const players = [mkPlayer("a", 0), mkPlayer("b", 1)];
  players[0].tokens[0].step = 55;
  assert.throws(() => E.applyMove({ players, userId: "a", tokenId: 0, diceValue: 2 }), E.RuleViolation);
  players[0].tokens[1] = { tokenId: 1, step: 56, isHome: true };
  assert.throws(() => E.applyMove({ players, userId: "a", tokenId: 1, diceValue: 1 }), /already reached home/);
  assert.throws(() => E.applyMove({ players, userId: "a", tokenId: 2, diceValue: 7 }), E.RuleViolation);
  assert.throws(() => E.applyMove({ players, userId: "a", tokenId: 9, diceValue: 1 }), /Token not found/);
  assert.throws(() => E.applyMove({ players, userId: "zzz", tokenId: 0, diceValue: 1 }), /not a player/);
});

test("capture: opponent on same non-safe tile is sent back and loses points", () => {
  const players = [mkPlayer("a", 0), mkPlayer("b", 1)];
  players[0].tokens[0].step = 16;
  players[1].tokens[0].step = 7; // global 20
  players[1].score = 30;
  const r = E.applyMove({ players, userId: "a", tokenId: 0, diceValue: 4 }); // a -> step 20 / global 20
  assert.ok(r.captured);
  assert.equal(players[1].tokens[0].step, 0);
  assert.equal(players[1].score, 23);
  assert.equal(r.captured.pointsDeducted, 7);
});

test("capture: never on a safe tile, never your own, never surrendered players", () => {
  // safe tile 21: seat0 step 21 === seat1 step 8
  let players = [mkPlayer("a", 0), mkPlayer("b", 1)];
  players[0].tokens[0].step = 17;
  players[1].tokens[0].step = 8;
  assert.equal(E.applyMove({ players, userId: "a", tokenId: 0, diceValue: 4 }).captured, null);
  assert.equal(players[1].tokens[0].step, 8);

  players = [mkPlayer("a", 0), mkPlayer("b", 1, { hasSurrendered: true })];
  players[0].tokens[0].step = 16;
  players[1].tokens[0].step = 7;
  assert.equal(E.applyMove({ players, userId: "a", tokenId: 0, diceValue: 4 }).captured, null);

  players = [mkPlayer("a", 0), mkPlayer("b", 1)];
  players[0].tokens[0].step = 16;
  players[0].tokens[1].step = 20; // my own token on the target tile
  assert.equal(E.applyMove({ players, userId: "a", tokenId: 0, diceValue: 4 }).captured, null);
  assert.equal(players[0].tokens[1].step, 20);
});

test("capture: score never goes below zero", () => {
  const players = [mkPlayer("a", 0), mkPlayer("b", 1)];
  players[0].tokens[0].step = 16;
  players[1].tokens[0].step = 7;
  players[1].score = 2;
  E.applyMove({ players, userId: "a", tokenId: 0, diceValue: 4 });
  assert.equal(players[1].score, 0);
});

test("settlement: higher score wins whole pool", () => {
  const players = [mkPlayer("a", 0, { score: 40 }), mkPlayer("b", 1, { score: 25 })];
  const s = E.computeSettlement({ players, prizePool: 200 });
  assert.equal(s.winnerId, "a");
  assert.equal(s.isDraw, false);
  assert.deepEqual(s.ranking.map((r) => [r.userId, r.rank, r.outcome, r.prize]), [
    ["a", 1, "win", 200],
    ["b", 2, "loss", 0],
  ]);
});

test("settlement: equal scores are a draw and the pool is split", () => {
  const players = [mkPlayer("a", 0), mkPlayer("b", 1)]; // 0 - 0 (nobody moved)
  const s = E.computeSettlement({ players, prizePool: 200 });
  assert.equal(s.isDraw, true);
  assert.equal(s.winnerId, null);
  assert.deepEqual(s.ranking.map((r) => [r.rank, r.outcome, r.prize]), [[1, "draw", 100], [1, "draw", 100]]);
});

test("settlement: forced winner (all tokens home) wins even with a lower score", () => {
  const players = [mkPlayer("a", 0, { score: 10 }), mkPlayer("b", 1, { score: 99 })];
  const s = E.computeSettlement({ players, prizePool: 100, forcedWinnerId: "a" });
  assert.equal(s.winnerId, "a");
  assert.equal(s.ranking[0].prize, 100);
});

test("settlement: surrendered players rank below active ones", () => {
  const players = [
    mkPlayer("a", 0, { score: 500, hasSurrendered: true }),
    mkPlayer("b", 1, { score: 5 }),
    mkPlayer("c", 2, { score: 50 }),
  ];
  const s = E.computeSettlement({ players, prizePool: 300 });
  assert.deepEqual(s.ranking.map((r) => r.userId), ["c", "b", "a"]);
  assert.equal(s.winnerId, "c");
});

test("settlement: platform fee and rounding never create coins", () => {
  const players = [mkPlayer("a", 0, { score: 1 }), mkPlayer("b", 1, { score: 0 })];
  const s = E.computeSettlement({ players, prizePool: 1000, platformFeePercent: 5 });
  assert.equal(s.ranking[0].prize, 950);

  const three = [mkPlayer("a", 0), mkPlayer("b", 1), mkPlayer("c", 2)];
  const d = E.computeSettlement({ players: three, prizePool: 100 });
  const paid = d.ranking.reduce((sum, r) => sum + r.prize, 0);
  assert.equal(paid, 99); // 33 * 3, the leftover coin stays with the platform
  assert.ok(paid <= 100);
});
