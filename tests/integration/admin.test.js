"use strict";
/**
 * Admin API against a REAL MongoDB (same rules as flow.test.js: db name must contain "test",
 * the database is DROPPED at the end).
 *
 *   MONGO_URI_TEST="mongodb://localhost:27017/ludo_test?replicaSet=rs0" npm run test:integration
 */
process.env.NODE_ENV = "test";
process.env.MONGO_URI = process.env.MONGO_URI_TEST || "";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const URI = process.env.MONGO_URI_TEST;
const enabled = Boolean(URI) && /test/i.test(URI);
const skip = enabled ? false : "set MONGO_URI_TEST (database name must contain 'test') to run";

let mongoose, app, server, base, Admin;
let superTok, adminTok;

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
const login = async (email, password) => api("POST", "/api/admin/login", null, { email, password });

test.before(async () => {
  if (!enabled) return;
  mongoose = require("mongoose");
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  app = require("../../app");
  Admin = require("../../src/modules/admin/models/admin.model");
  for (const m of Object.values(mongoose.models)) await m.init();
  await new Admin({ name: "Boss", email: "boss@test.io", password: "k7-Vault-Orange-42", role: "superadmin" }).save();
  await new Admin({ name: "Ops", email: "ops@test.io", password: "k7-Vault-Orange-42", role: "admin" }).save();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  superTok = (await login("boss@test.io", "k7-Vault-Orange-42")).body.data.token;
  adminTok = (await login("ops@test.io", "k7-Vault-Orange-42")).body.data.token;
});
test.after(async () => {
  if (!enabled) return;
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("login: wrong password / unknown email give the same 401; token works on /me", { skip }, async () => {
  assert.equal((await login("boss@test.io", "wrong-password-1")).status, 401);
  assert.equal((await login("nobody@test.io", "wrong-password-1")).status, 401);
  const me = await api("GET", "/api/admin/me", superTok);
  assert.equal(me.status, 200);
  assert.equal(me.body.data.admin.role, "superadmin");
  assert.equal(me.body.data.admin.password, undefined);
});

test("dashboard returns real, well-formed data on an empty and a populated database", { skip }, async () => {
  const empty = await api("GET", "/api/admin/dashboard?refresh=1", adminTok);
  assert.equal(empty.status, 200);
  const d = empty.body.data;
  assert.equal(d.growth.labels.length, 7);
  assert.equal(d.health.database, "Online");
  await mkUser("dash1");
  await mkUser("dash2");
  const after = await api("GET", "/api/admin/dashboard?refresh=1", adminTok);
  assert.equal(after.body.data.stats.totalUsers, 2);
  assert.equal(after.body.data.recentUsers.length, 2);
  assert.equal(after.body.data.growth.total[6], 2);
});

test("users: list/search/detail, block (needs reason) takes effect immediately, unblock restores", { skip }, async () => {
  const u = await mkUser("blk");
  const list = await api("GET", `/api/admin/users?search=${encodeURIComponent(u.email.slice(0, 8))}`, adminTok);
  assert.equal(list.status, 200);
  assert.ok(list.body.data.users.some((x) => x.id === u.id && x.coins === 1000));
  assert.equal((await api("GET", "/api/admin/users?search[$ne]=x", adminTok)).status, 200); // array/object query is ignored, not injected

  assert.equal((await api("PATCH", `/api/admin/users/${u.id}/status`, adminTok, { isActive: false })).status, 400);
  const blocked = await api("PATCH", `/api/admin/users/${u.id}/status`, adminTok, { isActive: false, reason: "Fraud test" });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.changed, true);
  assert.equal((await api("GET", "/api/users/me", u.token)).status, 403); // player is locked out right away
  assert.equal((await api("GET", `/api/admin/users?status=blocked`, adminTok)).body.data.users.some((x) => x.id === u.id), true);

  await api("PATCH", `/api/admin/users/${u.id}/status`, adminTok, { isActive: true });
  assert.equal((await api("GET", "/api/users/me", u.token)).status, 200);
  assert.equal((await api("GET", `/api/admin/users/${u.id}`, adminTok)).body.data.user.id, u.id);
});

test("coins: superadmin only, idempotent, never below zero, ledger + audit written", { skip }, async () => {
  const u = await mkUser("coin");
  const body = { type: "credit", amount: 250, reason: "Compensation", idempotencyKey: "retry-key-0001" };
  assert.equal((await api("POST", `/api/admin/users/${u.id}/coins`, adminTok, body)).status, 403); // plain admin

  const first = await api("POST", `/api/admin/users/${u.id}/coins`, superTok, body);
  assert.equal(first.status, 201);
  assert.equal(first.body.data.balance, 1250);
  const retry = await api("POST", `/api/admin/users/${u.id}/coins`, superTok, body);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.data.balance, 1250); // not 1500

  const tooMuch = await api("POST", `/api/admin/users/${u.id}/coins`, superTok, { type: "debit", amount: 5000, reason: "Chargeback" });
  assert.equal(tooMuch.status, 400);
  const debit = await api("POST", `/api/admin/users/${u.id}/coins`, superTok, { type: "debit", amount: 250, reason: "Reverse" });
  assert.equal(debit.body.data.balance, 1000);

  const tx = await api("GET", `/api/admin/transactions?userId=${u.id}&source=admin`, adminTok);
  assert.equal(tx.body.data.transactions.length, 2);
  const logs = await api("GET", "/api/admin/audit-logs?action=wallet.credit", superTok);
  assert.ok(logs.body.data.logs.some((l) => l.targetId === u.id && l.meta.amount === 250));
  assert.equal((await api("GET", "/api/admin/audit-logs", adminTok)).status, 403); // superadmin only
});

test("sessions: change-password and logout-all revoke older tokens", { skip }, async () => {
  const created = await api("POST", "/api/admin/admins", superTok, { name: "Temp Admin", email: "temp@test.io", password: "k7-Vault-Orange-42" });
  assert.equal(created.status, 201);
  assert.equal((await api("POST", "/api/admin/admins", superTok, { name: "Temp Admin", email: "temp@test.io", password: "k7-Vault-Orange-42" })).status, 409);

  const t1 = (await login("temp@test.io", "k7-Vault-Orange-42")).body.data.token;
  const t2 = (await login("temp@test.io", "k7-Vault-Orange-42")).body.data.token;
  await new Promise((r) => setTimeout(r, 1100)); // JWT iat has 1-second resolution
  const changed = await api("POST", "/api/admin/change-password", t1, { currentPassword: "k7-Vault-Orange-42", newPassword: "n3w-Vault-Purple-77" });
  assert.equal(changed.status, 200);
  assert.equal((await api("GET", "/api/admin/me", t2)).status, 401); // other session killed
  assert.equal((await api("GET", "/api/admin/me", t1)).status, 401); // old token of the caller too
  assert.equal((await api("GET", "/api/admin/me", changed.body.data.token)).status, 200);

  const id = created.body.data.admin.id;
  assert.equal((await api("PATCH", `/api/admin/admins/${id}/status`, superTok, { isActive: false })).status, 200);
  assert.equal((await api("GET", "/api/admin/me", changed.body.data.token)).status, 403); // account is now inactive
  assert.equal((await login("temp@test.io", "n3w-Vault-Purple-77")).status, 403);
});

test("super admin cannot deactivate themselves / the last super admin", { skip }, async () => {
  const me = await api("GET", "/api/admin/me", superTok);
  assert.equal((await api("PATCH", `/api/admin/admins/${me.body.data.admin.id}/status`, superTok, { isActive: false })).status, 400);
});

test("banners: CRUD for admins, active ones visible to players only inside their window", { skip }, async () => {
  const u = await mkUser("ban");
  const mk = (extra) => api("POST", "/api/admin/banners", adminTok, { title: "Diwali Event", imageUrl: "https://cdn.test.io/b.png", ...extra });
  const live = await mk({ type: "event", priority: 5 });
  assert.equal(live.status, 201);
  await mk({ title: "Future", startsAt: new Date(Date.now() + 86400000).toISOString() });
  await mk({ title: "Off", isActive: false });

  const visible = (await api("GET", "/api/banners", u.token)).body.data.banners;
  assert.deepEqual(visible.map((b) => b.title), ["Diwali Event"]);

  const id = live.body.data.banner._id;
  assert.equal((await api("PATCH", `/api/admin/banners/${id}`, adminTok, { isActive: false })).status, 200);
  assert.equal((await api("GET", "/api/banners", u.token)).body.data.banners.length, 0);
  assert.equal((await api("DELETE", `/api/admin/banners/${id}`, adminTok)).status, 200);
  assert.equal((await api("DELETE", `/api/admin/banners/${id}`, adminTok)).status, 404);
});

test("support: player opens a ticket, admin replies and resolves, player sees the reply", { skip }, async () => {
  const u = await mkUser("sup");
  const other = await mkUser("sup2");
  const t = await api("POST", "/api/support/tickets", u.token, { subject: "Coins missing", message: "Match ended but no prize", category: "game" });
  assert.equal(t.status, 201);
  const id = t.body.data.ticket.id;

  assert.equal((await api("POST", `/api/support/tickets/${id}/reply`, other.token, { message: "not mine" })).status, 404); // not the owner
  const adm = await api("GET", "/api/admin/support/tickets?status=open", adminTok);
  assert.ok(adm.body.data.tickets.some((x) => x.id === id && x.user.email === u.email));

  const reply = await api("POST", `/api/admin/support/tickets/${id}/reply`, adminTok, { message: "We credited 100 coins." });
  assert.equal(reply.status, 201);
  assert.equal(reply.body.data.ticket.status, "in_progress");
  assert.equal((await api("PATCH", `/api/admin/support/tickets/${id}/status`, adminTok, { status: "resolved" })).status, 200);

  const mine = await api("GET", "/api/support/tickets/mine", u.token);
  assert.equal(mine.body.data.tickets[0].replies[0].authorType, "admin");
  assert.equal((await api("PATCH", `/api/admin/support/tickets/${id}/status`, adminTok, { status: "closed" })).status, 200);
  assert.equal((await api("POST", `/api/admin/support/tickets/${id}/reply`, adminTok, { message: "late" })).status, 409);
});

test("games / economy / reports endpoints answer on a fresh database", { skip }, async () => {
  assert.equal((await api("GET", "/api/admin/games", adminTok)).status, 200);
  assert.equal((await api("GET", "/api/admin/games?status=completed&mode=twoPlayer&roomCode=ab", adminTok)).status, 200);
  assert.equal((await api("GET", "/api/admin/games/64b000000000000000000001", adminTok)).status, 404);
  const eco = await api("GET", "/api/admin/economy/summary", adminTok);
  assert.equal(eco.status, 200);
  assert.ok(eco.body.data.coinsInCirculation >= 0);
  const rep = await api("GET", "/api/admin/reports/daily?days=14", adminTok);
  assert.equal(rep.body.data.rows.length, 14);
  assert.equal((await api("GET", "/api/admin/settings", adminTok)).status, 200);
});
