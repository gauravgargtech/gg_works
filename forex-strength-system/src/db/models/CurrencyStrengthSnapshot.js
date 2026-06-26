const mongoose = require("mongoose");

const CurrencyScoreSchema = new mongoose.Schema(
  {
    currency: { type: String, required: true },
    technicalScore: { type: Number, default: 0 },
    fundamentalScore: { type: Number, default: 0 },
    sentimentScore: { type: Number, default: 0 },
    compositeScore: { type: Number, required: true },
    rank: { type: Number, required: true },
  },
  { _id: false }
);

const CurrencyStrengthSnapshotSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, default: Date.now, index: true },
    scores: [CurrencyScoreSchema],
    // raw inputs kept for auditability/debugging — LLM output especially
    // benefits from being able to trace back why a score landed where it did
    raw: {
      priceChanges: { type: mongoose.Schema.Types.Mixed }, // per granularity, per pair
      policyRates: { type: mongoose.Schema.Types.Mixed },
      longYields: { type: mongoose.Schema.Types.Mixed },
      sentimentDetail: { type: mongoose.Schema.Types.Mixed }, // per-currency LLM reasoning
    },
  },
  { timestamps: true, collection: "currency_strength_snapshots" }
);

// Use a MongoDB time-series collection if your MongoDB version supports it
// (v5+) — much more efficient for this append-only, time-indexed data:
//
// mongoose.connection.db.createCollection("currency_strength_snapshots", {
//   timeseries: { timeField: "timestamp", metaField: "scores", granularity: "minutes" },
// });
//
// Left as a manual step since it must be created before first insert and
// isn't something mongoose manages automatically.

module.exports = mongoose.model("CurrencyStrengthSnapshot", CurrencyStrengthSnapshotSchema);
