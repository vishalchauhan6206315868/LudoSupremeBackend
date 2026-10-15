"use strict";

const crypto = require("crypto");

// Math.random() is predictable. Anything that decides a game outcome or acts as a
// secret (dice, room codes) must use the OS CSPRNG.
const rollDie = () => crypto.randomInt(1, 7);

// No 0/O/1/I so codes are easy to read out loud.
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const generateRoomCode = (length = 6) => {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += ROOM_CODE_ALPHABET[crypto.randomInt(0, ROOM_CODE_ALPHABET.length)];
  }
  return code;
};

module.exports = { rollDie, generateRoomCode };
