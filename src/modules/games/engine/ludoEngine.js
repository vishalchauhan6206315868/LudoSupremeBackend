"use strict";

/**
 * Pure Ludo rules. No database, no HTTP, no randomness inside -> trivially unit-testable.
 * The service layer loads state, calls these functions, and persists the result.
 */

const BOARD_TILES = 52;
const SAFE_TILES = [0, 8, 13, 21, 26, 34, 39, 47];
const SEAT_OFFSETS = [0, 13, 26, 39]; // Red=0, Green=1, Yellow=2, Blue=3
const HOME_STEP = 56; // 0 = start, 1..50 shared track, 51..55 private home column, 56 = home
const LAST_SHARED_STEP = 50;

// Points: dice value for every step, +56 when a token reaches home.
const WIN_LEADERBOARD_POINTS = 100;
const LOSS_LEADERBOARD_POINTS = -25;

class RuleViolation extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "RuleViolation";
    this.status = status;
  }
}

const sameUser = (a, b) => String(a) === String(b);

/** Global tile (0..51) a token stands on, or -1 when it is not on the shared track. */
const getGlobalBoardIndex = (seatIndex, step) => {
  if (step <= 0 || step > LAST_SHARED_STEP) return -1;
  return (SEAT_OFFSETS[seatIndex] + step) % BOARD_TILES;
};

const getMovableTokenIds = (tokens, diceValue) =>
  tokens.filter((t) => !t.isHome && t.step + diceValue <= HOME_STEP).map((t) => t.tokenId);

/**
 * Next player in seat order who has not surrendered.
 * Works with any seat layout (e.g. seats 0, 2, 3) - the old `(seat + i) % players.length`
 * logic silently skipped or repeated players when seats were not 0..n-1.
 */
const getNextActivePlayer = (players, currentSeat) => {
  const active = players
    .filter((p) => !p.hasSurrendered)
    .sort((a, b) => a.seatIndex - b.seatIndex);
  if (active.length === 0) return null;
  return active.find((p) => p.seatIndex > currentSeat) || active[0];
};

/**
 * Apply a token move. Mutates the token / scores of the passed players.
 * Throws RuleViolation for illegal moves.
 */
const applyMove = ({ players, userId, tokenId, diceValue }) => {
  const player = players.find((p) => sameUser(p.user, userId));
  if (!player) throw new RuleViolation("You are not a player in this session", 403);

  const token = player.tokens.find((t) => t.tokenId === Number(tokenId));
  if (!token) throw new RuleViolation("Token not found", 404);
  if (token.isHome) throw new RuleViolation("This token has already reached home");
  if (!Number.isInteger(diceValue) || diceValue < 1 || diceValue > 6) {
    throw new RuleViolation("No valid dice value to move with");
  }
  if (token.step + diceValue > HOME_STEP) {
    throw new RuleViolation("Move exceeds home boundary (needs exact number to reach home)");
  }

  const prevStep = token.step;
  const newStep = prevStep + diceValue;
  token.step = newStep;

  let pointsEarned = diceValue;
  if (newStep === HOME_STEP) {
    token.isHome = true;
    pointsEarned += HOME_STEP;
  }
  player.score += pointsEarned;

  // Capture: only on the shared track and never on a safe tile.
  let captured = null;
  if (newStep > 0 && newStep <= LAST_SHARED_STEP) {
    const myTile = getGlobalBoardIndex(player.seatIndex, newStep);
    if (!SAFE_TILES.includes(myTile)) {
      outer: for (const opponent of players) {
        if (sameUser(opponent.user, userId) || opponent.hasSurrendered) continue;
        for (const oppToken of opponent.tokens) {
          if (oppToken.step > 0 && oppToken.step <= LAST_SHARED_STEP) {
            if (getGlobalBoardIndex(opponent.seatIndex, oppToken.step) === myTile) {
              const pointsLost = oppToken.step;
              oppToken.step = 0;
              opponent.score = Math.max(0, opponent.score - pointsLost);
              captured = {
                opponentUser: opponent.user,
                opponentColor: opponent.color,
                pointsDeducted: pointsLost,
              };
              break outer;
            }
          }
        }
      }
    }
  }

  return {
    player,
    token,
    prevStep,
    newStep,
    pointsEarned,
    reachedHome: token.isHome,
    captured,
    allTokensHome: player.tokens.every((t) => t.isHome),
  };
};

/**
 * Final ranking + prize split. Pure and deterministic, so a crashed settlement can be
 * recomputed and paid again safely (payouts are idempotent per user).
 *
 *  - forcedWinnerId (all tokens home) always ranks first.
 *  - Otherwise: active players by score, then surrendered players by score.
 *  - Equal top score => draw: the pool is split evenly instead of an arbitrary player winning it all.
 *  - Rounding leftovers stay with the platform (never invented from thin air).
 */
const computeSettlement = ({ players, prizePool = 0, platformFeePercent = 0, forcedWinnerId = null }) => {
  const forced = forcedWinnerId ? String(forcedWinnerId) : null;
  const tierOf = (p) => (forced && String(p.user) === forced ? 0 : p.hasSurrendered ? 2 : 1);

  const sorted = [...players].sort((a, b) => {
    const tierDiff = tierOf(a) - tierOf(b);
    if (tierDiff !== 0) return tierDiff;
    if (b.score !== a.score) return b.score - a.score;
    return a.seatIndex - b.seatIndex;
  });

  // Competition ranking (1,1,3). A forced winner is never tied with anyone.
  const ranks = [];
  sorted.forEach((p, i) => {
    if (i === 0) return ranks.push(1);
    const prev = sorted[i - 1];
    const tied = tierOf(p) !== 0 && tierOf(p) === tierOf(prev) && p.score === prev.score;
    ranks.push(tied ? ranks[i - 1] : i + 1);
  });

  const winnerCount = ranks.filter((r) => r === 1).length;
  const feeBasisPoints = Math.round(platformFeePercent * 100);
  const distributable = Math.floor((prizePool * (10000 - feeBasisPoints)) / 10000);
  const prizeEach = winnerCount > 0 ? Math.floor(distributable / winnerCount) : 0;

  const ranking = sorted.map((p, i) => {
    const isTop = ranks[i] === 1;
    return {
      userId: p.user,
      rank: ranks[i],
      outcome: isTop ? (winnerCount > 1 ? "draw" : "win") : "loss",
      prize: isTop ? prizeEach : 0,
    };
  });

  return {
    ranking,
    isDraw: winnerCount > 1,
    winnerId: winnerCount === 1 ? sorted[0].user : null,
    distributable,
    prizeEach,
  };
};

module.exports = {
  BOARD_TILES,
  SAFE_TILES,
  SEAT_OFFSETS,
  HOME_STEP,
  LAST_SHARED_STEP,
  WIN_LEADERBOARD_POINTS,
  LOSS_LEADERBOARD_POINTS,
  RuleViolation,
  getGlobalBoardIndex,
  getMovableTokenIds,
  getNextActivePlayer,
  applyMove,
  computeSettlement,
};
