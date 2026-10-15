"use strict";

module.exports = (req, res) => {
  res.status(404).json({
    success: false,
    message: "API Route Not Found",
    path: req.originalUrl.split("?")[0],
  });
};
