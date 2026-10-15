"use strict";

/**
 * Server-side referee. There is no websocket layer yet, so without this job a match whose
 * players closed the app would stay "in_progress" forever and their entry fees would stay
 * locked. Every tick it:
 *   1. closes matches whose clock ran out            (settle by score)
 *   2. applies timeouts on overdue turns             (3 misses => auto-forfeit)
 *   3. finishes settlements that crashed half-way    (idempotent payout + stats)
 *   4. cancels + refunds rooms nobody started        (every ~60 s)
 *
 * Safe to run on several instances at once: every state change is an atomic claim or an
 * optimistic-concurrency save, so losers simply get a VersionError and skip.
 */

const config = require("../config/env");
const logger = require("../utils/logger");
const GameSession = require("../src/modules/games/models/GameSession");
const gameService = require("../src/modules/games/services/game.service");
const roomService = require("../src/modules/rooms/services/room.service");

const BATCH = 100;
let lastRoomCleanup = 0;

const sweepOnce = async () => {
  const now = Date.now();
  const stats = { matchesClosed: 0, turnsTimedOut: 0, settlementsRecovered: 0, roomsCancelled: 0 };

  // 1) match clock expired
  const expired = await GameSession.find({
    status: "in_progress",
    $expr: {
      $lte: [{ $add: ["$startedAt", { $multiply: ["$matchDurationSeconds", 1000] }] }, new Date(now)],
    },
  })
    .select("_id")
    .limit(BATCH)
    .lean();

  for (const { _id } of expired) {
    try {
      await gameService.settleSession(_id, { reason: "time_up" });
      stats.matchesClosed += 1;
    } catch (error) {
      logger.error("sweeper_close_match_failed", { sessionId: String(_id), err: error });
    }
  }

  // 2) overdue turns (server waits a grace period so a slow-but-valid move is not stolen)
  const overdue = await GameSession.find({
    status: "in_progress",
    turnDeadline: { $lt: new Date(now - config.game.turnTimeoutGraceMs) },
  }).limit(BATCH);

  for (const session of overdue) {
    try {
      await gameService.applyTurnTimeout(session);
      stats.turnsTimedOut += 1;
    } catch (error) {
      // VersionError = a player acted at the last moment; that is fine.
      if (error.name !== "VersionError") {
        logger.error("sweeper_turn_timeout_failed", { sessionId: String(session._id), err: error });
      }
    }
  }

  // 3) settlements that did not finish (crash between "claim" and "pay")
  const unfinished = await GameSession.find({
    status: "completed",
    "settlement.reason": { $ne: null }, // only sessions created by the new settlement code
    $or: [{ isPrizeDistributed: false }, { statsApplied: { $ne: true } }],
    endedAt: { $lt: new Date(now - 60_000) },
  })
    .select("_id")
    .limit(50)
    .lean();

  for (const { _id } of unfinished) {
    try {
      await gameService.finishSettlement(_id);
      stats.settlementsRecovered += 1;
    } catch (error) {
      logger.error("sweeper_recover_settlement_failed", { sessionId: String(_id), err: error });
    }
  }

  // 4) stale rooms
  if (now - lastRoomCleanup > 60_000) {
    lastRoomCleanup = now;
    try {
      stats.roomsCancelled = await roomService.cancelStaleRooms();
    } catch (error) {
      logger.error("sweeper_room_cleanup_failed", { err: error });
    }
  }

  return stats;
};

const start = () => {
  let stopped = false;
  let timer = null;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const s = await sweepOnce();
      if (s.matchesClosed || s.turnsTimedOut || s.settlementsRecovered || s.roomsCancelled) {
        logger.info("sweeper_tick", s);
      }
    } catch (error) {
      logger.error("sweeper_tick_failed", { err: error });
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(tick, config.game.sweeperIntervalMs);
        timer.unref();
      }
    }
  };

  timer = setTimeout(tick, 1000);
  timer.unref();
  logger.info("sweeper_started", { intervalMs: config.game.sweeperIntervalMs });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
};

module.exports = { start, sweepOnce };
