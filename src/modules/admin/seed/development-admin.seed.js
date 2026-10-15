"use strict";

const config = require("../../../../config/env");
const logger = require("../../../../utils/logger");
const Admin = require("../models/admin.model");

const DEVELOPMENT_ADMIN = {
  name: "Development Test Admin",
  email: "test@test.com",
  password: "test123",
  role: "superadmin",
};

const seedDevelopmentAdmin = async () => {
  if (config.env !== "development") {
    throw new Error("The development admin seed can only run in development mode");
  }

  if (await Admin.exists({ email: DEVELOPMENT_ADMIN.email })) {
    return false;
  }

  const admin = new Admin(DEVELOPMENT_ADMIN);
  try {
    await admin.save();
    logger.info("development_admin_seeded", { email: DEVELOPMENT_ADMIN.email });
    return true;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
};

module.exports = { seedDevelopmentAdmin };
