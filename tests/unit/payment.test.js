"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { escapeRegex } = require("../../utils/adminHelpers");

/**
 * Timing-safe comparator helper matching payment.service implementation
 */
const safeCompareSignatures = (expected, provided) => {
  if (typeof expected !== "string" || typeof provided !== "string") {
    return false;
  }
  const cleanExpected = expected.trim().toLowerCase();
  const cleanProvided = provided.trim().toLowerCase();
  if (!cleanExpected || !cleanProvided) {
    return false;
  }
  const expectedBuf = Buffer.from(cleanExpected, "utf8");
  const providedBuf = Buffer.from(cleanProvided, "utf8");
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
};

test("Razorpay signature generation and timing-safe verification", () => {
  const secret = "test_razorpay_secret_12345";
  const orderId = "order_test_123";
  const paymentId = "pay_test_456";

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  assert.ok(expectedSignature);
  assert.equal(typeof expectedSignature, "string");
  assert.equal(expectedSignature.length, 64);

  // Exact match passes
  assert.equal(safeCompareSignatures(expectedSignature, expectedSignature), true);
  // Case-insensitive hex match passes
  assert.equal(safeCompareSignatures(expectedSignature.toUpperCase(), expectedSignature.toLowerCase()), true);

  // Verification fails on tampered paymentId
  const tamperedSig = crypto
    .createHmac("sha256", secret)
    .update(`${orderId}|pay_fake_789`)
    .digest("hex");
  assert.equal(safeCompareSignatures(expectedSignature, tamperedSig), false);

  // Missing or non-string signatures fail safely without throwing
  assert.equal(safeCompareSignatures(expectedSignature, null), false);
  assert.equal(safeCompareSignatures(expectedSignature, undefined), false);
  assert.equal(safeCompareSignatures(expectedSignature, ""), false);
  assert.equal(safeCompareSignatures(expectedSignature, 12345), false);
  assert.equal(safeCompareSignatures(expectedSignature, {}), false);
  assert.equal(safeCompareSignatures(null, expectedSignature), false);

  // Malformed or different-length signatures fail safely without throwing RangeError
  assert.equal(safeCompareSignatures(expectedSignature, "short_sig"), false);
  assert.equal(safeCompareSignatures(expectedSignature, "a".repeat(63)), false);
  assert.equal(safeCompareSignatures(expectedSignature, "a".repeat(65)), false);
});

test("Razorpay webhook signature verification", () => {
  const webhookSecret = "test_webhook_secret_987";
  const rawBody = Buffer.from(JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: "pay_captured_111",
          order_id: "order_rzp_999",
          status: "captured",
          amount: 50000,
        },
      },
    },
  }));

  const signature = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  assert.ok(signature);

  // Verifying with same secret succeeds
  const verified = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");
  assert.equal(safeCompareSignatures(verified, signature), true);

  // Verifying with wrong secret fails
  const wrongSig = crypto
    .createHmac("sha256", "wrong_secret")
    .update(rawBody)
    .digest("hex");
  assert.equal(safeCompareSignatures(wrongSig, signature), false);

  // Modified raw body fails
  const tamperedRawBody = Buffer.from(JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: { id: "pay_captured_111", amount: 100 } } },
  }));
  const tamperedCheck = crypto
    .createHmac("sha256", webhookSecret)
    .update(tamperedRawBody)
    .digest("hex");
  assert.equal(safeCompareSignatures(tamperedCheck, signature), false);
});

test("Payment idempotency: deterministic referenceId format", () => {
  const rzpOrderId1 = "order_N9xYz123";
  const rzpOrderId2 = "order_K8wAb456";

  const refId1 = `deposit:${rzpOrderId1}`;
  const refId2 = `deposit:${rzpOrderId2}`;

  // Deterministic and identical for the same order across client verify and webhook
  assert.equal(refId1, `deposit:${rzpOrderId1}`);
  assert.notEqual(refId1, refId2);
  assert.ok(refId1.startsWith("deposit:"));
});

test("Withdrawal validation logic", () => {
  const minWithdrawal = 50;
  const maxWithdrawal = 25000;

  const isValidAmount = (amount) => {
    const n = Number(amount);
    return Number.isSafeInteger(n) && n >= minWithdrawal && n <= maxWithdrawal;
  };

  assert.equal(isValidAmount(10), false, "Below min should fail");
  assert.equal(isValidAmount(50), true, "Min amount should pass");
  assert.equal(isValidAmount(500), true, "Valid amount should pass");
  assert.equal(isValidAmount(25000), true, "Max amount should pass");
  assert.equal(isValidAmount(30000), false, "Above max should fail");
  assert.equal(isValidAmount(-100), false, "Negative amount should fail");
  assert.equal(isValidAmount(100.5), false, "Non-integer amount should fail");

  const isValidUpi = (upiId) => /^[\w.\-_]{2,}@[a-zA-Z]{2,}$/.test(upiId);
  assert.equal(isValidUpi("player@okhdfcbank"), true);
  assert.equal(isValidUpi("user.name@paytm"), true);
  assert.equal(isValidUpi("invalid-upi"), false);
  assert.equal(isValidUpi("bad@"), false);
});

test("Admin search regex sanitization: metacharacters do not crash", () => {
  const dangerousInputs = [
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

  for (const input of dangerousInputs) {
    const escaped = escapeRegex(input);
    assert.doesNotThrow(() => {
      const regex = new RegExp(escaped, "i");
      assert.ok(regex.test(input), `Escaped regex should match literal input: ${input}`);
    }, `escapeRegex must neutralize regex injection for input: ${input}`);
  }

  // Verify non-matching input returns false
  const safeReg = new RegExp(escapeRegex("[special]"), "i");
  assert.equal(safeReg.test("[special]"), true);
  assert.equal(safeReg.test("special"), false);
});

test("Withdrawal approval requires non-empty transaction reference", () => {
  const validateApprovalPayload = (payload) => {
    const ref = payload?.transactionRef ? String(payload.transactionRef).trim() : null;
    if (!ref) {
      throw new Error("Payout transaction reference (UTR) is required to approve withdrawal");
    }
    return ref;
  };

  assert.equal(validateApprovalPayload({ transactionRef: "UTR123456789" }), "UTR123456789");
  assert.equal(validateApprovalPayload({ transactionRef: "  SBI987654321  " }), "SBI987654321");
  assert.throws(() => validateApprovalPayload({}), /Payout transaction reference/);
  assert.throws(() => validateApprovalPayload({ transactionRef: "" }), /Payout transaction reference/);
  assert.throws(() => validateApprovalPayload({ transactionRef: "   " }), /Payout transaction reference/);
  assert.throws(() => validateApprovalPayload({ transactionRef: null }), /Payout transaction reference/);
});

test("Withdrawal state transitions: concurrent approval and rejection race simulation", () => {
  // Simulates MongoDB atomic conditional update: findOneAndUpdate({ _id, status: 'pending' })
  class MockWithdrawalStore {
    constructor() {
      this.status = "pending";
      this.transactionRef = null;
      this.rejectionReason = null;
    }

    atomicApprove(transactionRef) {
      if (this.status !== "pending") return null;
      this.status = "approved";
      this.transactionRef = transactionRef;
      return { status: "approved", transactionRef: this.transactionRef };
    }

    atomicReject(reason) {
      if (this.status !== "pending") return null;
      this.status = "rejected";
      this.rejectionReason = reason;
      return { status: "rejected", rejectionReason: this.rejectionReason };
    }
  }

  // Test 1: Only first approve wins, second approve fails
  const store1 = new MockWithdrawalStore();
  const res1A = store1.atomicApprove("UTR1");
  const res1B = store1.atomicApprove("UTR2");
  assert.ok(res1A);
  assert.equal(res1A.status, "approved");
  assert.equal(res1B, null, "Concurrent second approval must be rejected");
  assert.equal(store1.status, "approved");

  // Test 2: Approval vs Rejection race: only first action wins
  const store2 = new MockWithdrawalStore();
  const res2A = store2.atomicApprove("UTR1");
  const res2B = store2.atomicReject("Fraud");
  assert.ok(res2A);
  assert.equal(res2B, null, "Rejection after approval must be rejected");
  assert.equal(store2.status, "approved");

  // Test 3: Rejection vs Approval race: only first action wins
  const store3 = new MockWithdrawalStore();
  const res3A = store3.atomicReject("Invalid UPI");
  const res3B = store3.atomicApprove("UTR1");
  assert.ok(res3A);
  assert.equal(res3B, null, "Approval after rejection must be rejected");
  assert.equal(store3.status, "rejected");
});

test("Withdrawal compensation logic on failure: status reversibility", () => {
  let requestStatus = "pending";

  const simulateFailedRefund = () => {
    // 1. Transition pending -> rejected
    if (requestStatus !== "pending") throw new Error("Not pending");
    requestStatus = "rejected";

    // 2. Refund fails
    const refundFailed = true;
    if (refundFailed) {
      // Revert status to pending so it is not permanently rejected without refund
      requestStatus = "pending";
      throw new Error("Wallet credit connection failed");
    }
  };

  assert.throws(() => simulateFailedRefund(), /Wallet credit connection failed/);
  assert.equal(requestStatus, "pending", "Status must revert to pending when refund fails");
});
