"use strict";

const success = (res, { status = 200, message = "OK", data } = {}) => {
  const body = { success: true, message };
  if (data !== undefined) body.data = data;
  return res.status(status).json(body);
};

module.exports = { success };
