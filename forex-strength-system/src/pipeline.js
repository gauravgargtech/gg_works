const { getPriceChanges } = require("./services/oanda");
const { computeBlendedCSI } = require("./services/csi");
const { getFundamentalScores } = require("./services/fred");
const { getTaggedHeadlines } = require("./services/news");
const { scoreAllCurrencies } = require("./services/sentiment");
const { computeComposite } = require("./services/composite");
const CurrencyStrengthSnapshot = require("./db/models/CurrencyStrengthSnapshot");
const { CURRENCIES } = require("./config");

/**
 * Cheap, frequent run: technical-only score. Use this on a short cron
 * (e.g. every 15 min) since it's just OANDA candle pulls + math, no
 * external rate limits to worry about.
 */
async function runTechnicalOnly() {
  console.log("[pipeline] running technical-only update...");
  const priceChanges = await getPriceChanges();
  const { blended } = computeBlendedCSI(priceChanges);

  const { ranked } = computeComposite({ technical: blended });
  console.log("[pipeline] technical-only ranking:", ranked.map((r) => `${r.currency}:${r.score}`).join(" "));
  return { technical: blended, priceChanges };
}

/**
 * Full run: technical + fundamental (FRED) + sentiment (Groq on news).
 * Heavier and slower — run this on a sparser cron (e.g. every 4 hours).
 */
async function runFullPipeline() {
  console.log("[pipeline] running full pipeline...");

  const [priceChanges, fundamentalResult, taggedNews] = await Promise.all([
    getPriceChanges(),
    getFundamentalScores(),
    getTaggedHeadlines(),
  ]);

  const { blended: technical } = computeBlendedCSI(priceChanges);
  const { fundamental, raw: fundamentalRaw } = fundamentalResult;
  const sentimentRaw = await scoreAllCurrencies(taggedNews.byCurrency);

  // sentimentRaw contains both numeric scores per currency AND `${currency}_detail`
  // objects — separate them before passing into the composite calculator
  const sentiment = {};
  const sentimentDetail = {};
  for (const c of CURRENCIES) {
    sentiment[c] = sentimentRaw[c];
    sentimentDetail[c] = sentimentRaw[`${c}_detail`];
  }

  const { composite, ranked } = computeComposite({ technical, fundamental, sentiment });

  const doc = await CurrencyStrengthSnapshot.create({
    timestamp: new Date(),
    scores: ranked.map((r) => ({
      currency: r.currency,
      technicalScore: Number((technical[r.currency] ?? 0).toFixed(4)),
      fundamentalScore: Number((fundamental[r.currency] ?? 0).toFixed(4)),
      sentimentScore: Number((sentiment[r.currency] ?? 0).toFixed(4)),
      compositeScore: r.score,
      rank: r.rank,
    })),
    raw: {
      priceChanges,
      policyRates: fundamentalRaw.policyRates,
      longYields: fundamentalRaw.longYields,
      sentimentDetail,
    },
  });

  console.log("[pipeline] saved snapshot:", doc._id.toString());
  console.log("[pipeline] ranking:", ranked.map((r) => `${r.rank}.${r.currency}(${r.score})`).join(" "));

  return { technical, fundamental, sentiment, composite, ranked, snapshotId: doc._id };
}

module.exports = { runTechnicalOnly, runFullPipeline };
