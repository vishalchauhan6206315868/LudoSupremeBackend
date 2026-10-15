"use strict";
/**
 * Create / promote / reset an admin. No passwords are hard-coded or printed.
 *
 *   ADMIN_EMAIL=you@company.com ADMIN_PASSWORD='Str0ng-Passw0rd!' node scripts/create-admin.js
 *   ADMIN_EMAIL=... ADMIN_ROLE=admin node scripts/create-admin.js            (default role: superadmin)
 *   ADMIN_EMAIL=... node scripts/create-admin.js --promote                    (existing admin -> ADMIN_ROLE)
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/create-admin.js --reset-password   (also signs out old sessions)
 */
require("dotenv").config();

const mongoose = require("mongoose");
const Admin = require("../src/modules/admin/models/admin.model");
const { isStrongPassword, POLICY_MSG } = require("../utils/passwordPolicy");

const fail = (msg) => {
  console.error(`Error: ${msg}`);
  process.exit(1);
};

async function main() {
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  const name = process.env.ADMIN_NAME || "Ludo Supreme Admin";
  const role = process.env.ADMIN_ROLE || "superadmin";
  const promote = process.argv.includes("--promote");
  const reset = process.argv.includes("--reset-password");

  if (!/^\S+@\S+\.\S+$/.test(email)) fail("ADMIN_EMAIL is required (a valid email).");
  if (!["admin", "superadmin"].includes(role)) fail("ADMIN_ROLE must be admin or superadmin.");
  if (!process.env.MONGO_URI) fail("MONGO_URI is not set.");

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });
  const existing = await Admin.findOne({ email }).select("+password");

  if (!existing) {
    if (!isStrongPassword(password)) fail(`ADMIN_PASSWORD: ${POLICY_MSG}.`);
    await new Admin({ name, email, password, role, isActive: true }).save();
    console.log(`Created ${role}: ${email}`);
  } else {
    let changed = false;
    if (promote && existing.role !== role) {
      existing.role = role;
      changed = true;
      console.log(`Role of ${email} set to ${role}`);
    }
    if (reset) {
      if (!isStrongPassword(password)) fail(`ADMIN_PASSWORD: ${POLICY_MSG}.`);
      existing.password = password;
      existing.tokensValidAfter = new Date();
      changed = true;
      console.log(`Password of ${email} reset; old sessions revoked`);
    }
    if (changed) await existing.save();
    else console.log(`Admin ${email} already exists (use --promote or --reset-password to change it).`);
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
