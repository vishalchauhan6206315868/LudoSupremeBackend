"use strict";

const crypto = require("crypto");
const config = require("../../../../config/env");
const AppError = require("../../../../utils/AppError");
const logger = require("../../../../utils/logger");
const { generateRoomCode } = require("../../../../utils/secureRandom");

const GameRoom = require("../models/GameRoom");
const walletService = require("../../wallet/services/wallet.service");

const COLOR_PALETTE = [
  { seatIndex: 0, color: "Red" },
  { seatIndex: 1, color: "Green" },
  { seatIndex: 2, color: "Yellow" },
  { seatIndex: 3, color: "Blue" },
];

const ACTIVE_STATUSES = ["waiting", "starting", "playing"];

// ------------------------------------------------------------------
// entry fee helpers (all coin movement goes through the wallet ledger)
// ------------------------------------------------------------------
const payEntryFee = async (userId, fee, label) => {
  if (!(fee > 0)) return null;
  try {
    const { wallet } = await walletService.debitWallet(userId, fee, "game_entry", `Entry fee: ${label}`);
    return wallet.balance;
  } catch (error) {
    if (error instanceof AppError && error.status === 400 && /Insufficient/.test(error.message)) {
      const available = await walletService.getBalance(userId);
      throw new AppError(`Insufficient coins. Required: ${fee}, Available: ${available}`, 400);
    }
    throw error;
  }
};

const refundEntryFee = async (userId, fee, label, referenceId) => {
  if (!(fee > 0)) return null;
  const { wallet } = await walletService.creditWallet(
    userId,
    fee,
    "refund",
    `Entry fee refund: ${label}`,
    referenceId
  );
  return wallet.balance;
};

/** Refund after a failed step; never throws (but screams in the logs for manual follow-up). */
const safeRefund = async (userId, fee, label) => {
  try {
    await refundEntryFee(userId, fee, label, `refund:rollback:${crypto.randomUUID()}`);
  } catch (error) {
    logger.error("REFUND_FAILED_MANUAL_ACTION_REQUIRED", { userId: String(userId), fee, label, err: error });
  }
};

/**
 * Cancel a waiting/starting room and refund EVERY player exactly once.
 * (Old code cancelled a host's previous room when they created a new one without refunding anyone.)
 */
const cancelRoomAndRefund = async (room, label = "room cancelled") => {
  const cancelled = await GameRoom.findOneAndUpdate(
    { _id: room._id, status: { $in: ["waiting", "starting"] } },
    { $set: { status: "cancelled" } },
    { returnDocument: "after" }
  );
  if (!cancelled) {
    throw new AppError("Room can no longer be cancelled (the match may have started)", 400);
  }

  for (const player of cancelled.players) {
    try {
      // referenceId is unique per user => a retry can never refund twice
      await refundEntryFee(player.user, cancelled.entryFee, `${label} (${cancelled.roomCode})`, `refund:cancel:${cancelled._id}`);
    } catch (error) {
      logger.error("REFUND_FAILED_MANUAL_ACTION_REQUIRED", {
        userId: String(player.user), roomId: String(cancelled._id), err: error,
      });
    }
  }
  return cancelled;
};

// ------------------------------------------------------------------
// 1. Create
// ------------------------------------------------------------------
const createRoom = async (user, body) => {
  const userId = user._id;
  const maxPlayers = body.maxPlayers ? Number(body.maxPlayers) : 2;
  const gameMode = maxPlayers === 4 ? "fourPlayer" : "twoPlayer";
  const entryFee = body.entryFee ? Number(body.entryFee) : 0;

  const activeRoom = await GameRoom.findOne({ "players.user": userId, status: { $in: ACTIVE_STATUSES } });
  if (activeRoom) {
    if (activeRoom.status === "waiting" && String(activeRoom.host) === String(userId)) {
      await cancelRoomAndRefund(activeRoom, "host created a new room");
    } else {
      throw new AppError(
        `You are already in an active room (${activeRoom.roomCode}). Please leave or finish it first.`,
        400,
        { data: { roomCode: activeRoom.roomCode } }
      );
    }
  }

  let balance = await payEntryFee(userId, entryFee, "new room");

  let room = null;
  try {
    for (let attempt = 0; attempt < 5 && !room; attempt++) {
      try {
        room = await GameRoom.create({
          roomCode: generateRoomCode(),
          host: userId,
          players: [
            {
              user: userId,
              name: user.name,
              avatar: user.avatar || "",
              seatIndex: 0,
              color: "Red",
              isReady: true,
              isHost: true,
            },
          ],
          maxPlayers,
          gameMode,
          entryFee,
          // The pool is recalculated from fees actually collected when the match starts.
          prizePool: entryFee * maxPlayers,
          status: "waiting",
        });
      } catch (error) {
        if (error.code !== 11000) throw error; // room code collision -> retry with a new code
      }
    }
    if (!room) throw new AppError("Failed to generate unique room code. Please try again.", 500);
  } catch (error) {
    await safeRefund(userId, entryFee, "room creation failed");
    throw error;
  }

  if (balance === null) balance = await walletService.getBalance(userId);
  return { room, userCoins: balance };
};

// ------------------------------------------------------------------
// 2. Join
// ------------------------------------------------------------------
const joinRoom = async (user, roomCodeRaw) => {
  const userId = user._id;
  const roomCode = roomCodeRaw.trim().toUpperCase();

  const room = await GameRoom.findOne({ roomCode });
  if (!room) throw new AppError("Room not found. Please check the room code.", 404);

  if (room.status !== "waiting") {
    throw new AppError(`Cannot join room. Match status is already '${room.status}'.`, 400);
  }
  if (room.players.some((p) => String(p.user) === String(userId))) {
    return { room, alreadyInRoom: true };
  }

  const inAnotherRoom = await GameRoom.findOne({
    _id: { $ne: room._id },
    "players.user": userId,
    status: { $in: ACTIVE_STATUSES },
  });
  if (inAnotherRoom) {
    throw new AppError(
      `You are already part of another active room (${inAnotherRoom.roomCode}). Please leave it before joining.`,
      400
    );
  }
  if (room.players.length >= room.maxPlayers) throw new AppError("Room is already full.", 400);

  // Pay first (atomic, cannot overdraw) ...
  let balance = await payEntryFee(userId, room.entryFee, `room ${room.roomCode}`);

  // ... then claim a seat atomically. Anything that goes wrong after paying => refund.
  let updated = null;
  try {
    for (let attempt = 0; attempt < 4 && !updated; attempt++) {
      const fresh = attempt === 0 ? room : await GameRoom.findOne({ roomCode });
      if (!fresh || fresh.status !== "waiting") {
        throw new AppError(`Cannot join room. Match status is already '${fresh ? fresh.status : "cancelled"}'.`, 400);
      }
      if (fresh.players.some((p) => String(p.user) === String(userId))) {
        // a parallel request of the same user won; ours was a duplicate
        await safeRefund(userId, room.entryFee, "duplicate join request");
        return { room: fresh, alreadyInRoom: true };
      }
      if (fresh.players.length >= fresh.maxPlayers) throw new AppError("Room is already full.", 400);

      const taken = fresh.players.map((p) => p.seatIndex);
      const slot = COLOR_PALETTE.find((s) => !taken.includes(s.seatIndex));
      if (!slot) throw new AppError("Room is already full.", 400);

      updated = await GameRoom.findOneAndUpdate(
        {
          _id: fresh._id,
          status: "waiting",
          "players.user": { $ne: userId },
          "players.seatIndex": { $ne: slot.seatIndex },
          $expr: { $lt: [{ $size: "$players" }, "$maxPlayers"] },
        },
        {
          $push: {
            players: {
              user: userId,
              name: user.name,
              avatar: user.avatar || "",
              seatIndex: slot.seatIndex,
              color: slot.color,
              isReady: true,
              isHost: false,
            },
          },
        },
        { returnDocument: "after" }
      );
    }
    if (!updated) throw new AppError("Could not join the room right now. Please try again.", 409);
  } catch (error) {
    await safeRefund(userId, room.entryFee, `join failed (${room.roomCode})`);
    throw error;
  }

  if (updated.players.length >= updated.maxPlayers) {
    const starting = await GameRoom.findOneAndUpdate(
      { _id: updated._id, status: "waiting" },
      { $set: { status: "starting" } },
      { returnDocument: "after" }
    );
    if (starting) updated = starting;
  }

  const me = updated.players.find((p) => String(p.user) === String(userId));
  if (balance === null) balance = await walletService.getBalance(userId);
  return { room: updated, alreadyInRoom: false, assignedColor: me.color, seatIndex: me.seatIndex, userCoins: balance };
};

// ------------------------------------------------------------------
// 3. Details
// ------------------------------------------------------------------
const getRoomDetails = async (roomCodeRaw) => {
  const room = await GameRoom.findOne({ roomCode: roomCodeRaw.trim().toUpperCase() }).populate(
    "host",
    "name avatar" // email intentionally NOT exposed to other players
  );
  if (!room) throw new AppError("Room not found", 404);
  return room;
};

// ------------------------------------------------------------------
// 4. Leave / cancel
// ------------------------------------------------------------------
const leaveRoom = async (user, roomCodeRaw) => {
  const userId = user._id;
  const room = await GameRoom.findOne({ roomCode: roomCodeRaw.trim().toUpperCase() });
  if (!room) throw new AppError("Room not found", 404);

  if (!room.players.some((p) => String(p.user) === String(userId))) {
    throw new AppError("You are not a player in this room", 400);
  }
  if (room.status !== "waiting" && room.status !== "starting") {
    throw new AppError("Cannot leave room while match is in progress or finished", 400);
  }

  if (String(room.host) === String(userId)) {
    const cancelled = await cancelRoomAndRefund(room, "cancelled by host");
    return { room: cancelled, hostCancelled: true };
  }

  const updated = await GameRoom.findOneAndUpdate(
    { _id: room._id, status: { $in: ["waiting", "starting"] }, "players.user": userId },
    { $pull: { players: { user: userId } }, $set: { status: "waiting" } },
    { returnDocument: "after" }
  );
  if (!updated) throw new AppError("Cannot leave room while match is in progress or finished", 400);

  // $pull succeeded exactly once => safe to refund exactly once
  const balance =
    (await refundEntryFee(userId, room.entryFee, `left room ${room.roomCode}`, `refund:leave:${room._id}:${crypto.randomUUID()}`)) ??
    (await walletService.getBalance(userId));

  return { room: updated, hostCancelled: false, userCoins: balance };
};

// ------------------------------------------------------------------
// Background cleanup: rooms nobody started would hold players' entry fees forever
// ------------------------------------------------------------------
const cancelStaleRooms = async () => {
  const cutoff = new Date(Date.now() - config.economy.roomWaitingTtlMinutes * 60_000);
  const stale = await GameRoom.find({
    status: { $in: ["waiting", "starting"] },
    updatedAt: { $lt: cutoff },
  }).limit(50);

  let cancelled = 0;
  for (const room of stale) {
    try {
      await cancelRoomAndRefund(room, "room expired");
      cancelled += 1;
    } catch (error) {
      if (!(error instanceof AppError)) logger.error("stale_room_cancel_failed", { roomId: String(room._id), err: error });
    }
  }
  return cancelled;
};

module.exports = { createRoom, joinRoom, getRoomDetails, leaveRoom, cancelStaleRooms, cancelRoomAndRefund };
