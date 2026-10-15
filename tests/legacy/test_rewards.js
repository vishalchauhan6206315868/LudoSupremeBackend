require("dotenv").config();
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../src/modules/auth/models/User");
const Reward = require("../src/modules/rewards/models/Reward");
const RewardClaim = require("../src/modules/rewards/models/RewardClaim");

const BASE_URL = "http://localhost:5000/api/rewards";

async function runTests() {
  console.log("=== STARTING REWARDS API TEST SUITE ===");
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/LudoSupremeDB");

  // 1. Get or create a test user
  let testUser = await User.findOne({ email: "rewardtester@example.com" });
  if (!testUser) {
    testUser = await User.create({
      name: "Reward Tester",
      email: "rewardtester@example.com",
      password: "dummyPassword123!",
      coins: 1000,
    });
  }

  // Clear previous test claims for clean test state
  await RewardClaim.deleteMany({ user: testUser._id });

  const token = jwt.sign({ id: testUser._id }, process.env.JWT_SECRET, { expiresIn: "1h" });
  console.log("Created test user:", testUser.email, "ID:", testUser._id.toString());

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

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

  // ----------------------------------------------------
  // TEST 1: Missing Token
  // ----------------------------------------------------
  try {
    const res = await fetch(BASE_URL);
    const data = await res.json();
    assert(res.status === 401 && data.success === false, "Missing token returns 401");
  } catch (e) {
    assert(false, "Missing token test exception: " + e.message);
  }

  // ----------------------------------------------------
  // TEST 2: Invalid Token
  // ----------------------------------------------------
  try {
    const res = await fetch(BASE_URL, {
      headers: { Authorization: "Bearer invalid_token_12345" },
    });
    const data = await res.json();
    assert(res.status === 401 && data.success === false, "Invalid token returns 401");
  } catch (e) {
    assert(false, "Invalid token test exception: " + e.message);
  }

  // ----------------------------------------------------
  // TEST 3: GET /api/rewards (Valid Request)
  // ----------------------------------------------------
  let firstReward = null;
  try {
    const res = await fetch(BASE_URL, { headers });
    const data = await res.json();
    assert(
      res.status === 200 &&
      data.success === true &&
      Array.isArray(data.data.rewards) &&
      data.data.rewards.length > 0,
      `GET /api/rewards returns status 200 and list of rewards (count: ${data.data?.rewards?.length})`
    );

    firstReward = data.data.rewards[0];
    assert(
      firstReward &&
      firstReward.title &&
      firstReward.rewardType === "coins" &&
      typeof firstReward.rewardValue === "number" &&
      firstReward.isClaimed === false &&
      firstReward.canClaim === true,
      `First reward is properly formatted: "${firstReward?.title}", value: ${firstReward?.rewardValue}, canClaim: ${firstReward?.canClaim}`
    );
  } catch (e) {
    assert(false, "GET /api/rewards exception: " + e.message);
  }

  // ----------------------------------------------------
  // TEST 4: GET /api/rewards/summary (Initial state)
  // ----------------------------------------------------
  try {
    const res = await fetch(`${BASE_URL}/summary`, { headers });
    const data = await res.json();
    assert(
      res.status === 200 &&
      data.success === true &&
      data.data.claimedRewards === 0 &&
      data.data.totalRewards > 0 &&
      data.data.availableRewards === data.data.totalRewards &&
      data.data.totalCoinsEarned === 0,
      `Initial summary: total=${data.data?.totalRewards}, claimed=${data.data?.claimedRewards}, available=${data.data?.availableRewards}, totalCoinsEarned=${data.data?.totalCoinsEarned}`
    );
  } catch (e) {
    assert(false, "GET /api/rewards/summary exception: " + e.message);
  }

  // ----------------------------------------------------
  // TEST 5: POST /api/rewards/:rewardId/claim (Valid Claim)
  // ----------------------------------------------------
  const initialCoins = (await User.findById(testUser._id)).coins;
  try {
    const res = await fetch(`${BASE_URL}/${firstReward._id}/claim`, {
      method: "POST",
      headers,
    });
    const data = await res.json();
    assert(
      res.status === 200 &&
      data.success === true &&
      data.data.reward._id.toString() === firstReward._id.toString() &&
      data.data.reward.rewardValue === firstReward.rewardValue,
      `POST /claim succeeded for reward "${firstReward.title}" (${firstReward.rewardValue} coins)`
    );

    const updatedUser = await User.findById(testUser._id);
    assert(
      updatedUser.coins === initialCoins + firstReward.rewardValue,
      `User coins increased from ${initialCoins} to ${updatedUser.coins}`
    );
  } catch (e) {
    assert(false, "POST /claim exception: " + e.message);
  }

  // ----------------------------------------------------
  // TEST 6: Duplicate Claim
  // ----------------------------------------------------
  try {
    const res = await fetch(`${BASE_URL}/${firstReward._id}/claim`, {
      method: "POST",
      headers,
    });
    const data = await res.json();
    assert(
      res.status === 400 &&
      data.success === false &&
      data.message === "Reward already claimed",
      `Duplicate claim returns 400 with message "Reward already claimed"`
    );
  } catch (e) {
    assert(false, "Duplicate claim exception: " + e.message);
  }

  // ----------------------------------------------------
  // TEST 7: GET /api/rewards (Check isClaimed updated)
  // ----------------------------------------------------
  try {
    const res = await fetch(BASE_URL, { headers });
    const data = await res.json();
    const updatedFirst = data.data.rewards.find((r) => r._id.toString() === firstReward._id.toString());
    assert(
      updatedFirst && updatedFirst.isClaimed === true && updatedFirst.canClaim === false,
      `Claimed reward now reflects isClaimed=true and canClaim=false`
    );
  } catch (e) {
    assert(false, "GET /api/rewards check exception: " + e.message);
  }

  // ----------------------------------------------------
  // TEST 8: GET /api/rewards/me (History)
  // ----------------------------------------------------
  try {
    const res = await fetch(`${BASE_URL}/me`, { headers });
    const data = await res.json();
    assert(
      res.status === 200 &&
      data.success === true &&
      Array.isArray(data.data.rewards) &&
      data.data.rewards.length === 1 &&
      data.data.rewards[0].rewardId === firstReward._id.toString(),
      `GET /api/rewards/me returns 1 claimed reward history entry matching claimed reward`
    );
  } catch (e) {
    assert(false, "GET /api/rewards/me exception: " + e.message);
  }

  // ----------------------------------------------------
  // TEST 9: Invalid Reward ID format
  // ----------------------------------------------------
  try {
    const res = await fetch(`${BASE_URL}/invalid-reward-id-123/claim`, {
      method: "POST",
      headers,
    });
    const data = await res.json();
    assert(
      res.status === 400 &&
      data.success === false &&
      data.message === "Invalid reward ID",
      `Invalid reward ID returns 400 with message "Invalid reward ID"`
    );
  } catch (e) {
    assert(false, "Invalid reward ID exception: " + e.message);
  }

  // ----------------------------------------------------
  // TEST 10: Non-existing Reward ID
  // ----------------------------------------------------
  try {
    const nonExistingId = new mongoose.Types.ObjectId();
    const res = await fetch(`${BASE_URL}/${nonExistingId}/claim`, {
      method: "POST",
      headers,
    });
    const data = await res.json();
    assert(
      res.status === 404 &&
      data.success === false &&
      data.message === "Reward not found",
      `Non-existing reward ID returns 404 with message "Reward not found"`
    );
  } catch (e) {
    assert(false, "Non-existing reward ID exception: " + e.message);
  }

  // ----------------------------------------------------
  // TEST 11: Inactive Reward
  // ----------------------------------------------------
  try {
    const inactiveReward = await Reward.create({
      title: "Expired Promo Reward",
      description: "This reward is inactive",
      rewardType: "coins",
      rewardValue: 50,
      icon: "expired",
      isActive: false,
    });

    const res = await fetch(`${BASE_URL}/${inactiveReward._id}/claim`, {
      method: "POST",
      headers,
    });
    const data = await res.json();
    assert(
      res.status === 400 &&
      data.success === false &&
      data.message.includes("not active"),
      `Inactive reward claim returns 400 ("Reward is currently not active")`
    );

    // Clean up test inactive reward
    await Reward.findByIdAndDelete(inactiveReward._id);
  } catch (e) {
    assert(false, "Inactive reward test exception: " + e.message);
  }

  // ----------------------------------------------------
  // TEST 12: GET /api/rewards/summary (Updated State)
  // ----------------------------------------------------
  try {
    const res = await fetch(`${BASE_URL}/summary`, { headers });
    const data = await res.json();
    assert(
      res.status === 200 &&
      data.success === true &&
      data.data.claimedRewards === 1 &&
      data.data.totalCoinsEarned === firstReward.rewardValue &&
      data.data.availableRewards === data.data.totalRewards - 1,
      `Updated summary: total=${data.data?.totalRewards}, claimed=${data.data?.claimedRewards}, available=${data.data?.availableRewards}, totalCoinsEarned=${data.data?.totalCoinsEarned}`
    );
  } catch (e) {
    assert(false, "GET /api/rewards/summary updated exception: " + e.message);
  }

  console.log("\n========================================");
  console.log(`TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log("========================================");

  await mongoose.disconnect();
  process.exit(failedCount > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
