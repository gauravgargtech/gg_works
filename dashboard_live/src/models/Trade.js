const mongoose = require("mongoose");

// One document per OANDA trade (we only store CLOSED trades, since those
// are what performance metrics are computed from). tradeId is OANDA's own
// trade id and is used as the upsert key, so re-running the cron job is
// always idempotent.
const tradeSchema = new mongoose.Schema(
  {
    tradeId: { type: String, required: true, unique: true, index: true },
    accountId: { type: String, required: true },
    instrument: { type: String, required: true, index: true },

    // Direction is derived from the sign of initialUnits.
    direction: { type: String, enum: ["long", "short"], required: true },

    initialUnits: { type: Number, required: true },
    openPrice: { type: Number, required: true },
    averageClosePrice: { type: Number },

    openTime: { type: Date, required: true, index: true },
    closeTime: { type: Date, index: true },

    realizedPL: { type: Number, required: true },
    financing: { type: Number, default: 0 },

    // Convenience fields computed at ingest time so metrics queries
    // don't need to recompute them on every dashboard load.
    durationMs: { type: Number },
    isWin: { type: Boolean },

    raw: { type: mongoose.Schema.Types.Mixed }, // full OANDA payload, for debugging
  },
  { timestamps: true }
);

module.exports = mongoose.model("Trade", tradeSchema);
