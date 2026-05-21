/**
 * Custom_SVMKR_UT_HMA_ORB Strategy — Node.js / OANDA Demo
 * =========================================================
 * Replicates the Pine Script logic on 5-minute AUD/USD candles.
 *
 * UT Bot params  : Key Value = 19 | ATR Period = 3
 * HMA period     : 31
 * ORB session    : 10:10–10:15 (instrument local time)
 *
 * Usage:
 *   npm install axios
 *   OANDA_API_KEY=<your-key> OANDA_ACCOUNT_ID=<your-account> node aud_usd_strategy.js
 *
 * The script polls every 30 seconds, prints the latest signal, and
 * writes a running log to strategy_log.json.
 */

require("../config/config");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const { get, set } = require("../adapters/redis");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { insertMany, find, remove, insert } = require("../adapters/mongo");
const { fetchCandles, getInstruments } = require("../exhanges/oanda");
const { ConfigurationSet$ } = require("@aws-sdk/client-ses");
const { sendPushNotif, sendSignalAlert } = require("../config/telegram_notify");

dayjs.extend(utc);
dayjs.extend(timezone);

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const CONFIG = {
  apiKey: process.env.OANDA_API_KEY || "YOUR_OANDA_DEMO_API_KEY",
  accountId: process.env.OANDA_ACCOUNT_ID || "YOUR_OANDA_ACCOUNT_ID",
  baseUrl: "https://api-fxpractice.oanda.com", // Demo endpoint
  instrument: "AUD_USD",
  granularity: "M5", // 5-minute candles
  candleCount: 4900, // enough history for indicators

  // UT Bot
  utKeyValue: 19,
  utAtrPeriod: 3,

  // HMA
  hmaPeriod: 31,

  // ORB  (HH:MM in 24-hour, server/UTC-aware — adjust offset if needed)
  orbStartHHMM: "10:10",
  orbEndHHMM: "10:15",
};

// ---------------------------------------------------------------------------
// INDICATOR MATH
// ---------------------------------------------------------------------------

/** Simple Moving Average */
function sma(arr, period) {
  if (arr.length < period) return NaN;
  const slice = arr.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

/**
 * True Range array — needed for ATR.
 * Requires {high, low, close} objects; first bar has no prev close so TR = high-low.
 */
function trueRanges(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
  });
}

/**
 * Wilder's smoothed ATR (same as Pine's atr()).
 * Returns an array aligned with `candles`.
 */
function atrWilder(candles, period) {
  const tr = trueRanges(candles);
  const out = new Array(candles.length).fill(NaN);

  // Seed with SMA of first `period` TRs
  let seed = 0;
  for (let i = 0; i < period; i++) seed += tr[i];
  out[period - 1] = seed / period;

  for (let i = period; i < candles.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

/**
 * Weighted Moving Average — same as Pine's wma().
 * Weights: 1, 2, 3, … period (most recent = heaviest).
 */
function wmaArr(values, period) {
  const out = new Array(values.length).fill(NaN);
  const denom = (period * (period + 1)) / 2;

  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += values[i - j] * (period - j);
    }
    out[i] = sum / denom;
  }
  return out;
}

/**
 * Hull Moving Average
 * HMA(n) = WMA( 2*WMA(n/2) − WMA(n), sqrt(n) )
 */
function hma(closes, period) {
  const half = Math.round(period / 2);
  const sqrtN = Math.round(Math.sqrt(period));
  const wmaFull = wmaArr(closes, period);
  const wmaHalf = wmaArr(closes, half);

  const diff = wmaFull.map((v, i) =>
    isNaN(v) || isNaN(wmaHalf[i]) ? NaN : 2 * wmaHalf[i] - v,
  );
  return wmaArr(diff, sqrtN);
}

/**
 * UT Bot trailing stop & position.
 * Returns arrays: { trailingStop[], position[] }
 *
 * Pine logic (verbatim translation):
 *   xATRTrailingStop[i] =
 *     if src > prev_stop and src[1] > prev_stop  → max(prev_stop, src - nLoss)
 *     if src < prev_stop and src[1] < prev_stop  → min(prev_stop, src + nLoss)
 *     if src > prev_stop                         → src - nLoss
 *     else                                       → src + nLoss
 *
 *   pos[i] =
 *     if src[1] < prev_stop and src > prev_stop  → 1  (crossover up)
 *     if src[1] > prev_stop and src < prev_stop  → -1 (crossover down)
 *     else                                       → pos[i-1]
 */
function utBot(closes, atrArr, keyValue) {
  const n = closes.length;
  const stop = new Array(n).fill(0);
  const pos = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    if (isNaN(atrArr[i])) continue;

    const src = closes[i];
    const srcPrev = closes[i - 1];
    const prevStop = stop[i - 1];
    const nLoss = keyValue * atrArr[i];

    if (src > prevStop && srcPrev > prevStop) {
      stop[i] = Math.max(prevStop, src - nLoss);
    } else if (src < prevStop && srcPrev < prevStop) {
      stop[i] = Math.min(prevStop, src + nLoss);
    } else if (src > prevStop) {
      stop[i] = src - nLoss;
    } else {
      stop[i] = src + nLoss;
    }

    // Position / signal
    if (srcPrev < prevStop && src > prevStop) {
      pos[i] = 1;
    } else if (srcPrev > prevStop && src < prevStop) {
      pos[i] = -1;
    } else {
      pos[i] = pos[i - 1];
    }
  }

  return { trailingStop: stop, position: pos };
}

/**
 * Derive buy/sell signal arrays from UT Bot arrays.
 * buy[i]  = src > trailingStop AND ema crosses above trailingStop
 * sell[i] = src < trailingStop AND trailingStop crosses above ema
 *
 * Pine uses ema(src,1) which is just src itself (period-1 EMA = identity).
 */
function utSignals(closes, trailingStop) {
  const n = closes.length;
  const buys = new Array(n).fill(false);
  const sells = new Array(n).fill(false);

  for (let i = 1; i < n; i++) {
    const ema = closes[i]; // ema(src, 1) == src
    const emaPrev = closes[i - 1];
    const ts = trailingStop[i];
    const tsPrev = trailingStop[i - 1];

    // crossover(ema, ts): ema crosses above ts
    const above = emaPrev <= tsPrev && ema > ts;
    // crossover(ts, ema): ts crosses above ema
    const below = tsPrev <= emaPrev && ts > ema;

    buys[i] = ema > ts && above;
    sells[i] = ema < ts && below;
  }
  return { buys, sells };
}

// ---------------------------------------------------------------------------
// OPEN RANGE BREAKOUT HELPERS
// ---------------------------------------------------------------------------

/**
 * Parse "HH:MM" → { h, m }
 */
function parseHHMM(str) {
  const [h, m] = str.split(":").map(Number);
  return { h, m };
}

/**
 * Is the candle's timestamp within the ORB session window?
 * Compares UTC hours/minutes (OANDA timestamps are UTC).
 * Adjust orbStartHHMM / orbEndHHMM to your broker's session timezone.
 */
function inOrbSession(date, startStr, endStr) {
  const start = parseHHMM(startStr);
  const end = parseHHMM(endStr);
  const hh = date.getUTCHours();
  const mm = date.getUTCMinutes();
  const totalMin = hh * 60 + mm;
  const startMin = start.h * 60 + start.m;
  const endMin = end.h * 60 + end.m;
  return totalMin >= startMin && totalMin <= endMin;
}

/**
 * Calculate ORB high/low over the candle history.
 * Returns { orbHigh, orbLow } for the most recent completed ORB session.
 */
function calcORB(candles, startStr, endStr) {
  let orbHigh = NaN;
  let orbLow = NaN;
  let inSession = false;

  for (const c of candles) {
    const inNow = inOrbSession(c.time, startStr, endStr);
    if (inNow) {
      if (!inSession) {
        // First bar of session — seed the range
        orbHigh = c.high;
        orbLow = c.low;
        inSession = true;
      } else {
        if (c.high > orbHigh) orbHigh = c.high;
        if (c.low < orbLow) orbLow = c.low;
      }
    } else {
      // Keep last seen ORB once session ends (Pine behaviour: persist)
      inSession = false;
    }
  }
  return { orbHigh, orbLow };
}

// ---------------------------------------------------------------------------
// MAIN ANALYSIS
// ---------------------------------------------------------------------------

/**
 * Build a per-bar result snapshot at index `i` given the pre-computed arrays.
 */
function buildBarSnapshot(
  i,
  candles,
  closes,
  atrArr,
  trailingStop,
  position,
  buys,
  sells,
  hmaArr,
  orbHigh,
  orbLow,
  instrument,
) {
  const hmaCur = hmaArr[i];
  const hmaPrev = hmaArr[i - 1];
  const hmaTrend = hmaCur > hmaPrev ? "UP" : hmaCur < hmaPrev ? "DOWN" : "FLAT";
  const close = closes[i];
  const aboveORBHigh = !isNaN(orbHigh) && close > orbHigh;
  const belowORBLow = !isNaN(orbLow) && close < orbLow;

  return {
    instrument,
    timestamp: dayjs(candles[i].time)
      .tz("Australia/Brisbane")
      .format("YYYY-MM-DD HH:mm:ss"),
    unixTimestamp: dayjs(candles[i].time).tz("Australia/Brisbane").unix(),
    close,
    atr: atrArr[i],
    trailingStop: trailingStop[i],
    utPosition: position[i],
    utBuySignal: buys[i],
    utSellSignal: sells[i],
    hma: hmaCur,
    hmaTrend,
    orbHigh,
    orbLow,
    aboveORBHigh,
    belowORBLow,
  };
}

function analyse(candles) {
  const closes = candles.map((c) => c.close);
  const n = candles.length;

  // ── ATR (Wilder, period 3) ──
  const atrArr = atrWilder(candles, CONFIG.utAtrPeriod);

  // ── UT Bot ──
  const { trailingStop, position } = utBot(closes, atrArr, CONFIG.utKeyValue);
  const { buys, sells } = utSignals(closes, trailingStop);

  // ── HMA (period 31) ──
  const hmaArr = hma(closes, CONFIG.hmaPeriod);

  // ── ORB ──

  const { orbHigh, orbLow } = calcORB(
    candles,
    CONFIG.orbStartHHMM,
    CONFIG.orbEndHHMM,
  );

  // ── Latest bar ──
  const last = n - 1;
  const latest = buildBarSnapshot(
    last,
    candles,
    closes,
    atrArr,
    trailingStop,
    position,
    buys,
    sells,
    hmaArr,
    orbHigh,
    orbLow,
  );

  // ── Scan all bars for UT buy/sell signals (skip first 2 bars — no prev values) ──
  // Collect every bar where utBuySignal or utSellSignal fired, newest first.
  const historicalSignals = [];
  for (let i = n - 1; i > 1; i--) {
    // exclude the live bar (last)
    if (buys[i] || sells[i]) {
      const snap = buildBarSnapshot(
        i,
        candles,
        closes,
        atrArr,
        trailingStop,
        position,
        buys,
        sells,
        hmaArr,
        orbHigh,
        orbLow,
        CONFIG.instrument,
      );
      snap.signal = compositeSignalFromSnap(snap);
      historicalSignals.push(snap);
      if (historicalSignals.length === 3) break; // only need the last 3
    }
  }

  return { latest, historicalSignals };
}

// ---------------------------------------------------------------------------
// COMPOSITE SIGNAL
// ---------------------------------------------------------------------------

/**
 * Combine UT + HMA + ORB into a single actionable signal from any snapshot.
 * LONG  : UT buy signal  AND HMA trending UP   AND price broke above ORB high
 * SHORT : UT sell signal AND HMA trending DOWN  AND price broke below ORB low
 */
function compositeSignalFromSnap(snap) {
  if (snap.utBuySignal && snap.hmaTrend === "UP" && snap.aboveORBHigh)
    return "LONG";
  if (snap.utSellSignal && snap.hmaTrend === "DOWN" && snap.belowORBLow)
    return "SHORT";
  if (snap.utBuySignal) return "BUY";
  if (snap.utSellSignal) return "SELL";
  return "NEUTRAL";
}

// Convenience alias used at call sites
const compositeSignal = compositeSignalFromSnap;

// ---------------------------------------------------------------------------
// DISPLAY
// ---------------------------------------------------------------------------

const SEP = "  " + "-".repeat(53);
const DSEP = "  " + "=".repeat(53);

function fmt(v, d = 5) {
  return typeof v === "number" && !isNaN(v) ? v.toFixed(d) : "N/A";
}

function utSignalLabel(snap) {
  if (snap.utBuySignal) return "BUY  [green]";
  if (snap.utSellSignal) return "SELL [red]";
  return "none";
}

async function printResult(
  latest,
  latestSignal,
  historicalSignals,
  lastCandle,
) {
  if (latestSignal !== "NEUTRAL") {
    await sendPushNotif(
      `Signal detected for ${CONFIG.instrument} on ${dayjs().tz("Australia/Brisbane").format("YYYY-MM-DD HH:mm:ss")}, lets see`,
    );
    if (latest.utBuySignal || latest.utSellSignal) {
      try {
        await sendPushNotif(
          `Signal detected for ${CONFIG.instrument} on ${dayjs().tz("Australia/Brisbane").format("YYYY-MM-DD HH:mm:ss")}, gotcha`,
        );
      } catch (error) {
        console.error(error);
      }

      let candleChange = 0;
      if (lastCandle?.high && lastCandle?.high) {
        candleChange = lastCandle.high - lastCandle.low;
      }
      const instrumentDetailss = await get(CONFIG.instrument);

      lastCandle.candleChange = Math.abs(
        parseFloat(candleChange / instrumentDetailss.tickSize).toFixed(2),
      );

      let isCompressed = false;
      if (lastCandle.candleChange > 20) {
        isCompressed = true;
      }

      latest.created_at = dayjs()
        .tz("Australia/Brisbane")
        .format("YYYY-MM-DD HH:mm:ss");

      latest.compressed = isCompressed;
      latest.lastCandle = lastCandle;

      if (latest.utBuySignal) {
        latest.signal = "LONG";
      } else if (latest.utSellSignal) {
        latest.signal = "SHORT";
      } else {
        latest.signal = "NEUTRAL";
      }

      //latest.unixTimestamp = dayjs().tz("Australia/Brisbane").unix();
      latest.instrument = CONFIG.instrument;
      await insert("signals", latest);
      console.log(`Inserted signal for ${CONFIG.instrument}`);

      await sendSignalAlert(latest.signal, CONFIG.instrument, latest.close, {
        signal_time: latest.timestamp,
        source: "new",
      });
    }

    //finalSignals[0].unixTimestamp = dayjs().tz("Australia/Brisbane").unix();
    //await insertMany("signals", finalSignals);

    /*
    const latestSignal = historicalSignals[0];
    const timestamp = latestSignal.unixTimestamp;
    let isSendNotif = false;

    const lastSignal = await get(`last_signal_${CONFIG.instrument}`);
    if (lastSignal) {
      if (lastSignal < timestamp) {
        isSendNotif = true;
        await set(`last_signal_${CONFIG.instrument}`, timestamp);
      }
    } else {
      await set(
        `last_signal_${CONFIG.instrument}`,
        historicalSignals?.[1]?.unixTimestamp,
      );
    }

    latestSignal.created_at = dayjs().format("YYYY-MM-DD HH:mm:ss");
    const isSignalFound = await find("signals", {
      timestamp: {
        $gte: timestamp,
        instrument: CONFIG.instrument,
      },
    });
    if (isSignalFound.length === 0) {
      await insert("signals", latestSignal);
    }

    if (isSendNotif) {
      await sendSignalAlert(
        latestSignal.signal,
        CONFIG.instrument,
        latestSignal.close,
        {
          signal_time: latestSignal.timestamp,
          source: "new",
        },
      );
    }
    console.log("\n" + SEP);
    console.log(
      `  Last ${historicalSignals.length} UT Signal(s) found in history for ${CONFIG.instrument} candles`,
    );
    console.log(SEP);
    historicalSignals.forEach((h, i) => {
      if (i > 0) console.log(SEP);
    });
    */
  } else {
    console.log("\n  (No prior UT signals found in the fetched candle window)");
  }

  console.log(DSEP + "\n");
  return;
}

// ---------------------------------------------------------------------------
// POLL LOOP
// ---------------------------------------------------------------------------

async function run() {
  console.log(`\n=== UT Bot + HMA + ORB Strategy | ${CONFIG.instrument} ===`);
  console.log(
    `Symbol: ${CONFIG.instrument}  |  Key Value: ${CONFIG.utKeyValue}  |  ATR Period: ${CONFIG.utAtrPeriod} \n`,
  );

  try {
    const theCandles = await fetchCandles(
      CONFIG.instrument,
      CONFIG.granularity,
      CONFIG.candleCount,
    );

    const lastCandle = theCandles[theCandles.length - 1];

    const candles = theCandles.map((c) => ({
      time: new Date(c.time),
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
    }));
    if (candles.length < CONFIG.hmaPeriod + 10) {
      console.warn("Not enough candles yet, waiting...");
      return;
    }

    const { latest, historicalSignals } = analyse(candles);

    const latestSignal = compositeSignal(latest);
    await printResult(latest, latestSignal, historicalSignals, lastCandle);
  } catch (err) {
    const msg = err.response?.data ?? err.message;
    console.error(err);
    console.error("Error:", JSON.stringify(msg, null, 2));
  }
  return;
}

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const runIndicator = async () => {
  const instruments = Object.keys(FOREX_PAIRS_CONFIG);
  await sleep(40);

  for (const inst of instruments) {
    const pairConfig = FOREX_PAIRS_CONFIG[inst];

    if (!pairConfig) {
      console.warn(`No config found for instrument: ${inst}`);
      continue;
    }

    CONFIG.instrument = inst;
    CONFIG.utKeyValue = pairConfig.utKeyValue;
    CONFIG.utAtrPeriod = pairConfig.utAtrPeriod;
    CONFIG.granularity = pairConfig.granularity ?? "M5";

    try {
      await run();
    } catch (err) {
      console.error("Error in scanning and logging: ", err);
    }

    await sleep(1);
  }
  console.log("-Finished");
  return;
};

module.exports = runIndicator;
