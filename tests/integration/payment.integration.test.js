"use strict";

/**
 * Dedicated integration test suite for Razorpay wallet deposit and withdrawal workflows.
 *
 * Requirements:
 *   MONGO_URI_TEST="mongodb://localhost:27017/ludo_test" node --test tests/integration/payment.integration.test.js
 *
 * Safety rules:
 * - Requires MONGO_URI_TEST to be set and the database name to contain "test".
 * - All tests are skipped if MONGO_URI_TEST is unset or invalid.
 * - Drops the test database on startup and teardown.
 * - Razorpay client is mocked locally; no real credentials or network calls are used.
 */

process.env.NODE_ENV = "test";
process.env.MONGO_URI = process.env.MONGO_URI_TEST || "";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.REQUIRE_REPLICA_SET = "false";

const TEST_RAZORPAY_KEY_ID = "rzp_test_mockKeyId_Integration_12345";
const TEST_RAZORPAY_KEY_SECRET = "mockRazorpaySecret_Integration_67890";
const TEST_RAZORPAY_WEBHOOK_SECRET = "mockWebhookSecret_Integration_abcde";

process.env.RAZORPAY_KEY_ID = TEST_RAZORPAY_KEY_ID;
process.env.RAZORPAY_KEY_SECRET = TEST_RAZORPAY_KEY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = TEST_RAZORPAY_WEBHOOK_SECRET;

// Mock Razorpay SDK before loading application modules
const rzpPath = require.resolve("razorpay");
class MockRazorpay {
  constructor(opts) {
    this.key_id = opts?.key_id;
    this.key_secret = opts?.key_secret;
    this.orders = {
      create: async (params) => {
        if (MockRazorpay.failNextCreate) {
          MockRazorpay.failNextCreate = false;
          throw new Error("Simulated gateway error during Razorpay order creation");
        }
        MockRazorpay.lastCreatedOrderParams = params;
        return {
          id: `order_mock_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`,
          entity: "order",
          amount: params.amount,
          amount_paid: 0,
          amount_due: params.amount,
          currency: params.currency || "INR",
          receipt: params.receipt,
          status: "created",
          attempts: 0,
          notes: params.notes,
          created_at: Math.floor(Date.now() / 1000),
        };
      },
    };
  }
}
MockRazorpay.failNextCreate = false;
MockRazorpay.lastCreatedOrderParams = null;
require.cache[rzpPath] = {
  id: rzpPath,
  filename: rzpPath,
  loaded: true,
  exports: MockRazorpay,
};

// Ensure config has mocked values and rate limiting disabled for tests
const config = require("../../config/env");
config.razorpay.keyId = TEST_RAZORPAY_KEY_ID;
config.razorpay.keySecret = TEST_RAZORPAY_KEY_SECRET;
config.razorpay.webhookSecret = TEST_RAZORPAY_WEBHOOK_SECRET;
config.rateLimit.enabled = false;

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");

const URI = process.env.MONGO_URI_TEST;
const enabled = Boolean(URI) && /test/i.test(URI);
const skip = enabled ? false : "set MONGO_URI_TEST (database name must contain 'test') to run";

let mongoose, app, server, base;
let walletService, paymentService;
let PaymentOrder, WithdrawalRequest, WalletTransaction, Admin;
let adminTok;

const api = async (method, path, token, body, customHeaders = {}) => {
  const headers = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...customHeaders,
  };
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  return {
    status: res.status,
    body: await res.json().catch(() => ({})),
    headers: res.headers,
  };
};

const mkUser = async (tag) => {
  const email = `${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@example.com`;
  const r = await api("POST", "/api/auth/register", null, {
    name: `User ${tag}`,
    email,
    password: "Passw0rd!123",
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.data.token, id: r.body.data.user.id, email };
};

const coins = async (u) => (await api("GET", "/api/wallet/me", u.token)).body.data.balance;

const loginAdmin = async (email, password) =>
  api("POST", "/api/admin/login", null, { email, password });

const signPayment = (orderId, paymentId) => {
  return crypto
    .createHmac("sha256", TEST_RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
};

const signWebhook = (payloadObj) => {
  const rawString = JSON.stringify(payloadObj);
  const signature = crypto
    .createHmac("sha256", TEST_RAZORPAY_WEBHOOK_SECRET)
    .update(Buffer.from(rawString, "utf8"))
    .digest("hex");
  return { rawString, signature };
};

test.before(async () => {
  if (!enabled) return;

  mongoose = require("mongoose");
  await mongoose.connect(URI);

  // Database safety verification: refuse to run if database name doesn't contain "test"
  const dbName = mongoose.connection.name;
  if (!dbName || !/test/i.test(dbName)) {
    await mongoose.disconnect();
    throw new Error(`Refusing to run tests: connected database '${dbName}' does not contain 'test'`);
  }

  await mongoose.connection.dropDatabase();

  app = require("../../app");
  walletService = require("../../src/modules/wallet/services/wallet.service");
  paymentService = require("../../src/modules/wallet/services/payment.service");
  PaymentOrder = require("../../src/modules/wallet/models/PaymentOrder");
  WithdrawalRequest = require("../../src/modules/wallet/models/WithdrawalRequest");
  WalletTransaction = require("../../src/modules/wallet/models/WalletTransaction");
  Admin = require("../../src/modules/admin/models/admin.model");

  for (const m of Object.values(mongoose.models)) {
    await m.init();
  }

  // Create admin for approval / rejection / admin search tests
  await new Admin({
    name: "Payment Admin",
    email: "pay_admin@test.io",
    password: "k7-Vault-Orange-42",
    role: "admin",
  }).save();

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  const adminLoginRes = await loginAdmin("pay_admin@test.io", "k7-Vault-Orange-42");
  assert.equal(adminLoginRes.status, 200, "Admin login failed in before hook");
  adminTok = adminLoginRes.body.data.token;
});

test.after(async () => {
  if (!enabled) return;
  if (server) server.close();
  if (mongoose && mongoose.connection.readyState !== 0) {
    const dbName = mongoose.connection.name;
    if (dbName && /test/i.test(dbName)) {
      await mongoose.connection.dropDatabase();
    }
    await mongoose.disconnect();
  }
});

// ============================================================================
// SECTION A: DEPOSIT LIFECYCLE
// ============================================================================

test("A.1: Deposit order creation creates pending PaymentOrder via mocked Razorpay client", { skip }, async () => {
  const u = await mkUser("dep_create");
  assert.equal(await coins(u), 1000);

  // 1. Valid deposit order creation
  const res = await api("POST", "/api/wallet/deposit/create-order", u.token, { amount: 500 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, "Deposit order created successfully");

  const data = res.body.data;
  assert.ok(data.orderId.startsWith("ORD_"), "Internal orderId format must start with ORD_");
  assert.ok(data.razorpayOrderId.startsWith("order_mock_"), "Mock razorpay orderId format");
  assert.equal(data.amount, 500);
  assert.equal(data.currency, "INR");
  assert.equal(data.keyId, TEST_RAZORPAY_KEY_ID);

  // Verify persistence in MongoDB
  const savedOrder = await PaymentOrder.findOne({ razorpayOrderId: data.razorpayOrderId });
  assert.ok(savedOrder, "PaymentOrder must be persisted in database");
  assert.equal(savedOrder.status, "pending");
  assert.equal(savedOrder.amount, 500);
  assert.equal(String(savedOrder.user), u.id);

  // 2. Amount validation: below minimum (10 INR) is rejected
  const belowMin = await api("POST", "/api/wallet/deposit/create-order", u.token, { amount: 5 });
  assert.equal(belowMin.status, 400);

  // 3. Amount validation: negative or zero rejected
  const negative = await api("POST", "/api/wallet/deposit/create-order", u.token, { amount: -100 });
  assert.equal(negative.status, 400);
});

test("A.2: Payment verification with valid HMAC signature marks order success and credits wallet exactly once", { skip }, async () => {
  const u = await mkUser("dep_verify");
  assert.equal(await coins(u), 1000);

  // Create deposit order for 500 INR
  const created = await api("POST", "/api/wallet/deposit/create-order", u.token, { amount: 500 });
  assert.equal(created.status, 201);
  const rzpOrderId = created.body.data.razorpayOrderId;
  const paymentId = `pay_mock_${Date.now()}`;
  const validSignature = signPayment(rzpOrderId, paymentId);

  // Verify payment with valid signature
  const verifyRes = await api("POST", "/api/wallet/deposit/verify", u.token, {
    razorpayOrderId: rzpOrderId,
    razorpayPaymentId: paymentId,
    razorpaySignature: validSignature,
  });

  assert.equal(verifyRes.status, 200, JSON.stringify(verifyRes.body));
  assert.equal(verifyRes.body.success, true);
  assert.equal(verifyRes.body.message, "Deposit successful");
  assert.equal(verifyRes.body.data.balance, 1500);

  // Verify wallet balance
  assert.equal(await coins(u), 1500);

  // Verify database order record
  const updatedOrder = await PaymentOrder.findOne({ razorpayOrderId: rzpOrderId });
  assert.equal(updatedOrder.status, "success");
  assert.equal(updatedOrder.razorpayPaymentId, paymentId);
  assert.equal(updatedOrder.razorpaySignature, validSignature);

  // Verify ledger transaction
  const tx = await WalletTransaction.findOne({
    user: u.id,
    referenceId: `deposit:${rzpOrderId}`,
  });
  assert.ok(tx, "WalletTransaction record must exist with referenceId");
  assert.equal(tx.type, "credit");
  assert.equal(tx.amount, 500);
  assert.equal(tx.balanceAfter, 1500);
});

test("A.3: Duplicate client payment verification is idempotent and does not credit coins again", { skip }, async () => {
  const u = await mkUser("dep_dup");
  assert.equal(await coins(u), 1000);

  const created = await api("POST", "/api/wallet/deposit/create-order", u.token, { amount: 350 });
  const rzpOrderId = created.body.data.razorpayOrderId;
  const paymentId = `pay_mock_dup_${Date.now()}`;
  const signature = signPayment(rzpOrderId, paymentId);

  const payload = {
    razorpayOrderId: rzpOrderId,
    razorpayPaymentId: paymentId,
    razorpaySignature: signature,
  };

  // First verification
  const first = await api("POST", "/api/wallet/deposit/verify", u.token, payload);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.balance, 1350);
  assert.equal(await coins(u), 1350);

  // Second duplicate verification
  const second = await api("POST", "/api/wallet/deposit/verify", u.token, payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.message, "Payment already verified");
  assert.equal(second.body.data.balance, 1350);

  // Balance must remain 1350 (NOT 1700)
  assert.equal(await coins(u), 1350);

  // Verify only one ledger record exists
  const txCount = await WalletTransaction.countDocuments({
    user: u.id,
    referenceId: `deposit:${rzpOrderId}`,
  });
  assert.equal(txCount, 1, "Exactly one ledger transaction must be created");
});

test("A.4: Payment verification rejects invalid signature and transitions order to failed", { skip }, async () => {
  const u = await mkUser("dep_bad_sig");
  assert.equal(await coins(u), 1000);

  const created = await api("POST", "/api/wallet/deposit/create-order", u.token, { amount: 200 });
  const rzpOrderId = created.body.data.razorpayOrderId;

  // Invalid 64-character hex signature
  const badSignature = "0000000000000000000000000000000000000000000000000000000000000000";
  const verifyRes = await api("POST", "/api/wallet/deposit/verify", u.token, {
    razorpayOrderId: rzpOrderId,
    razorpayPaymentId: "pay_tampered_123",
    razorpaySignature: badSignature,
  });

  assert.equal(verifyRes.status, 400);
  assert.match(verifyRes.body.message, /Invalid signature/i);

  // Wallet balance must remain untouched
  assert.equal(await coins(u), 1000);

  // Order status should be marked as failed
  const failedOrder = await PaymentOrder.findOne({ razorpayOrderId: rzpOrderId });
  assert.equal(failedOrder.status, "failed");
  assert.equal(failedOrder.errorDetails?.reason, "Signature mismatch");
});

test("A.5: Player can retrieve deposit history with accurate pagination and details", { skip }, async () => {
  const u = await mkUser("dep_hist");

  // Create and verify two deposit orders
  for (const amt of [100, 250]) {
    const cr = await api("POST", "/api/wallet/deposit/create-order", u.token, { amount: amt });
    const rzpId = cr.body.data.razorpayOrderId;
    const payId = `pay_${amt}_${Date.now()}`;
    await api("POST", "/api/wallet/deposit/verify", u.token, {
      razorpayOrderId: rzpId,
      razorpayPaymentId: payId,
      razorpaySignature: signPayment(rzpId, payId),
    });
  }

  const hist = await api("GET", "/api/wallet/deposit/history?page=1&limit=10", u.token);
  assert.equal(hist.status, 200);
  assert.equal(hist.body.success, true);
  assert.equal(hist.body.data.deposits.length, 2);
  assert.equal(hist.body.data.pagination.total, 2);
  assert.ok(hist.body.data.deposits.every((d) => d.status === "success"));
});

// ============================================================================
// SECTION B: WEBHOOK PROCESSING
// ============================================================================

test("B.1: Webhook order.paid event credits wallet and transitions order to success", { skip }, async () => {
  const u = await mkUser("wh_order_paid");
  assert.equal(await coins(u), 1000);

  const created = await api("POST", "/api/wallet/deposit/create-order", u.token, { amount: 300 });
  const rzpOrderId = created.body.data.razorpayOrderId;

  const webhookPayload = {
    event: "order.paid",
    payload: {
      order: {
        entity: {
          id: rzpOrderId,
          amount: 30000,
          currency: "INR",
          status: "paid",
        },
      },
      payment: {
        entity: {
          id: `pay_webhook_ord_${Date.now()}`,
          order_id: rzpOrderId,
          status: "captured",
          amount: 30000,
          currency: "INR",
          method: "upi",
        },
      },
    },
  };

  const { rawString, signature } = signWebhook(webhookPayload);

  const res = await api("POST", "/api/wallet/webhook/razorpay", null, rawString, {
    "x-razorpay-signature": signature,
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.handled, true);
  assert.equal(res.body.data.status, "success");

  // Wallet credited by 300
  assert.equal(await coins(u), 1300);

  // Database order status is success
  const orderDoc = await PaymentOrder.findOne({ razorpayOrderId: rzpOrderId });
  assert.equal(orderDoc.status, "success");
});

test("B.2: Webhook payment.captured event credits wallet and records payment details", { skip }, async () => {
  const u = await mkUser("wh_pay_captured");
  assert.equal(await coins(u), 1000);

  const created = await api("POST", "/api/wallet/deposit/create-order", u.token, { amount: 250 });
  const rzpOrderId = created.body.data.razorpayOrderId;
  const payId = `pay_cap_${Date.now()}`;

  const webhookPayload = {
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: payId,
          order_id: rzpOrderId,
          status: "captured",
          amount: 25000,
          currency: "INR",
          method: "card",
        },
      },
    },
  };

  const { rawString, signature } = signWebhook(webhookPayload);

  const res = await api("POST", "/api/wallet/webhook/razorpay", null, rawString, {
    "x-razorpay-signature": signature,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.handled, true);
  assert.equal(res.body.data.status, "success");

  // Balance updated to 1250
  assert.equal(await coins(u), 1250);

  const orderDoc = await PaymentOrder.findOne({ razorpayOrderId: rzpOrderId });
  assert.equal(orderDoc.status, "success");
  assert.equal(orderDoc.razorpayPaymentId, payId);
  assert.equal(orderDoc.paymentMethod, "card");
});

test("B.3: Duplicate webhook delivery is idempotent and does not credit wallet a second time", { skip }, async () => {
  const u = await mkUser("wh_dup");
  assert.equal(await coins(u), 1000);

  const created = await api("POST", "/api/wallet/deposit/create-order", u.token, { amount: 150 });
  const rzpOrderId = created.body.data.razorpayOrderId;

  const webhookPayload = {
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: `pay_dup_wh_${Date.now()}`,
          order_id: rzpOrderId,
          status: "captured",
          amount: 15000,
          currency: "INR",
        },
      },
    },
  };

  const { rawString, signature } = signWebhook(webhookPayload);

  // Delivery 1
  const first = await api("POST", "/api/wallet/webhook/razorpay", null, rawString, {
    "x-razorpay-signature": signature,
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.status, "success");
  assert.equal(await coins(u), 1150);

  // Delivery 2 (duplicate)
  const second = await api("POST", "/api/wallet/webhook/razorpay", null, rawString, {
    "x-razorpay-signature": signature,
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.duplicate, true);

  // Balance remains 1150
  assert.equal(await coins(u), 1150);

  const txCount = await WalletTransaction.countDocuments({
    user: u.id,
    referenceId: `deposit:${rzpOrderId}`,
  });
  assert.equal(txCount, 1);
});

test("B.4: Concurrent race between client verification and webhook processing credits wallet exactly once", { skip }, async () => {
  const u = await mkUser("race_verify_wh");
  assert.equal(await coins(u), 1000);

  const created = await api("POST", "/api/wallet/deposit/create-order", u.token, { amount: 400 });
  const rzpOrderId = created.body.data.razorpayOrderId;
  const paymentId = `pay_race_${Date.now()}`;

  // Client verify payload
  const clientSignature = signPayment(rzpOrderId, paymentId);
  const clientVerifyAction = () =>
    api("POST", "/api/wallet/deposit/verify", u.token, {
      razorpayOrderId: rzpOrderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: clientSignature,
    });

  // Webhook payload
  const webhookPayload = {
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: rzpOrderId,
          status: "captured",
          amount: 40000,
          currency: "INR",
        },
      },
    },
  };
  const { rawString, signature } = signWebhook(webhookPayload);
  const webhookAction = () =>
    api("POST", "/api/wallet/webhook/razorpay", null, rawString, {
      "x-razorpay-signature": signature,
    });

  // Execute both simultaneously
  const [clientRes, webhookRes] = await Promise.all([clientVerifyAction(), webhookAction()]);

  assert.equal(clientRes.status, 200);
  assert.equal(webhookRes.status, 200);

  // Critical money invariant: wallet balance must be EXACTLY 1400 (credited once)
  assert.equal(await coins(u), 1400);

  const orderDoc = await PaymentOrder.findOne({ razorpayOrderId: rzpOrderId });
  assert.equal(orderDoc.status, "success");

  const txCount = await WalletTransaction.countDocuments({
    user: u.id,
    referenceId: `deposit:${rzpOrderId}`,
  });
  assert.equal(txCount, 1, "Concurrency race must result in exactly one wallet transaction record");
});

test("B.5: Webhook payment.failed event marks order as failed and does not credit wallet", { skip }, async () => {
  const u = await mkUser("wh_failed");
  assert.equal(await coins(u), 1000);

  const created = await api("POST", "/api/wallet/deposit/create-order", u.token, { amount: 150 });
  const rzpOrderId = created.body.data.razorpayOrderId;

  const webhookPayload = {
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: `pay_failed_${Date.now()}`,
          order_id: rzpOrderId,
          status: "failed",
          error_code: "BAD_REQUEST_ERROR",
          error_description: "Payment declined by customer card issuer",
        },
      },
    },
  };

  const { rawString, signature } = signWebhook(webhookPayload);

  const res = await api("POST", "/api/wallet/webhook/razorpay", null, rawString, {
    "x-razorpay-signature": signature,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.handled, true);
  assert.equal(res.body.data.status, "failed");

  // Balance must NOT change
  assert.equal(await coins(u), 1000);

  const orderDoc = await PaymentOrder.findOne({ razorpayOrderId: rzpOrderId });
  assert.equal(orderDoc.status, "failed");
  assert.match(String(orderDoc.errorDetails), /declined by customer/i);
});

test("B.6: Webhook security: rejects invalid or missing signatures with 400 Bad Request", { skip }, async () => {
  const dummyPayload = { event: "order.paid", payload: {} };

  // 1. Missing signature header
  const noSig = await api("POST", "/api/wallet/webhook/razorpay", null, dummyPayload);
  assert.equal(noSig.status, 400);

  // 2. Tampered signature
  const badSig = await api("POST", "/api/wallet/webhook/razorpay", null, dummyPayload, {
    "x-razorpay-signature": "bad_hex_signature_1234567890abcdef1234567890abcdef1234567890abcdef",
  });
  assert.equal(badSig.status, 400);
  assert.match(badSig.body.message, /Invalid webhook signature/i);
});

// ============================================================================
// SECTION C: WITHDRAWAL LIFECYCLE
// ============================================================================

test("C.1: Valid withdrawal request debits wallet immediately and persists pending request", { skip }, async () => {
  const u = await mkUser("wth_valid");
  assert.equal(await coins(u), 1000);

  const res = await api("POST", "/api/wallet/withdraw/request", u.token, {
    amount: 300,
    payoutMode: "upi",
    payoutDetails: { upiId: "player@okhdfcbank" },
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, "Withdrawal request submitted successfully");
  assert.equal(res.body.data.remainingBalance, 700);

  const wth = res.body.data.withdrawal;
  assert.ok(wth.requestNo.startsWith("WTH-"));
  assert.equal(wth.amount, 300);
  assert.equal(wth.status, "pending");
  assert.equal(wth.payoutDetails.upiId, "player@okhdfcbank");

  // Wallet must reflect debit immediately
  assert.equal(await coins(u), 700);

  // Verify DB record
  const savedWth = await WithdrawalRequest.findById(wth._id);
  assert.equal(savedWth.status, "pending");
  assert.equal(savedWth.amount, 300);

  // Player withdrawal history lists the pending request
  const hist = await api("GET", "/api/wallet/withdraw/history", u.token);
  assert.equal(hist.status, 200);
  assert.equal(hist.body.data.withdrawals.length, 1);
  assert.equal(hist.body.data.withdrawals[0].requestNo, wth.requestNo);
});

test("C.2: Insufficient funds withdrawal request is rejected without debiting balance", { skip }, async () => {
  const u = await mkUser("wth_insufficient");
  assert.equal(await coins(u), 1000);

  // Attempt to withdraw more than available balance
  const res = await api("POST", "/api/wallet/withdraw/request", u.token, {
    amount: 1500,
    payoutMode: "upi",
    payoutDetails: { upiId: "player@okhdfcbank" },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /Insufficient wallet balance/i);

  // Wallet balance must not change
  assert.equal(await coins(u), 1000);

  const wthCount = await WithdrawalRequest.countDocuments({ user: u.id });
  assert.equal(wthCount, 0);
});

test("C.3: Admin approval requires transactionRef and completes the withdrawal", { skip }, async () => {
  const u = await mkUser("wth_approve");
  const reqRes = await api("POST", "/api/wallet/withdraw/request", u.token, {
    amount: 250,
    payoutMode: "upi",
    payoutDetails: { upiId: "player@okhdfcbank" },
  });
  const wthId = reqRes.body.data.withdrawal._id;

  // 1. Missing transactionRef returns 400
  const noRef = await api("PATCH", `/api/admin/withdrawals/${wthId}/approve`, adminTok, {
    adminNote: "Transferred",
  });
  assert.equal(noRef.status, 400);
  assert.equal(noRef.body.success, false);
  assert.ok(
    noRef.body.errors?.some((e) => e.field === "transactionRef" || /transaction reference/i.test(e.message)),
    "Must validate missing transactionRef"
  );

  // 2. Empty/whitespace transactionRef returns 400
  const emptyRef = await api("PATCH", `/api/admin/withdrawals/${wthId}/approve`, adminTok, {
    transactionRef: "   ",
  });
  assert.equal(emptyRef.status, 400);
  assert.equal(emptyRef.body.success, false);
  assert.ok(
    emptyRef.body.errors?.some((e) => e.field === "transactionRef" || /transaction reference/i.test(e.message)),
    "Must validate empty transactionRef"
  );

  // 3. Valid transactionRef succeeds
  const approved = await api("PATCH", `/api/admin/withdrawals/${wthId}/approve`, adminTok, {
    transactionRef: "UTR9876543210AXIS",
    adminNote: "IMPS payout completed",
  });

  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.success, true);
  assert.equal(approved.body.message, "Withdrawal approved successfully");
  assert.equal(approved.body.data.status, "approved");
  assert.equal(approved.body.data.transactionRef, "UTR9876543210AXIS");

  // Status in DB
  const doc = await WithdrawalRequest.findById(wthId);
  assert.equal(doc.status, "approved");
  assert.equal(doc.transactionRef, "UTR9876543210AXIS");

  // Wallet balance remains 750 (debited on request, not debited again)
  assert.equal(await coins(u), 750);
});

test("C.4: An approved withdrawal cannot be approved or rejected again", { skip }, async () => {
  const u = await mkUser("wth_immutable_app");
  const reqRes = await api("POST", "/api/wallet/withdraw/request", u.token, {
    amount: 100,
    payoutMode: "upi",
    payoutDetails: { upiId: "player@okhdfcbank" },
  });
  const wthId = reqRes.body.data.withdrawal._id;

  // Approve first
  const approved = await api("PATCH", `/api/admin/withdrawals/${wthId}/approve`, adminTok, {
    transactionRef: "UTR_TEST_1001",
  });
  assert.equal(approved.status, 200);

  // Cannot approve again
  const reApprove = await api("PATCH", `/api/admin/withdrawals/${wthId}/approve`, adminTok, {
    transactionRef: "UTR_TEST_1002",
  });
  assert.equal(reApprove.status, 400);
  assert.match(reApprove.body.message, /Cannot approve request with status 'approved'/i);

  // Cannot reject approved withdrawal
  const rejectApproved = await api("PATCH", `/api/admin/withdrawals/${wthId}/reject`, adminTok, {
    rejectionReason: "Too late",
  });
  assert.equal(rejectApproved.status, 400);
  assert.match(rejectApproved.body.message, /Cannot reject request with status 'approved'/i);
});

test("C.5: Admin rejection automatically refunds debited coins to player wallet", { skip }, async () => {
  const u = await mkUser("wth_reject");
  assert.equal(await coins(u), 1000);

  // Request withdrawal of 350 coins
  const reqRes = await api("POST", "/api/wallet/withdraw/request", u.token, {
    amount: 350,
    payoutMode: "upi",
    payoutDetails: { upiId: "player@invalidvpa" },
  });
  assert.equal(reqRes.status, 201);
  const wthId = reqRes.body.data.withdrawal._id;
  const requestNo = reqRes.body.data.withdrawal.requestNo;

  // Balance after debit
  assert.equal(await coins(u), 650);

  // Admin rejects withdrawal
  const rejectRes = await api("PATCH", `/api/admin/withdrawals/${wthId}/reject`, adminTok, {
    rejectionReason: "Invalid VPA / UPI address",
    adminNote: "Bank declined receiver address",
  });

  assert.equal(rejectRes.status, 200, JSON.stringify(rejectRes.body));
  assert.equal(rejectRes.body.success, true);
  assert.equal(rejectRes.body.data.status, "rejected");

  // Wallet automatically refunded (+350)
  assert.equal(await coins(u), 1000);

  // Check refund transaction in ledger
  const refundTx = await WalletTransaction.findOne({
    user: u.id,
    referenceId: `wth_refund:${requestNo}`,
  });
  assert.ok(refundTx, "Ledger refund transaction must exist");
  assert.equal(refundTx.type, "credit");
  assert.equal(refundTx.source, "refund");
  assert.equal(refundTx.amount, 350);

  // Cannot approve or reject a rejected request
  const reReject = await api("PATCH", `/api/admin/withdrawals/${wthId}/reject`, adminTok, {
    rejectionReason: "Double reject",
  });
  assert.equal(reReject.status, 400);

  const reApprove = await api("PATCH", `/api/admin/withdrawals/${wthId}/approve`, adminTok, {
    transactionRef: "UTR_FAKE",
  });
  assert.equal(reApprove.status, 400);
});

test("C.6: Failure during withdrawal creation compensates and ensures no coins are lost", { skip }, async () => {
  const u = await mkUser("wth_comp_create");
  assert.equal(await coins(u), 1000);

  // Monkey-patch WithdrawalRequest.create to simulate storage failure
  const originalCreate = WithdrawalRequest.create;
  WithdrawalRequest.create = async function () {
    throw new Error("Simulated database failure during WithdrawalRequest creation");
  };

  try {
    const res = await api("POST", "/api/wallet/withdraw/request", u.token, {
      amount: 200,
      payoutMode: "upi",
      payoutDetails: { upiId: "player@okhdfcbank" },
    });
    // Request must fail
    assert.ok(res.status >= 500, `Expected 5xx status, got ${res.status}`);

    // Invariant: no coins are lost; balance restored via compensation refund
    assert.equal(await coins(u), 1000);

    // Verify compensation transaction in ledger
    const txs = await WalletTransaction.find({ user: u.id }).sort({ createdAt: 1 });
    const debitTx = txs.find((t) => t.type === "debit" && t.source === "withdrawal");
    const refundTx = txs.find((t) => t.type === "credit" && t.source === "refund");
    assert.ok(debitTx, "Initial debit transaction must be recorded");
    assert.ok(refundTx, "Compensation refund transaction must be recorded");
  } finally {
    WithdrawalRequest.create = originalCreate;
  }
});

test("C.7: Refund failure during rejection safely reverts withdrawal status to pending without losing coins", { skip }, async () => {
  const u = await mkUser("wth_revert");
  assert.equal(await coins(u), 1000);

  // Request withdrawal of 150 coins
  const reqRes = await api("POST", "/api/wallet/withdraw/request", u.token, {
    amount: 150,
    payoutMode: "upi",
    payoutDetails: { upiId: "player@okhdfcbank" },
  });
  const wthId = reqRes.body.data.withdrawal._id;
  assert.equal(await coins(u), 850);

  // Monkey-patch walletService.creditWallet to simulate ledger failure during refund
  const originalCreditWallet = walletService.creditWallet;
  walletService.creditWallet = async function () {
    throw new Error("Simulated wallet credit ledger connection failure");
  };

  try {
    const rejectRes = await api("PATCH", `/api/admin/withdrawals/${wthId}/reject`, adminTok, {
      rejectionReason: "Simulated test rejection",
    });

    assert.equal(rejectRes.status, 500);

    // CRITICAL: Withdrawal status must revert to pending (not left in 'rejected' while refund failed)
    const docAfterFail = await WithdrawalRequest.findById(wthId);
    assert.equal(
      docAfterFail.status,
      "pending",
      "Status must safely revert to 'pending' when refund fails"
    );
  } finally {
    walletService.creditWallet = originalCreditWallet;
  }

  // Once ledger is healthy, admin can retry and succeed
  const retryReject = await api("PATCH", `/api/admin/withdrawals/${wthId}/reject`, adminTok, {
    rejectionReason: "Valid retry rejection",
  });
  assert.equal(retryReject.status, 200);

  const docFinal = await WithdrawalRequest.findById(wthId);
  assert.equal(docFinal.status, "rejected");

  // Balance refunded to 1000
  assert.equal(await coins(u), 1000);
});

test("C.8: Bank transfer withdrawal request validates required bank fields and debits balance", { skip }, async () => {
  const u = await mkUser("wth_bank");
  assert.equal(await coins(u), 1000);

  // 1. Missing bank fields rejected
  const missingFields = await api("POST", "/api/wallet/withdraw/request", u.token, {
    amount: 200,
    payoutMode: "bank_transfer",
    payoutDetails: { accountNumber: "12345678901" }, // missing ifscCode & accountHolderName
  });
  assert.equal(missingFields.status, 400);

  // 2. Valid bank transfer request
  const validBank = await api("POST", "/api/wallet/withdraw/request", u.token, {
    amount: 200,
    payoutMode: "bank_transfer",
    payoutDetails: {
      accountNumber: "9876543210123",
      ifscCode: "HDFC0001234",
      accountHolderName: "John Doe",
      bankName: "HDFC Bank",
    },
  });

  assert.equal(validBank.status, 201);
  assert.equal(validBank.body.data.withdrawal.payoutMode, "bank_transfer");
  assert.equal(validBank.body.data.withdrawal.payoutDetails.accountNumber, "9876543210123");
  assert.equal(await coins(u), 800);
});

// ============================================================================
// SECTION D: ADMIN SEARCH (REGEX SANITIZATION)
// ============================================================================

test("D.1: Admin deposit search with regex metacharacters does not crash with HTTP 500", { skip }, async () => {
  const dangerousPatterns = [
    ".*",
    "[invalid",
    "(",
    ")",
    "*",
    "+",
    "?",
    "^",
    "$",
    "{",
    "}",
    "|",
    "\\",
    "ORD_[0-9]+",
    "user(test)+",
  ];

  for (const pattern of dangerousPatterns) {
    const res = await api(
      "GET",
      `/api/admin/deposits?search=${encodeURIComponent(pattern)}`,
      adminTok
    );
    assert.equal(
      res.status,
      200,
      `Admin deposit search crashed with status ${res.status} for pattern: ${pattern}`
    );
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data.deposits));
    assert.ok(res.body.data.pagination);
  }
});

test("D.2: Admin withdrawal search with regex metacharacters does not crash with HTTP 500", { skip }, async () => {
  const dangerousPatterns = [
    ".*",
    "[pending",
    "WTH-.*",
    "(",
    ")",
    "*",
    "+",
    "?",
    "{1,3}",
    "\\",
    "[0-9]+@upi",
  ];

  for (const pattern of dangerousPatterns) {
    const res = await api(
      "GET",
      `/api/admin/withdrawals?search=${encodeURIComponent(pattern)}`,
      adminTok
    );
    assert.equal(
      res.status,
      200,
      `Admin withdrawal search crashed with status ${res.status} for pattern: ${pattern}`
    );
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data.withdrawals));
    assert.ok(res.body.data.pagination);
  }
});
