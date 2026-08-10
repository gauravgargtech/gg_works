const mongoose = require("mongoose");

// One document per cron run, taken from GET /v3/accounts/{id}/summary.
// This is what drives the equity curve and drawdown calculations,
// since OANDA doesn't expose historical balance directly.
const equitySnapshotSchema = new mongoose.Schema({
  accountId: { type: String, required: true },
  takenAt: { type: Date, required: true, default: Date.now, index: true },
  balance: { type: Number, required: true },
  nav: { type: Number, required: true },
  unrealizedPL: { type: Number, default: 0 },
  marginUsed: { type: Number, default: 0 },
  openTradeCount: { type: Number, default: 0 },
});

module.exports = mongoose.model("EquitySnapshot", equitySnapshotSchema);
