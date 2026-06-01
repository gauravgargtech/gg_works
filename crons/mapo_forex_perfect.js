/**
 * Moving Averages Proximity Oscillator (MAPO) - LuxAlgo
 * Replicates Pine Script logic in JavaScript
 * Fetches 15-min candles from Bybit V5 public API (no API key needed)
 *
 * Settings (matching your spec):
 *   min       = 5
 *   max       = 100
 *   smooth    = 3
 *   normalized = true
 *   src       = close
 *   Timeframe : 15-minute candles
 *   Threshold : Proximity Index >= 78
 *
 * Usage:
 *   node mapo-proximity.js BTCUSDT        ← linear perpetual (default)
 *   node mapo-proximity.js BTCUSDT spot   ← spot market
 *   node mapo-proximity.js BTCUSD inverse ← inverse contract
 */

require("../config/config");
const https = require("https");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { fetchCandles } = require("../exhanges/oanda");

dayjs.extend(utc);
dayjs.extend(timezone);

const { set, get } = require("../adapters/redis");

const { sendPushNotif } = require("../config/telegram_notify");

// ─── Config ────────────────────────────────────────────────────────────────

let INSTRUMENT = process.env.INSTRUMENT || "EUR_USD";
const CANDLE_COUNT = 4000;

const MA_MIN = 5; // Minimum MA length
const MA_MAX = 100; // Maximum MA length
const SMOOTH = 3; // SMA smoothing period
const NORMALIZE = true; // Normalize output to 0–100

// Derived levels
const LVL = NORMALIZE ? 50 : (MA_MAX + MA_MIN + 1) / 2;
const OB = NORMALIZE ? 80 : 0.8 * MA_MAX + 0.2 * MA_MIN;
const OS = NORMALIZE ? 20 : 0.8 * MA_MIN + 0.2 * MA_MAX;

/** Cumulative sum array (index i = sum of src[0..i]) */
function cumsum(src) {
  const out = new Array(src.length);
  let s = 0;
  for (let i = 0; i < src.length; i++) {
    s += src[i];
    out[i] = s;
  }
  return out;
}

/**
 * Simple moving average of `arr` over `period`.
 * Returns array same length; early values filled with
 * expanding-window average until enough data is available.
 */
function sma(arr, period) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    out[i] = sum / Math.min(i + 1, period);
  }
  return out;
}

// ─── MAPO Core ─────────────────────────────────────────────────────────────

/**
 * Compute MAPO for the full price series.
 *
 * Returns array of objects: { time, per, len, signal }
 * where signal is "BULL" | "BEAR" | "OB" | "OS" | "NEUTRAL"
 */
function computeMAPO(candles) {
  const n = candles.length;
  const src = candles.map((c) => c.close);
  const cum = cumsum(src); // cumulative sum

  // Helper: cumulative sum at bar i (0-based), 0 if i < 0
  const C = (i) => (i < 0 ? 0 : cum[i]);

  // For each bar compute raw per and len
  const rawPer = new Array(n).fill(0);
  const rawLen = new Array(n).fill(MA_MIN);

  for (let i = 0; i < n; i++) {
    if (i < MA_MIN) continue; // not enough bars yet

    const price = src[i];

    // Closest distance starts at abs(price - SMA(min))
    // SMA(min) at bar i = (cum[i] - cum[i-min]) / min
    const smaMin = (C(i) - C(i - MA_MIN)) / MA_MIN;
    let maxMin = Math.abs(price - smaMin);
    let bestLen = MA_MIN;
    let perCount = 0;

    for (let k = MA_MIN; k <= MA_MAX; k++) {
      if (i - k < 0) break; // not enough history for this length
      const ma = (C(i) - C(i - k)) / k;
      if (price > ma) perCount++;

      const ae = Math.abs(price - ma);
      if (ae < maxMin) {
        maxMin = ae;
        bestLen = k;
      }
    }

    rawPer[i] = perCount;
    rawLen[i] = bestLen;
  }

  // Smooth both
  const smPer = sma(rawPer, SMOOTH);
  const smLen = sma(rawLen, SMOOTH);

  // Normalize
  const results = candles.map((c, i) => {
    let per = smPer[i];
    let len = smLen[i];

    if (NORMALIZE) {
      len = ((len - MA_MIN) / (MA_MAX - MA_MIN + 1)) * 100;
      per = (per / (MA_MAX - MA_MIN + 1)) * 100;
    } else {
      per = per + MA_MIN;
    }

    // Signal classification
    let signal;
    if (per >= OB) signal = "OVERBOUGHT";
    else if (per <= OS) signal = "OVERSOLD";
    else if (per > LVL) signal = "BULL";
    else if (per < LVL) signal = "BEAR";
    else signal = "NEUTRAL";

    return {
      time: dayjs(c.time)
        .tz("Australia/Brisbane")
        .format("YYYY-MM-DD HH:mm:ss"),
      close: c.close,
      per: +per.toFixed(4),
      len: +len.toFixed(4),
      signal,
    };
  });

  return results;
}

// ─── Display ───────────────────────────────────────────────────────────────

function printResults(results) {
  const signalColor = {
    OVERBOUGHT: "\x1b[35m", // magenta
    OVERSOLD: "\x1b[33m", // yellow
    BULL: "\x1b[32m", // green
    BEAR: "\x1b[31m", // red
    NEUTRAL: "\x1b[37m", // white
  };
  const RESET = "\x1b[0m";

  console.log(`\n${"─".repeat(80)}`);
  console.log(
    ` MAPO — ${INSTRUMENT} | 15m | min=${MA_MIN} max=${MA_MAX} smooth=${SMOOTH} normalized=${NORMALIZE}`,
  );
  console.log(` Levels → Mid: ${LVL}  OB: ${OB}  OS: ${OS}`);
  console.log(`${"─".repeat(80)}`);
  console.log(
    ` ${"Time (UTC)".padEnd(28)} ${"Close".padEnd(10)} ${"per".padEnd(8)} ${"len".padEnd(8)} Signal`,
  );
  console.log(`${"─".repeat(80)}`);

  // Print last 30 bars
  const slice = results.slice(-30);
  for (const r of slice) {
    const ts = new Date(r.time).toISOString().replace("T", " ").slice(0, 19);
    const col = signalColor[r.signal] || RESET;
    console.log(
      ` ${ts.padEnd(28)} ${String(r.close).padEnd(10)} ${String(r.per).padEnd(8)} ${String(r.len).padEnd(8)} ${col}${r.signal}${RESET}`,
    );
  }

  // Latest bar summary
  const latest = results[results.length - 1];
  console.log(`${"─".repeat(80)}`);
  console.log(`\n LATEST BAR SUMMARY`);
  console.log(` Time   : ${new Date(latest.time).toISOString()}`);
  console.log(` Close  : ${latest.close}`);
  console.log(` per    : ${latest.per}  (% of MAs price is above)`);
  console.log(` len    : ${latest.len}  (proximity-weighted MA length)`);
  console.log(
    ` Signal : ${signalColor[latest.signal]}${latest.signal}${RESET}`,
  );
  console.log();
}

async function main(symbol, theTime) {
  INSTRUMENT = symbol;
  console.log(`Fetching ${CANDLE_COUNT} × 15m candles for ${INSTRUMENT}…`);

  const candles = await fetchCandles(INSTRUMENT, theTime, CANDLE_COUNT);
  console.log(`Got ${candles.length} complete candles.`);

  const results = computeMAPO(candles);

  const last8Indexes = results.slice(-8);
  const latestCandle = last8Indexes[last8Indexes.length - 1];

  let isZero = false;
  let theZeroIndex = 0;

  let isSignalReady = false;

  if (latestCandle.len < 5) {
    for (const [idx, gg] of Object.entries(last8Indexes)) {
      if (parseInt(idx) >= 0 && parseInt(idx) < 5 && gg.len < 10) {
        isZero = true;
        theZeroIndex = parseInt(idx);
      }
    }
    if (isZero) {
      for (const [idx, gg] of Object.entries(last8Indexes)) {
        if (parseInt(idx) > theZeroIndex && gg.len > 75) {
          isSignalReady = true;
        }
      }
    }
  }
  if (isSignalReady) {
    await sendPushNotif(
      `MAPO FOREX PERFECT ${INSTRUMENT} ${theTime}: ${latestCandle.per} ${latestCandle.signal}`,
    );
  }
}

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const theForexPerfectMapo = async (theTime) => {
  const coins = [
    "AUD_USD",
    "USD_JPY",
    "USD_CAD",
    "GBP_USD",
    "NZD_USD",
    "EUR_USD",
    "AUD_NZD",
    "EUR_AUD",
    "EUR_GBP",
    "EUR_CAD",
    "EUR_JPY",
    "USD_CHF",
  ];
  await sleep(3);

  for (const coin of coins) {
    await sleep(1);
    await main(coin, theTime);
  }
};
module.exports = theForexPerfectMapo;
