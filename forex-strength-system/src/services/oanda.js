const axios = require("axios");
const { OANDA, STRENGTH_PAIRS } = require("../config");

const client = axios.create({
  baseURL: OANDA.baseUrl,
  headers: { Authorization: `Bearer ${OANDA.apiKey}` },
  timeout: 10_000,
});

/**
 * Fetch the last `count` candles for one instrument/granularity.
 * Returns sorted-ascending array of { time, close }.
 */
async function getCandles(instrument, granularity = "H1", count = OANDA.candleCount) {
  const { data } = await client.get(`/v3/instruments/${instrument}/candles`, {
    params: { granularity, count, price: "M" }, // M = midpoint of bid/ask
  });
  return data.candles
    .filter((c) => c.complete)
    .map((c) => ({ time: c.time, close: parseFloat(c.mid.c) }));
}

/**
 * % change from the first candle's close to the latest candle's close.
 * Positive = base currency strengthened against quote over the window.
 */
function pctChange(candles) {
  if (!candles || candles.length < 2) return 0;
  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  return ((last - first) / first) * 100;
}

/**
 * Pull % change for every pair in STRENGTH_PAIRS, across every configured
 * granularity. Throttled with a small delay between calls — OANDA's free
 * tier is generous but no reason to hammer it.
 *
 * Returns: { H1: { EUR_USD: 0.12, ... }, H4: {...}, D: {...} }
 */
async function getPriceChanges() {
  const result = {};
  for (const granularity of OANDA.granularities) {
    result[granularity] = {};
    for (const pair of STRENGTH_PAIRS) {
      try {
        const candles = await getCandles(pair, granularity);
        result[granularity][pair] = pctChange(candles);
      } catch (err) {
        console.error(`[oanda] failed ${pair} ${granularity}:`, err.response?.data || err.message);
        result[granularity][pair] = null; // mark as missing, don't crash the run
      }
      await new Promise((r) => setTimeout(r, 150)); // gentle pacing
    }
  }
  return result;
}

/** Live bid/ask spread snapshot — used as a secondary volatility/uncertainty signal */
async function getSpreads(pairs = STRENGTH_PAIRS) {
  const { data } = await client.get(`/v3/accounts/${OANDA.accountId}/pricing`, {
    params: { instruments: pairs.join(",") },
  });
  const spreads = {};
  for (const p of data.prices) {
    const bid = parseFloat(p.bids[0]?.price);
    const ask = parseFloat(p.asks[0]?.price);
    spreads[p.instrument] = ask && bid ? ask - bid : null;
  }
  return spreads;
}

module.exports = { getCandles, pctChange, getPriceChanges, getSpreads };
