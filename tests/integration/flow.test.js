"use strict";
/**
 * End-to-end checks of the money + game invariants against a REAL MongoDB.
 *
 *   MONGO_URI_TEST="mongodb://localhost:27017/ludo_test" npm run test:integration
 *
 * The database name MUST contain "test": the suite DROPS the whole database when it finishes.
 * Without MONGO_URI_TEST every test is skipped. Use a replica set to also exercise transactions
 * (docker compose up -d mongo  -> mongodb://localhost:27017/ludo_test?replicaSet=rs0).
 */
process.env.NODE_ENV = "test";
process.env.MONGO_URI = process.env.MONGO_URI_TEST || "";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const URI = process.env.MONGO_URI_TEST;
const enabled = Boolean(URI) && /test/i.test(URI);
const skip = enabled ? false : "set MONGO_URI_TEST (database name must contain 'test') to run";

let mongoose, app, server, base, wallet, GameSession;

const api = async (method, path, token, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const mkUser = async (tag) => {
  const email = `${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@example.com`;
  const r = await api("POST", "/api/auth/register", null, { name: `User ${tag}`, email, password: "Passw0rd!123" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.data.token, id: r.body.data.user.id, email };
};
const coins = async (u) => (await api("GET", "/api/wallet/me", u.token)).body.data.balance;

test.before(async () => {
  if (!enabled) return;
  mongoose = require("mongoose");
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  app = require("../../app");
  wallet = require("../../src/modules/wallet/services/wallet.service");
  GameSession = require("../../src/modules/games/models/GameSession");
  await require("../../src/modules/rewards/controllers/reward.controller").seedDefaultRewards();
  // make sure unique indexes exist before racing requests
  for (const m of Object.values(mongoose.models)) await m.init();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!enabled) return;
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("signup grants the bonus exactly once and /users/me reads the wallet", { skip }, async () => {
  const u = await mkUser("bonus");
  assert.equal(await coins(u), 1000);
  const me = await api("GET", "/api/users/me", u.token);
  assert.equal(me.body.data.user.coins, 1000);
  const dup = await api("POST", "/api/auth/register", null, { name: "Dup", email: u.email, password: "Passw0rd!123" });
  assert.equal(dup.status, 409);
});

test("wallet: concurrent debits can never overdraw; same referenceId credits once", { skip }, async () => {
  const u = await mkUser("wallet");
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => wallet.debitWallet(u.id, 100, "game_entry", "race"))
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 10);
  assert.equal(await coins(u), 0);

  await wallet.creditWallet(u.id, 50, "bonus", "once", "ref-1");
  await wallet.creditWallet(u.id, 50, "bonus", "once", "ref-1");
  await Promise.allSettled([1, 2, 3].map(() => wallet.creditWallet(u.id, 50, "bonus", "once", "ref-1")));
  assert.equal(await coins(u), 50);
});

test("rooms: fees are charged, refunded on leave/cancel, and a full room rejects extra players", { skip }, async () => {
  const [a, b, c] = [await mkUser("ra"), await mkUser("rb"), await mkUser("rc")];
  const created = await api("POST", "/api/rooms/create", a.token, { maxPlayers: 2, entryFee: 100 });
  assert.equal(created.status, 201);
  const code = created.body.data.room.roomCode;
  assert.equal(await coins(a), 900);

  assert.equal((await api("POST", "/api/rooms/join", b.token, { roomCode: code })).status, 200);
  assert.equal(await coins(b), 900);

  const late = await api("POST", "/api/rooms/join", c.token, { roomCode: code });
  assert.equal(late.status, 400);
  assert.equal(await coins(c), 1000, "rejected joiner must not lose coins");

  assert.equal((await api("POST", "/api/rooms/leave", b.token, { roomCode: code })).status, 200);
  assert.equal(await coins(b), 1000);

  // host creating a new room cancels the old one AND refunds (old code lost the fee)
  await api("POST", "/api/rooms/join", b.token, { roomCode: code });
  assert.equal((await api("POST", "/api/rooms/create", a.token, { maxPlayers: 2, entryFee: 100 })).status, 201);
  assert.equal(await coins(b), 1000, "guest refunded when host abandoned the room");
  assert.equal(await coins(a), 900, "host paid for the new room only");
});

test("rooms: 3 people racing for the last seat -> one wins, the others are refunded", { skip }, async () => {
  const host = await mkUser("hh");
  const racers = [await mkUser("r1"), await mkUser("r2"), await mkUser("r3")];
  const code = (await api("POST", "/api/rooms/create", host.token, { maxPlayers: 2, entryFee: 100 })).body.data.room.roomCode;
  const res = await Promise.all(racers.map((r) => api("POST", "/api/rooms/join", r.token, { roomCode: code })));
  assert.equal(res.filter((r) => r.status === 200).length, 1);
  const balances = await Promise.all(racers.map(coins));
  assert.deepEqual(balances.sort((x, y) => x - y), [900, 1000, 1000]);
});

test("game: outsiders cannot read, time out or complete a match; only a finished clock can complete", { skip }, async () => {
  const [a, b, evil] = [await mkUser("ga"), await mkUser("gb"), await mkUser("evil")];
  const code = (await api("POST", "/api/rooms/create", a.token, { maxPlayers: 2, entryFee: 100 })).body.data.room.roomCode;
  await api("POST", "/api/rooms/join", b.token, { roomCode: code });
  const started = await api("POST", "/api/games/start", a.token, { roomCode: code });
  assert.equal(started.status, 201);
  const sid = started.body.data.session._id;
  assert.equal(started.body.data.session.prizePool, 200);

  assert.equal((await api("GET", `/api/games/session/${sid}`, evil.token)).status, 403);
  assert.equal((await api("POST", `/api/games/session/${sid}/timeout`, evil.token)).status, 403);
  assert.equal((await api("POST", `/api/games/session/${sid}/complete`, evil.token)).status, 403);
  // participants cannot end it early either
  assert.equal((await api("POST", `/api/games/session/${sid}/complete`, a.token)).status, 400);
  assert.equal((await api("POST", `/api/games/session/${sid}/timeout`, b.token)).status, 400);

  // second /start is idempotent
  assert.equal((await api("POST", "/api/games/start", b.token, { roomCode: code })).status, 200);

  // fast-forward the clock and give A a higher score
  await GameSession.updateOne(
    { _id: sid },
    { $set: { startedAt: new Date(Date.now() - 11 * 60_000), "players.0.score": 40, "players.1.score": 10 } }
  );
  const done = await api("POST", `/api/games/session/${sid}/complete`, b.token);
  assert.equal(done.status, 200);
  assert.equal(done.body.data.session.status, "completed");
  assert.equal(await coins(a), 900 + 200);
  assert.equal(await coins(b), 900);

  // calling complete again (or in parallel) never pays twice
  await Promise.all([1, 2, 3].map(() => api("POST", `/api/games/session/${sid}/complete`, a.token)));
  assert.equal(await coins(a), 1100);

  const stats = await api("GET", "/api/leaderboard/me", a.token);
  assert.equal(stats.body.data.wins, 1);
});

test("game: a real roll/move cycle follows turn order and the server picks the dice", { skip }, async () => {
  const [a, b] = [await mkUser("ta"), await mkUser("tb")];
  const code = (await api("POST", "/api/rooms/create", a.token, { maxPlayers: 2 })).body.data.room.roomCode;
  await api("POST", "/api/rooms/join", b.token, { roomCode: code });
  const sid = (await api("POST", "/api/games/start", a.token, { roomCode: code })).body.data.session._id;

  assert.equal((await api("POST", `/api/games/session/${sid}/roll-dice`, b.token)).status, 403); // not B's turn
  const roll = await api("POST", `/api/games/session/${sid}/roll-dice`, a.token);
  assert.equal(roll.status, 200);
  assert.ok(roll.body.data.diceValue >= 1 && roll.body.data.diceValue <= 6);
  assert.equal((await api("POST", `/api/games/session/${sid}/roll-dice`, a.token)).status, 400); // already rolled
  const mv = await api("POST", `/api/games/session/${sid}/move-token`, a.token, { tokenId: roll.body.data.movableTokenIds[0] });
  assert.equal(mv.status, 200);
});

test("game: the server-side referee times out an idle turn after the deadline", { skip }, async () => {
  const [a, b] = [await mkUser("sa"), await mkUser("sb")];
  const code = (await api("POST", "/api/rooms/create", a.token, { maxPlayers: 2 })).body.data.room.roomCode;
  await api("POST", "/api/rooms/join", b.token, { roomCode: code });
  const sid = (await api("POST", "/api/games/start", a.token, { roomCode: code })).body.data.session._id;
  await GameSession.updateOne({ _id: sid }, { $set: { turnDeadline: new Date(Date.now() - 5000) } });

  const { sweepOnce } = require("../../jobs/matchSweeper");
  const stats = await sweepOnce();
  assert.ok(stats.turnsTimedOut >= 1);
  const s = await GameSession.findById(sid);
  assert.equal(String(s.currentTurnPlayer), b.id);
});

test("leaderboard: the old self-reporting endpoint no longer changes anything", { skip }, async () => {
  const u = await mkUser("cheat");
  for (let i = 0; i < 5; i++) await api("POST", "/api/leaderboard/update-result", u.token, { result: "win" });
  const me = await api("GET", "/api/leaderboard/me", u.token);
  assert.equal(me.body.data.score, 0);
  assert.equal(me.body.data.wins, 0);
});

test("rewards: conditional rewards cannot be claimed early; claims pay once", { skip }, async () => {
  const u = await mkUser("rw");
  const list = (await api("GET", "/api/rewards", u.token)).body.data.rewards;
  const firstWin = list.find((r) => r.icon === "first_win");
  const welcome = list.find((r) => r.icon === "welcome_bonus");
  assert.equal(firstWin.canClaim, false);
  assert.equal((await api("POST", `/api/rewards/${firstWin._id}/claim`, u.token)).status, 403);

  const both = await Promise.all([1, 2].map(() => api("POST", `/api/rewards/${welcome._id}/claim`, u.token)));
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 400]);
  assert.equal(await coins(u), 1500);
});
