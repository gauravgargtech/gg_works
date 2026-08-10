const express = require("express");
const { computeMetrics } = require("../services/metrics");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const accountId = process.env.OANDA_ACCOUNT_ID;
    const metrics = await computeMetrics(accountId);
    res.render("dashboard", { metrics, accountId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
