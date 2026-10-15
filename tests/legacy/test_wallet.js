require("dotenv").config();
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const http = require("http");
const app = require("../app");
const User = require("../src/modules/auth/models/User");
const Wallet = require("../src/modules/wallet/models/Wallet");
const WalletTransaction = require("../src/modules/wallet/models/WalletTransaction");
const walletService = require("../src/modules/wallet/services/wallet.service");

async function runTests() {
  console.log("=== STARTING WALLET MODULE & API TEST SUITE ===");

  await mongoose.connect(
    process.env.MONGO_URI || "mongodb://localhost:27017/LudoSupremeDB"
  );

  // Start test server on dynamic port
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const BASE_URL = `http://localhost:${port}/api/wallet`;

  let passedCount = 0;
  let failedCount = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passedCount++;
    } else {
      console.error(`[FAIL] ${message}`);
      failedCount++;
    }
  }

  try {
    // 1. Setup Test Users
    let testUserA = await User.findOne({ email: "wallet_user_a@example.com" });
    if (!testUserA) {
      testUserA = await User.create({
        name: "Wallet User A",
        email: "wallet_user_a@example.com",
        password: "dummyPassword123!",
        coins: 0,
      });
    }

    let testUserB = await User.findOne({ email: "wallet_user_b@example.com" });
    if (!testUserB) {
      testUserB = await User.create({
        name: "Wallet User B",
        email: "wallet_user_b@example.com",
        password: "dummyPassword123!",
        coins: 0,
      });
    }

    // Clean up previous test wallets and transactions
    await Wallet.deleteMany({
      user: { $in: [testUserA._id, testUserB._id] },
    });
    await WalletTransaction.deleteMany({
      user: { $in: [testUserA._id, testUserB._id] },
    });

    const tokenA = jwt.sign(
      { id: testUserA._id },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
    const tokenB = jwt.sign(
      { id: testUserB._id },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    const headersA = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenA}`,
    };
    const headersB = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenB}`,
    };

    console.log("\n--- TEST SECTION 1: WALLET SERVICE UNIT TESTS ---");

    // Test 1.1: getOrCreateWallet initializes with balance 0
    const walletA1 = await walletService.getOrCreateWallet(testUserA._id);
    assert(
      walletA1 && walletA1.balance === 0,
      "getOrCreateWallet creates wallet with balance 0"
    );

    // Test 1.2: Subsequent call returns same wallet
    const walletA2 = await walletService.getOrCreateWallet(testUserA._id);
    assert(
      walletA2._id.toString() === walletA1._id.toString(),
      "getOrCreateWallet returns existing wallet on second call"
    );

    // Test 1.3: creditWallet increases balance and creates transaction
    const creditRes = await walletService.creditWallet(
      testUserA._id,
      100,
      "game_reward",
      "Won match reward",
      "match_999"
    );
    assert(
      creditRes.wallet.balance === 100,
      "creditWallet updates wallet balance to 100"
    );
    assert(
      creditRes.transaction.type === "credit" &&
        creditRes.transaction.amount === 100 &&
        creditRes.transaction.balanceBefore === 0 &&
        creditRes.transaction.balanceAfter === 100 &&
        creditRes.transaction.source === "game_reward" &&
        creditRes.transaction.referenceId === "match_999",
      "creditWallet records correct transaction audit fields"
    );

    // Test 1.4: debitWallet decreases balance and creates transaction
    const debitRes = await walletService.debitWallet(
      testUserA._id,
      30,
      "game_entry",
      "Entry fee deduction",
      "room_123"
    );
    assert(
      debitRes.wallet.balance === 70,
      "debitWallet decreases wallet balance to 70"
    );
    assert(
      debitRes.transaction.type === "debit" &&
        debitRes.transaction.amount === 30 &&
        debitRes.transaction.balanceBefore === 100 &&
        debitRes.transaction.balanceAfter === 70 &&
        debitRes.transaction.source === "game_entry",
      "debitWallet records correct transaction audit fields"
    );

    // Test 1.5: debitWallet rejects overdraft (insufficient funds)
    let overdraftFailed = false;
    try {
      await walletService.debitWallet(testUserA._id, 150, "game_entry", "Too high debit");
    } catch (err) {
      overdraftFailed = true;
      assert(
        err.message.includes("Insufficient wallet balance"),
        "debitWallet throws 'Insufficient wallet balance' on overdraft"
      );
    }
    assert(overdraftFailed, "Overdraft attempt was blocked");

    // Verify balance unchanged after blocked debit
    const walletCheck = await Wallet.findOne({ user: testUserA._id });
    assert(
      walletCheck.balance === 70,
      "Wallet balance remains 70 after blocked overdraft"
    );

    // Test 1.6: Invalid negative/zero amounts rejected
    let invalidAmountRejected = false;
    try {
      await walletService.creditWallet(testUserA._id, -10);
    } catch (e) {
      invalidAmountRejected = true;
    }
    assert(invalidAmountRejected, "creditWallet rejects negative amount");

    let zeroAmountRejected = false;
    try {
      await walletService.debitWallet(testUserA._id, 0);
    } catch (e) {
      zeroAmountRejected = true;
    }
    assert(zeroAmountRejected, "debitWallet rejects 0 amount");

    // Test 1.7: getWalletTransactions pagination
    const txHistory = await walletService.getWalletTransactions(testUserA._id, 1, 10);
    assert(
      txHistory.transactions.length === 2 &&
        txHistory.pagination.total === 2 &&
        txHistory.wallet.balance === 70,
      "getWalletTransactions returns total 2 transactions and current balance"
    );
    assert(
      txHistory.transactions[0].type === "debit" &&
        txHistory.transactions[1].type === "credit",
      "getWalletTransactions sorts newest first (debit then credit)"
    );

    console.log("\n--- TEST SECTION 2: HTTP ROUTE AUTHENTICATION TESTS ---");

    // Test 2.1: Missing token returns 401
    const noAuthWallet = await fetch(`${BASE_URL}`);
    const noAuthWalletData = await noAuthWallet.json();
    assert(
      noAuthWallet.status === 401 && noAuthWalletData.success === false,
      "GET /api/wallet without token returns 401"
    );

    const noAuthMe = await fetch(`${BASE_URL}/me`);
    const noAuthMeData = await noAuthMe.json();
    assert(
      noAuthMe.status === 401 && noAuthMeData.success === false,
      "GET /api/wallet/me without token returns 401"
    );

    const noAuthTx = await fetch(`${BASE_URL}/transactions`);
    const noAuthTxData = await noAuthTx.json();
    assert(
      noAuthTx.status === 401 && noAuthTxData.success === false,
      "GET /api/wallet/transactions without token returns 401"
    );

    // Test 2.2: Invalid token returns 401
    const invalidAuth = await fetch(`${BASE_URL}`, {
      headers: { Authorization: "Bearer bad_token_123" },
    });
    assert(invalidAuth.status === 401, "GET /api/wallet with invalid token returns 401");

    console.log("\n--- TEST SECTION 3: HTTP WALLET API ENDPOINTS ---");

    // Test 3.1: GET /api/wallet for User A
    const resWalletA = await fetch(`${BASE_URL}`, { headers: headersA });
    const dataWalletA = await resWalletA.json();
    assert(
      resWalletA.status === 200 &&
        dataWalletA.success === true &&
        dataWalletA.data.wallet.balance === 70,
      "GET /api/wallet returns 200 with User A's balance of 70"
    );

    // Test 3.2: GET /api/wallet for User B (auto-creates wallet with 0)
    const resWalletB = await fetch(`${BASE_URL}`, { headers: headersB });
    const dataWalletB = await resWalletB.json();
    assert(
      resWalletB.status === 200 &&
        dataWalletB.success === true &&
        dataWalletB.data.wallet.balance === 0,
      "GET /api/wallet auto-creates wallet for User B with balance 0"
    );

    // Test 3.3: GET /api/wallet/me for User A
    const resMeA = await fetch(`${BASE_URL}/me`, { headers: headersA });
    const dataMeA = await resMeA.json();
    assert(
      resMeA.status === 200 &&
        dataMeA.success === true &&
        dataMeA.data.balance === 70,
      "GET /api/wallet/me returns User A's balance (70)"
    );

    // Test 3.4: GET /api/wallet/me for User B
    const resMeB = await fetch(`${BASE_URL}/me`, { headers: headersB });
    const dataMeB = await resMeB.json();
    assert(
      resMeB.status === 200 &&
        dataMeB.success === true &&
        dataMeB.data.balance === 0,
      "GET /api/wallet/me returns User B's balance (0) - Isolation confirmed"
    );

    // Test 3.5: GET /api/wallet/transactions for User A
    const resTxA = await fetch(`${BASE_URL}/transactions`, { headers: headersA });
    const dataTxA = await resTxA.json();
    assert(
      resTxA.status === 200 &&
        dataTxA.success === true &&
        dataTxA.data.transactions.length === 2 &&
        dataTxA.data.wallet.balance === 70 &&
        dataTxA.data.pagination.page === 1 &&
        dataTxA.data.pagination.total === 2,
      "GET /api/wallet/transactions returns User A's transactions and metadata"
    );

    // Test 3.6: GET /api/wallet/transactions for User B (should be empty)
    const resTxB = await fetch(`${BASE_URL}/transactions`, { headers: headersB });
    const dataTxB = await resTxB.json();
    assert(
      resTxB.status === 200 &&
        dataTxB.data.transactions.length === 0 &&
        dataTxB.data.pagination.total === 0,
      "GET /api/wallet/transactions returns empty for User B - Isolation confirmed"
    );

    // Test 3.7: Pagination with limit=1
    const resPage1 = await fetch(`${BASE_URL}/transactions?page=1&limit=1`, {
      headers: headersA,
    });
    const dataPage1 = await resPage1.json();
    assert(
      resPage1.status === 200 &&
        dataPage1.data.transactions.length === 1 &&
        dataPage1.data.pagination.page === 1 &&
        dataPage1.data.pagination.limit === 1 &&
        dataPage1.data.pagination.total === 2 &&
        dataPage1.data.pagination.totalPages === 2,
      "GET /api/wallet/transactions?page=1&limit=1 paginates correctly"
    );

    // Test 3.8: Page 2 with limit=1
    const resPage2 = await fetch(`${BASE_URL}/transactions?page=2&limit=1`, {
      headers: headersA,
    });
    const dataPage2 = await resPage2.json();
    assert(
      resPage2.status === 200 &&
        dataPage2.data.transactions.length === 1 &&
        dataPage2.data.pagination.page === 2,
      "GET /api/wallet/transactions?page=2&limit=1 fetches page 2"
    );
    assert(
      dataPage1.data.transactions[0]._id !== dataPage2.data.transactions[0]._id,
      "Page 1 and Page 2 contain distinct transactions"
    );

    // Test 3.9: Invalid pagination query (page=0) returns 400
    const resInvalidPage = await fetch(`${BASE_URL}/transactions?page=0`, {
      headers: headersA,
    });
    const dataInvalidPage = await resInvalidPage.json();
    assert(
      resInvalidPage.status === 400 && dataInvalidPage.success === false,
      "GET /api/wallet/transactions?page=0 returns 400 validation error"
    );

    // Test 3.10: Invalid limit query (limit=101) returns 400
    const resInvalidLimit = await fetch(`${BASE_URL}/transactions?limit=101`, {
      headers: headersA,
    });
    const dataInvalidLimit = await resInvalidLimit.json();
    assert(
      resInvalidLimit.status === 400 && dataInvalidLimit.success === false,
      "GET /api/wallet/transactions?limit=101 returns 400 validation error"
    );

    console.log("\n--- TEST SECTION 4: VERIFY EXISTING APIS INTACT ---");
    const healthRes = await fetch(`http://localhost:${port}/health`);
    const healthData = await healthRes.json();
    assert(
      healthRes.status === 200 && healthData.success === true,
      "GET /health works as expected"
    );

    const authMeNoToken = await fetch(`http://localhost:${port}/api/users/me`);
    assert(
      authMeNoToken.status === 401,
      "GET /api/users/me returns 401 without token (existing routes intact)"
    );

    console.log("\n=================================");
    console.log(`TOTAL TESTS: ${passedCount + failedCount}`);
    console.log(`PASSED: ${passedCount}`);
    console.log(`FAILED: ${failedCount}`);
    console.log("=================================");

    if (failedCount > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("Test Suite Execution Error:", error);
    process.exitCode = 1;
  } finally {
    server.close();
    await mongoose.disconnect();
  }
}

runTests();
