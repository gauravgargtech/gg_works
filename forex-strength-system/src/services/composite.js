const { CURRENCIES, SCORE_WEIGHTS } = require("../config");

/**
 * Combine the three layers into one composite score per currency, then rank.
 * Each input layer is expected already z-scored / bounded so the weights
 * mean what they say. Missing layers default to 0 (neutral contribution).
 */
function computeComposite({ technical = {}, fundamental = {}, sentiment = {} }) {
  const composite = {};
  for (const c of CURRENCIES) {
    composite[c] =
      SCORE_WEIGHTS.technical * (technical[c] ?? 0) +
      SCORE_WEIGHTS.fundamental * (fundamental[c] ?? 0) +
      SCORE_WEIGHTS.sentiment * (sentiment[c] ?? 0);
  }

  const ranked = Object.entries(composite)
    .sort((a, b) => b[1] - a[1])
    .map(([currency, score], i) => ({ rank: i + 1, currency, score: Number(score.toFixed(4)) }));

  return { composite, ranked };
}

module.exports = { computeComposite };
