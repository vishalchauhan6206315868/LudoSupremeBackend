"use strict";

const config = require("../../../../config/env");
const AppError = require("../../../../utils/AppError");
const logger = require("../../../../utils/logger");
const { rollDie } = require("../../../../utils/secureRandom");

const GameSession = require("../models/GameSession");
const GameRoom = require("../../rooms/models/GameRoom");
const User = require("../../auth/models/User");
const walletService = require("../../wallet/services/wallet.service");
const leaderboardService = require("../../leaderboard/services/leaderboard.service");
const engine = require("../engine/ludoEngine");

const TURN_MS = () => config.game.turnTimeoutSeconds * 1000;
const newDeadline = () => new Date(Date.now() + TURN_MS());

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------
const loadSession = async (sessionId) => {
  const session = await GameSession.findById(sessionId);
  if (!session) throw new AppError("Game session not found", 404);
  return session;
};

const getPlayer = (session, userId) =>
  session.players.find((p) => String(p.user) === String(userId));

const assertParticipant = (session, userId) => {
  if (!getPlayer(session, userId)) {
    throw new AppError("You are not a player in this session", 403);
  }
};

const assertInProgress = (session) => {
  if (session.status !== "in_progress") {
    throw new AppError(`Match is already ${session.status}`, 400);
  }
};

const isMatchTimeOver = (session) =>
  (Date.now() - new Date(session.startedAt).getTime()) / 1000 >= session.matchDurationSeconds;

const remainingSeconds = (session) =>
  Math.max(
    0,
    Math.floor(session.matchDurationSeconds - (Date.now() - new Date(session.startedAt).getTime()) / 1000)
  );

const advanceTurn = (session) => {
  session.turnStatus = "WAITING_FOR_ROLL";
  session.lastDiceValue = null;
  const next = engine.getNextActivePlayer(session.players, session.currentTurnSeat);
  if (next) {
    session.currentTurnPlayer = next.user;
    session.currentTurnSeat = next.seatIndex;
    session.turnDeadline = newDeadline();
  }
};

const mapRuleViolation = (fn) => {
  try {
    return fn();
  } catch (error) {
    if (error instanceof engine.RuleViolation) throw new AppError(error.message, error.status);
    throw error;
  }
};

// ------------------------------------------------------------------
// Settlement (the part that moves coins) - exactly-once by construction
// ------------------------------------------------------------------

/**
 * Step 1 - CLAIM: atomically flip in_progress -> completed. Only ONE caller can win this,
 * no matter how many requests/instances race. $inc __v also invalidates any in-flight save().
 * Step 2 - FINISH: rank, pay (idempotent per user), apply stats once, close the room.
 * If the process dies between the steps, the sweeper calls finishSettlement() again;
 * every step is safe to repeat.
 */
const settleSession = async (sessionId, { forcedWinnerId = null, reason = "completed" } = {}) => {
  const claimed = await GameSession.findOneAndUpdate(
    { _id: sessionId, status: "in_progress" },
    {
      $set: {
        status: "completed",
        endedAt: new Date(),
        turnStatus: "TURN_COMPLETED",
        "settlement.reason": reason,
        "settlement.forcedWinner": forcedWinnerId || null,
      },
      $inc: { __v: 1 },
    },
    { returnDocument: "after" }
  );

  if (claimed) {
    try {
      await finishSettlement(sessionId);
    } catch (error) {
      // The match IS over and recorded; payout/stats will be retried by the sweeper.
      logger.error("settlement_failed_will_retry", { sessionId: String(sessionId), err: error });
    }
  }
  return GameSession.findById(sessionId);
};

const finishSettlement = async (sessionId) => {
  let session = await GameSession.findById(sessionId);
  if (!session || session.status !== "completed") return null;

  // --- rank + prizes (persisted once, so a retry pays the exact same amounts) ---
  if (session.players.some((p) => p.rank == null)) {
    const result = engine.computeSettlement({
      players: session.players,
      prizePool: session.prizePool,
      platformFeePercent: config.economy.platformFeePercent,
      forcedWinnerId: session.settlement?.forcedWinner || null,
    });
    for (const r of result.ranking) {
      const p = getPlayer(session, r.userId);
      p.rank = r.rank;
      p.outcome = r.outcome;
      p.prizeEarned = r.prize;
    }
    session.winner = result.winnerId;
    try {
      await session.save();
    } catch (error) {
      if (error.name !== "VersionError") throw error;
      // another finisher saved first - reload and continue with its numbers
      session = await GameSession.findById(sessionId);
    }
  }

  // --- pay out (idempotent: referenceId is unique per user) ---
  if (!session.isPrizeDistributed) {
    for (const p of session.players) {
      if (p.prizeEarned > 0) {
        await walletService.creditWallet(
          p.user,
          p.prizeEarned,
          "game_reward",
          `Prize for match ${session.roomCode}`,
          `prize:${session._id}`
        );
      }
    }
    await GameSession.updateOne(
      { _id: session._id, isPrizeDistributed: false },
      { $set: { isPrizeDistributed: true } }
    );
  }

  // --- stats: exactly once ---
  const firstToApply = await GameSession.findOneAndUpdate(
    { _id: session._id, statsApplied: { $ne: true } },
    { $set: { statsApplied: true } }
  );
  if (firstToApply) {
    const statField = { win: "statistics.wins", loss: "statistics.losses", draw: "statistics.draws" };
    await User.bulkWrite(
      session.players.map((p) => ({
        updateOne: {
          filter: { _id: p.user },
          update: { $inc: { [statField[p.outcome] || "statistics.losses"]: 1, "statistics.totalGames": 1 } },
        },
      }))
    );
    await Promise.all(
      session.players.map((p) => leaderboardService.recordResult(p.user, p.outcome || "loss"))
    );
  }

  await GameRoom.updateOne({ _id: session.room }, { $set: { status: "finished" } });
  return session;
};

/** Settle because exactly one (or zero) active players remain. */
const settleIfForfeit = async (session, reason) => {
  const active = session.players.filter((p) => !p.hasSurrendered);
  if (active.length > 1) return false;
  await settleSession(session._id, {
    forcedWinnerId: active.length === 1 ? active[0].user : null,
    reason,
  });
  return true;
};

const settleIfTimeUp = async (session) => {
  if (session.status === "in_progress" && isMatchTimeOver(session)) {
    await settleSession(session._id, { reason: "time_up" });
    return true;
  }
  return false;
};

// ------------------------------------------------------------------
// 1. Start
// ------------------------------------------------------------------
const startGame = async (userId, roomCode) => {
  const room = await GameRoom.findOne({ roomCode });
  if (!room) throw new AppError("Game room not found", 404);

  if (!room.players.some((p) => String(p.user) === String(userId))) {
    throw new AppError("You are not a participant in this room", 403);
  }

  const existing = await GameSession.findOne({ room: room._id, status: "in_progress" });
  if (existing) return { session: existing, created: false };

  const isHost = String(room.host) === String(userId);
  const isFull = room.players.length >= room.maxPlayers;
  if (!isHost && !isFull) {
    throw new AppError("Only the host can start the match before the room is full", 403);
  }
  if (room.players.length < 2) {
    throw new AppError("At least 2 players are required to start the match", 400);
  }

  // Lock the room atomically: nobody can join/leave once it is "playing".
  const locked = await GameRoom.findOneAndUpdate(
    { _id: room._id, status: { $in: ["waiting", "starting"] }, "players.1": { $exists: true } },
    { $set: { status: "playing" } },
    { returnDocument: "after" }
  );
  if (!locked) {
    const raced = await GameSession.findOne({ room: room._id, status: "in_progress" });
    if (raced) return { session: raced, created: false };
    throw new AppError(`Cannot start match: room is '${room.status}'`, 400);
  }

  const seated = [...locked.players].sort((a, b) => a.seatIndex - b.seatIndex);
  const first = seated[0];

  // Prize pool = fees actually collected. (Old code used entryFee * maxPlayers, which minted
  // coins whenever a 4-player room started with fewer players.)
  const prizePool = locked.entryFee * seated.length;

  try {
    const session = await GameSession.create({
      room: locked._id,
      roomCode: locked.roomCode,
      gameMode: locked.maxPlayers === 4 ? "fourPlayer" : "twoPlayer",
      entryFee: locked.entryFee,
      prizePool,
      status: "in_progress",
      matchDurationSeconds: config.game.matchDurationSeconds,
      startedAt: new Date(),
      currentTurnPlayer: first.user,
      currentTurnSeat: first.seatIndex,
      turnStatus: "WAITING_FOR_ROLL",
      turnDeadline: newDeadline(),
      players: seated.map((p) => ({
        user: p.user,
        name: p.name,
        avatar: p.avatar || "",
        seatIndex: p.seatIndex,
        color: p.color,
        score: 0,
        tokens: [0, 1, 2, 3].map((tokenId) => ({ tokenId, step: 0, isHome: false })),
        missedTurns: 0,
        hasSurrendered: false,
      })),
    });
    return { session, created: true };
  } catch (error) {
    // undo the lock so the room is not stuck in "playing" without a session
    await GameRoom.updateOne(
      { _id: locked._id, status: "playing" },
      { $set: { status: locked.players.length >= locked.maxPlayers ? "starting" : "waiting" } }
    );
    if (error.code === 11000) {
      const raced = await GameSession.findOne({ room: locked._id, status: "in_progress" });
      if (raced) return { session: raced, created: false };
    }
    throw error;
  }
};

// ------------------------------------------------------------------
// 2. Read state (participants only)
// ------------------------------------------------------------------
const getSession = async (userId, sessionId) => {
  let session = await loadSession(sessionId);
  assertParticipant(session, userId);

  if (await settleIfTimeUp(session)) {
    session = await loadSession(sessionId);
  }

  const populated = await GameSession.findById(sessionId)
    .populate("players.user", "name avatar username")
    .populate("winner", "name avatar");

  return { session: populated, remainingTimeSeconds: remainingSeconds(session) };
};

// ------------------------------------------------------------------
// 3. Roll dice
// ------------------------------------------------------------------
const rollDice = async (userId, sessionId) => {
  const session = await loadSession(sessionId);
  assertInProgress(session);

  if (await settleIfTimeUp(session)) {
    throw new AppError("Match time is over", 400);
  }
  if (String(session.currentTurnPlayer) !== String(userId)) {
    throw new AppError("It is not your turn to roll the dice", 403);
  }
  if (session.turnStatus !== "WAITING_FOR_ROLL") {
    throw new AppError("Dice already rolled. Please move a token.", 400, {
      data: { diceValue: session.lastDiceValue },
    });
  }

  const diceValue = rollDie(); // crypto-grade randomness, decided on the server only
  const currentPlayer = getPlayer(session, userId);
  session.lastDiceValue = diceValue;

  // Rule: three consecutive 6s forfeits the turn.
  if (diceValue === 6) {
    session.consecutiveSixes += 1;
    if (session.consecutiveSixes >= 3) {
      session.consecutiveSixes = 0;
      advanceTurn(session);
      session.history.push({ player: userId, action: "PASS", diceValue: 6, timestamp: new Date() });
      await session.save();
      return {
        message: "Three consecutive 6s! Turn forfeited to next player.",
        data: {
          diceValue: 6,
          consecutiveSixes: 3,
          turnPassed: true,
          currentTurnPlayer: session.currentTurnPlayer,
          currentTurnSeat: session.currentTurnSeat,
        },
      };
    }
  } else {
    session.consecutiveSixes = 0;
  }

  const movableTokenIds = engine.getMovableTokenIds(currentPlayer.tokens, diceValue);

  if (movableTokenIds.length === 0) {
    advanceTurn(session);
    session.history.push({ player: userId, action: "PASS", diceValue, timestamp: new Date() });
    await session.save();
    return {
      message: `Rolled ${diceValue}. No valid moves available. Turn passed.`,
      data: {
        diceValue,
        movableTokenIds: [],
        turnPassed: true,
        currentTurnPlayer: session.currentTurnPlayer,
        currentTurnSeat: session.currentTurnSeat,
      },
    };
  }

  session.turnStatus = "WAITING_FOR_MOVE";
  session.turnDeadline = newDeadline();
  session.history.push({ player: userId, action: "ROLL", diceValue, timestamp: new Date() });
  await session.save();

  return {
    message: `Rolled ${diceValue}. Choose a token to move.`,
    data: {
      diceValue,
      movableTokenIds,
      turnStatus: session.turnStatus,
      turnDeadline: session.turnDeadline,
    },
  };
};

// ------------------------------------------------------------------
// 4. Move token
// ------------------------------------------------------------------
const moveToken = async (userId, sessionId, tokenId) => {
  const session = await loadSession(sessionId);
  assertInProgress(session);

  if (await settleIfTimeUp(session)) {
    throw new AppError("Match time is over", 400);
  }
  if (String(session.currentTurnPlayer) !== String(userId)) {
    throw new AppError("It is not your turn to move", 403);
  }
  if (session.turnStatus !== "WAITING_FOR_MOVE") {
    throw new AppError("Please roll the dice before moving a token", 400);
  }

  const diceValue = session.lastDiceValue;
  const move = mapRuleViolation(() =>
    engine.applyMove({ players: session.players, userId, tokenId, diceValue })
  );

  const getsExtraTurn =
    (diceValue === 6 && session.consecutiveSixes < 3) || move.reachedHome || Boolean(move.captured);

  if (move.allTokensHome) {
    // persist the winning move, then close the match with this player as forced winner
    session.turnStatus = "TURN_COMPLETED";
    session.history.push({
      player: userId, action: "MOVE", diceValue, tokenId: Number(tokenId),
      prevStep: move.prevStep, newStep: move.newStep, pointsEarned: move.pointsEarned, timestamp: new Date(),
    });
    move.player.missedTurns = 0;
    await session.save();

    const finished = await settleSession(session._id, { forcedWinnerId: userId, reason: "all_tokens_home" });
    return {
      message: "All tokens reached home! You won the game!",
      data: { session: finished, gameCompleted: true, winner: finished.winner },
    };
  }

  if (getsExtraTurn) {
    session.turnStatus = "WAITING_FOR_ROLL";
    session.lastDiceValue = null;
    session.turnDeadline = newDeadline();
  } else {
    session.consecutiveSixes = 0;
    advanceTurn(session);
  }

  move.player.missedTurns = 0;
  session.history.push({
    player: userId, action: "MOVE", diceValue, tokenId: Number(tokenId),
    prevStep: move.prevStep, newStep: move.newStep, pointsEarned: move.pointsEarned, timestamp: new Date(),
  });
  await session.save();

  return {
    message: getsExtraTurn
      ? "Move successful! You earned an extra turn!"
      : "Move successful! Turn passed to next player.",
    data: {
      session,
      move: {
        tokenId: Number(tokenId),
        prevStep: move.prevStep,
        newStep: move.newStep,
        pointsEarned: move.pointsEarned,
        captured: move.captured,
        getsExtraTurn,
      },
    },
  };
};

// ------------------------------------------------------------------
// 5. Turn timeout (called by a client AND by the server-side sweeper)
// ------------------------------------------------------------------
const turnIsOverdue = (session, now = Date.now(), graceMs = config.game.turnTimeoutGraceMs) =>
  session.turnDeadline && now >= new Date(session.turnDeadline).getTime() - graceMs;

/** Applies the penalty for the current player. Caller must have verified the deadline passed. */
const applyTurnTimeout = async (session) => {
  const currentPlayer = getPlayer(session, session.currentTurnPlayer);

  if (currentPlayer) {
    currentPlayer.missedTurns += 1;
    if (currentPlayer.missedTurns >= 3) currentPlayer.hasSurrendered = true; // auto-forfeit
  }

  session.history.push({
    player: currentPlayer ? currentPlayer.user : null,
    action: "TIMEOUT",
    timestamp: new Date(),
  });

  const activeCount = session.players.filter((p) => !p.hasSurrendered).length;
  if (activeCount > 1) {
    session.consecutiveSixes = 0;
    advanceTurn(session);
    await session.save();
    return { gameCompleted: false, session };
  }

  await session.save(); // persist the surrender flags first
  const finished = await settleSession(session._id, {
    forcedWinnerId: activeCount === 1 ? session.players.find((p) => !p.hasSurrendered).user : null,
    reason: "forfeit",
  });
  return { gameCompleted: true, session: finished };
};

const handleTurnTimeout = async (userId, sessionId) => {
  const session = await loadSession(sessionId);
  assertParticipant(session, userId); // outsiders can no longer kick players out of a match
  assertInProgress(session);

  if (await settleIfTimeUp(session)) {
    return { gameCompleted: true, session: await loadSession(sessionId) };
  }
  if (!turnIsOverdue(session)) {
    throw new AppError("The current turn has not timed out yet", 400);
  }
  return applyTurnTimeout(session);
};

// ------------------------------------------------------------------
// 6. Surrender
// ------------------------------------------------------------------
const surrenderMatch = async (userId, sessionId) => {
  const session = await loadSession(sessionId);
  assertInProgress(session);

  const player = getPlayer(session, userId);
  if (!player) throw new AppError("You are not a player in this session", 400);

  player.hasSurrendered = true;
  session.history.push({ player: userId, action: "SURRENDER", timestamp: new Date() });

  const wasTheirTurn = String(session.currentTurnPlayer) === String(userId);
  const activeCount = session.players.filter((p) => !p.hasSurrendered).length;

  if (activeCount <= 1) {
    await session.save();
    const finished = await settleSession(session._id, {
      forcedWinnerId: activeCount === 1 ? session.players.find((p) => !p.hasSurrendered).user : null,
      reason: "forfeit",
    });
    return { gameCompleted: true, session: finished };
  }

  if (wasTheirTurn) advanceTurn(session);
  await session.save();
  return { gameCompleted: false, session };
};

// ------------------------------------------------------------------
// 7. Complete (client says "time is up")
// ------------------------------------------------------------------
const completeMatch = async (userId, sessionId) => {
  let session = await loadSession(sessionId);
  assertParticipant(session, userId);

  if (session.status === "completed") return session; // idempotent
  assertInProgress(session);

  // A match can only be force-closed once its time is really over. Previously ANY logged-in
  // user could end ANY match at ANY moment and the current score leader got the prize pool.
  if (!isMatchTimeOver(session)) {
    throw new AppError("Match is still in progress. Use surrender to leave early.", 400);
  }
  await settleSession(session._id, { reason: "time_up" });
  session = await loadSession(sessionId);
  return session;
};

// ------------------------------------------------------------------
// 8. History
// ------------------------------------------------------------------
const getHistory = async (userId, pageRaw, limitRaw) => {
  const page = Math.max(1, parseInt(pageRaw, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(limitRaw, 10) || 10));
  const filter = { "players.user": userId, status: "completed" };

  const [totalMatches, matches] = await Promise.all([
    GameSession.countDocuments(filter),
    GameSession.find(filter)
      .populate("winner", "name avatar username")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
  ]);

  const formatted = matches.map((m) => {
    const me = m.players.find((p) => String(p.user) === String(userId));
    const outcome = me?.outcome || (m.winner && String(m.winner._id) === String(userId) ? "win" : "loss");
    return {
      sessionId: m._id,
      roomCode: m.roomCode,
      gameMode: m.gameMode,
      entryFee: m.entryFee,
      prizePool: m.prizePool,
      score: me ? me.score : 0,
      rank: me ? me.rank : null,
      outcome,
      isWinner: outcome === "win",
      prizeEarned: me ? me.prizeEarned : 0,
      playedAt: m.createdAt,
    };
  });

  return { totalMatches, currentPage: page, totalPages: Math.ceil(totalMatches / limit), matches: formatted };
};

module.exports = {
  startGame,
  getSession,
  rollDice,
  moveToken,
  handleTurnTimeout,
  surrenderMatch,
  completeMatch,
  getHistory,
  // used by the sweeper
  settleSession,
  finishSettlement,
  applyTurnTimeout,
  turnIsOverdue,
  isMatchTimeOver,
};
