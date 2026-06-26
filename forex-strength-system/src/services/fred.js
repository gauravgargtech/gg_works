const axios = require("axios");
const { FRED, FRED_POLICY_RATE_SERIES, FRED_LONG_YIELD_SERIES } = require("../config");
const { zScores } = require("./csi");

/** Fetch the most recent non-null observation for a single FRED series. */
async function getLatestObservation(seriesId) {
  const { data } = await axios.get(FRED.baseUrl, {
    params: {
      series_id: seriesId,
      api_key: FRED.apiKey,
      file_type: "json",
      sort_order: "desc",
      limit: 10, // grab a few in case the latest few are "." (missing) placeholders
    },
    timeout: 10_000,
  });

  const valid = (data.observations || []).find((o) => o.value !== ".");
  return valid ? { date: valid.date, value: parseFloat(valid.value) } : null;
}

/**
 * Fetch latest policy rate for every currency in the map.
 * Returns: { USD: 4.33, EUR: 2.0, ... }
 */
async function getPolicyRates(seriesMap = FRED_POLICY_RATE_SERIES) {
  const rates = {};
  for (const [currency, seriesId] of Object.entries(seriesMap)) {
    try {
      const obs = await getLatestObservation(seriesId);
      rates[currency] = obs ? obs.value : null;
      if (!obs) console.warn(`[fred] no valid observation for ${currency} (${seriesId})`);
    } catch (err) {
      console.error(`[fred] failed ${currency} (${seriesId}):`, err.response?.data || err.message);
      rates[currency] = null;
    }
    await new Promise((r) => setTimeout(r, 100)); // FRED free tier: be polite
  }
  return rates;
}

/**
 * Builds the "fundamental" score per currency: z-scored blend of policy
 * rate level + long yield level. This is intentionally simple (levels, not
 * rate-of-change) — the LLM/news layer is what should pick up on direction
 * of travel (hawkish/dovish shifts) between data points.
 */
async function getFundamentalScores() {
  const [policyRates, longYields] = await Promise.all([
    getPolicyRates(FRED_POLICY_RATE_SERIES),
    getPolicyRates(FRED_LONG_YIELD_SERIES), // same fetch logic, different series map
  ]);

  const policyZ = zScores(policyRates);
  const yieldZ = zScores(longYields);

  const fundamental = {};
  for (const c of Object.keys(FRED_POLICY_RATE_SERIES)) {
    // 70/30 split — current policy stance matters more than the slower-moving 10Y
    fundamental[c] = 0.7 * (policyZ[c] ?? 0) + 0.3 * (yieldZ[c] ?? 0);
  }

  return { fundamental, raw: { policyRates, longYields } };
}

module.exports = { getLatestObservation, getPolicyRates, getFundamentalScores };
