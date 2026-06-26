const { CURRENCIES } = require("../config");

/**
 * Mean/std for z-score normalization — puts every currency's raw score
 * on a comparable scale regardless of how volatile that timeframe was.
 */
function zScores(valuesByCurrency) {
  const vals = Object.values(valuesByCurrency).filter((v) => v !== null && !isNaN(v));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  const std = Math.sqrt(variance) || 1; // avoid divide-by-zero on a flat basket

  const out = {};
  for (const [k, v] of Object.entries(valuesByCurrency)) {
    out[k] = v === null || isNaN(v) ? 0 : (v - mean) / std;
  }
  return out;
}

/**
 * Core CSI logic for ONE timeframe's worth of pair % changes.
 *
 * For pair BASE_QUOTE with % change X:
 *   BASE gets +X contribution (it appreciated)
 *   QUOTE gets -X contribution (it depreciated against BASE)
 * Average each currency's total contribution across every pair it appears
 * in, then z-score the result so currencies are comparable.
 */
function computeCSIForTimeframe(pairChanges) {
  const totals = {};
  const counts = {};
  for (const c of CURRENCIES) {
    totals[c] = 0;
    counts[c] = 0;
  }

  for (const [pair, change] of Object.entries(pairChanges)) {
    if (change === null) continue;
    const [base, quote] = pair.split("_");
    if (!(base in totals) || !(quote in totals)) continue; // skip XAU_USD etc.
    totals[base] += change;
    counts[base] += 1;
    totals[quote] -= change;
    counts[quote] += 1;
  }

  const avg = {};
  for (const c of CURRENCIES) {
    avg[c] = counts[c] > 0 ? totals[c] / counts[c] : 0;
  }

  return zScores(avg);
}

/**
 * Blend multiple timeframes into one technical score per currency.
 * Shorter timeframes = more noise, longer = more lag, so weight toward
 * the middle by default. Tune to taste.
 */
function computeBlendedCSI(priceChangesByGranularity, weights = { H1: 0.2, H4: 0.4, D: 0.4 }) {
  const perTimeframe = {};
  for (const [gran, pairChanges] of Object.entries(priceChangesByGranularity)) {
    perTimeframe[gran] = computeCSIForTimeframe(pairChanges);
  }

  const blended = {};
  for (const c of CURRENCIES) {
    let sum = 0;
    let weightSum = 0;
    for (const [gran, scores] of Object.entries(perTimeframe)) {
      const w = weights[gran] ?? 0;
      sum += (scores[c] ?? 0) * w;
      weightSum += w;
    }
    blended[c] = weightSum > 0 ? sum / weightSum : 0;
  }

  return { blended, perTimeframe };
}

module.exports = { computeCSIForTimeframe, computeBlendedCSI, zScores };
