"use strict";

/**
 * EUR_USD — Oanda 15m Signal Engine
 *
 * Logic (identical to BTCUSDT engine):
 *  - Fetches 15m candles from Oanda v20 REST API every 15 minutes
 *  - EMA 21/50 confirmed crossover (3-candle widening gap + slope/angle filter) → sets redis key: eurusd:signal:ema
 *  - MACD histogram zero-line cross with 2 growing confirmation bars → sets redis key: eurusd:signal:macd
 *  - When BOTH keys exist AND are same direction → fire signal, then clear both keys
 *  - Keys persist (up to TTL) until the second confluence arrives or direction flips
 *
 * Required env vars:
 *   OANDA_TOKEN      — your Oanda v20 personal access token
 *   OANDA_ENV        — 'live' or 'demo' (default: 'demo')
 *   REDIS_HOST       — Redis host (default: 127.0.0.1)
 *   REDIS_PORT       — Redis port (default: 6379)
 *   REDIS_PASSWORD   — Redis password (optional)
 *
 * Oanda candle granularity reference:
 *   M1 M2 M4 M5 M10 M15 M30 H1 H2 H3 H4 H6 H8 H12 D W M
 */

require("../config/config");
const process = require("process");

const cron = require("node-cron");

const Redis = require("ioredis");
const axios = require("axios");
const { insert } = require("../adapters/mongo");

const { sendEmail } = require("../common/email.js");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
  instrument: "USD_JPY",
  granularity: "M15", // 15-minute candles
  count: 120, // candles to fetch (enough for EMA 50 + confirmations)
  price: "M", // M = midpoint (average of bid/ask) — use 'B' for bid, 'A' for ask

  // Oanda base URLs
  oandaLiveBase: "https://api-fxtrade.oanda.com",
  oandaDemoBase: "https://api-fxpractice.oanda.com",

  // EMA periods
  emaFast: 21,
  emaSlow: 50,

  // MACD settings
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  // 3-candle gap confirmation after crossover
  gapConfirmCandles: 3,

  // EMA slope / angle filter
  // EUR_USD moves ~5–20 pips per 15m candle, so slope % is much smaller than BTC
  // At price ~1.08, a 1-pip move = 0.000926% — 5 pips over 5 candles ≈ 0.0009% per candle
  // Start at 0.003% and tune down if too few signals, up if too many flat crosses pass
  slopeLookback: 5, // candles to measure slope over
  minSlopePercent: 0.003, // minimum slope % per candle — tune to taste for EUR/USD

  // Redis keys — namespaced separately from the BTC engine so both can run simultaneously
  redisKeyEma: "eurusd:signal:ema",
  redisKeyMacd: "eurusd:signal:macd",

  // Redis TTL — 8 hours for forex (market can be slow to develop vs crypto)
  redisTTL: 60 * 60 * 8,

  redis: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    password: process.env.REDIS_PASSWORD || undefined,
  },
};

// ─── RUNTIME VALUES (from env) ────────────────────────────────────────────────

const OANDA_TOKEN = process.env.OANDA_API_KEY;
const OANDA_ENV = (process.env.OANDA_ENV || "demo").toLowerCase();

if (!OANDA_TOKEN) {
  console.error(
    "[Config] ERROR: OANDA_TOKEN environment variable is required.",
  );
  console.error("         Set it with: export OANDA_TOKEN=your_token_here");
  process.exit(1);
}

const OANDA_BASE =
  OANDA_ENV === "live" ? CONFIG.oandaLiveBase : CONFIG.oandaDemoBase;

console.log(
  `[Config] Oanda environment : ${OANDA_ENV.toUpperCase()} → ${OANDA_BASE}`,
);

// ─── REDIS CLIENT ─────────────────────────────────────────────────────────────

const redis = new Redis(CONFIG.redis);
redis.on("error", (err) => console.error("[Redis] Error:", err.message));

// ─── MATH HELPERS ─────────────────────────────────────────────────────────────

/**
 * Calculate EMA array for given period over closes array.
 * Returns array same length as closes (first `period-1` values are null).
 */
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const result = new Array(closes.length).fill(null);

  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  result[period - 1] = sum / period;

  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/**
 * Calculate MACD line, signal line, and histogram arrays.
 * Returns { macdLine, signalLine, histogram } — all same length as closes.
 */
function calcMACD(closes, fast, slow, signal) {
  const emaFastArr = calcEMA(closes, fast);
  const emaSlowArr = calcEMA(closes, slow);

  const macdLine = closes.map((_, i) =>
    emaFastArr[i] !== null && emaSlowArr[i] !== null
      ? emaFastArr[i] - emaSlowArr[i]
      : null,
  );

  const macdValid = macdLine.filter((v) => v !== null);
  const signalOnly = calcEMA(macdValid, signal);

  const signalLine = new Array(closes.length).fill(null);
  let si = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null) signalLine[i] = signalOnly[si++] ?? null;
  }

  const histogram = closes.map((_, i) =>
    macdLine[i] !== null && signalLine[i] !== null
      ? macdLine[i] - signalLine[i]
      : null,
  );

  return { macdLine, signalLine, histogram };
}

/**
 * Calculate slope of an EMA over last `lookback` candles,
 * normalised as % of currentPrice per candle.
 * Positive = rising, Negative = falling.
 */
function calcEMASlope(emaArr, lookback, currentPrice) {
  const len = emaArr.length;
  const curr = emaArr[len - 1];
  const prev = emaArr[len - 1 - lookback];

  if (curr === null || prev === null || currentPrice === 0) return null;
  return ((curr - prev) / lookback / currentPrice) * 100;
}

// ─── OANDA DATA FETCH ─────────────────────────────────────────────────────────

/**
 * Fetch M15 candles from Oanda v20 instruments/candles endpoint.
 * Returns array of { time, open, high, low, close } sorted oldest → newest.
 *
 * Oanda candle response shape:
 *   { candles: [ { time, mid: { o, h, l, c }, complete, volume }, ... ] }
 *
 * Note: Oanda always returns `count` candles ending at the most recently
 * COMPLETE candle — the in-progress candle is excluded by default.
 */
async function fetchCandles() {
  const url = `${OANDA_BASE}/v3/instruments/${CONFIG.instrument}/candles`;

  const { data } = await axios.get(url, {
    timeout: 10000,
    headers: {
      Authorization: `Bearer ${OANDA_TOKEN}`,
      "Content-Type": "application/json",
    },
    params: {
      granularity: CONFIG.granularity,
      count: CONFIG.count,
      price: CONFIG.price, // 'M' = midpoint
    },
  });

  if (!data.candles || data.candles.length === 0) {
    throw new Error("Oanda returned empty candles array");
  }

  // Filter to only complete candles (complete: true) — safety net
  const complete = data.candles.filter((c) => c.complete);

  if (complete.length < CONFIG.emaSlow + CONFIG.gapConfirmCandles + 5) {
    throw new Error(`Not enough complete candles: got ${complete.length}`);
  }

  // Oanda returns oldest → newest already (no reversal needed)
  return complete.map((c) => ({
    time: c.time,
    open: parseFloat(c.mid.o),
    high: parseFloat(c.mid.h),
    low: parseFloat(c.mid.l),
    close: parseFloat(c.mid.c),
  }));
}

// ─── EMA CROSSOVER DETECTION ──────────────────────────────────────────────────

/**
 * Detect confirmed EMA 21/50 crossover using:
 *  1. Direction flip (21 crosses 50)
 *  2. 3-candle widening gap rule
 *  3. EMA 21 slope must exceed minSlopePercent (angle filter)
 *  4. EMA 50 slope must not strongly oppose the cross
 *
 * Returns 'BULL', 'BEAR', or null.
 */
function detectEMACrossover(ema21, ema50, currentPrice) {
  const len = ema21.length;
  const conf = CONFIG.gapConfirmCandles;

  if (len < CONFIG.emaSlow + conf + 2) return null;

  for (let i = len - 1 - conf; i >= CONFIG.emaSlow; i--) {
    const prev21 = ema21[i - 1];
    const prev50 = ema50[i - 1];
    const curr21 = ema21[i];
    const curr50 = ema50[i];

    if (
      prev21 === null ||
      prev50 === null ||
      curr21 === null ||
      curr50 === null
    )
      continue;

    const prevDiff = prev21 - prev50;
    const currDiff = curr21 - curr50;
    const crossedBull = prevDiff <= 0 && currDiff > 0;
    const crossedBear = prevDiff >= 0 && currDiff < 0;

    if (!crossedBull && !crossedBear) continue;

    // ── 3-candle gap widening ──────────────────────────────────────────────────
    let gapConfirmed = true;
    let prevGap = Math.abs(currDiff);

    for (let j = 1; j <= conf; j++) {
      const next21 = ema21[i + j];
      const next50 = ema50[i + j];
      if (next21 === null || next50 === null) {
        gapConfirmed = false;
        break;
      }
      const nextGap = Math.abs(next21 - next50);
      if (nextGap <= prevGap) {
        gapConfirmed = false;
        break;
      }
      prevGap = nextGap;
    }

    if (!gapConfirmed) {
      console.log(
        "[EMA]  Cross found but gap did not widen for 3 candles — rejected",
      );
      break;
    }

    // ── Slope / angle filter ───────────────────────────────────────────────────
    const slope21 = calcEMASlope(ema21, CONFIG.slopeLookback, currentPrice);
    const slope50 = calcEMASlope(ema50, CONFIG.slopeLookback, currentPrice);
    const minSlope = CONFIG.minSlopePercent;

    if (slope21 === null || slope50 === null) break;

    if (crossedBull) {
      if (slope21 < minSlope) {
        console.log(
          `[EMA]  BULL cross: EMA21 slope too flat (${slope21.toFixed(5)}% < ${minSlope}%) — rejected`,
        );
        break;
      }
      if (slope50 < -minSlope) {
        console.log(
          `[EMA]  BULL cross: EMA50 opposing too strongly (${slope50.toFixed(5)}%) — rejected`,
        );
        break;
      }
      console.log(
        `[EMA]  BULL cross confirmed ✅  EMA21 slope: ${slope21.toFixed(5)}%  EMA50 slope: ${slope50.toFixed(5)}%`,
      );
      return "BULL";
    }

    if (crossedBear) {
      if (slope21 > -minSlope) {
        console.log(
          `[EMA]  BEAR cross: EMA21 slope too flat (${slope21.toFixed(5)}% > -${minSlope}%) — rejected`,
        );
        break;
      }
      if (slope50 > minSlope) {
        console.log(
          `[EMA]  BEAR cross: EMA50 opposing too strongly (${slope50.toFixed(5)}%) — rejected`,
        );
        break;
      }
      console.log(
        `[EMA]  BEAR cross confirmed ✅  EMA21 slope: ${slope21.toFixed(5)}%  EMA50 slope: ${slope50.toFixed(5)}%`,
      );
      return "BEAR";
    }

    break;
  }

  return null;
}

// ─── MACD HISTOGRAM DETECTION ────────────────────────────────────────────────

/**
 * Detect MACD histogram zero-line cross with 2 growing confirmation bars.
 *
 * Returns 'BULL', 'BEAR', or null.
 */
function detectMACDHistogram(histogram) {
  const len = histogram.length;
  if (len < 4) return null;

  for (let i = len - 3; i >= 1; i--) {
    const prev = histogram[i - 1];
    const curr = histogram[i];
    const bar1 = histogram[i + 1];
    const bar2 = histogram[i + 2];

    if (prev === null || curr === null || bar1 === null || bar2 === null)
      continue;

    const crossedBull = prev < 0 && curr > 0;
    const crossedBear = prev > 0 && curr < 0;

    if (!crossedBull && !crossedBear) continue;

    if (crossedBull && bar1 > curr && bar2 > bar1) {
      console.log(
        `[MACD] BULL zero-cross confirmed ✅  bars: ${prev.toFixed(6)} → ${curr.toFixed(6)} → ${bar1.toFixed(6)} → ${bar2.toFixed(6)}`,
      );
      return "BULL";
    }

    if (crossedBear && bar1 < curr && bar2 < bar1) {
      console.log(
        `[MACD] BEAR zero-cross confirmed ✅  bars: ${prev.toFixed(6)} → ${curr.toFixed(6)} → ${bar1.toFixed(6)} → ${bar2.toFixed(6)}`,
      );
      return "BEAR";
    }

    // Only check most recent cross — stop here regardless
    console.log("[MACD] Zero-cross found but bars not growing — rejected");
    break;
  }

  return null;
}

// ─── REDIS STATE MANAGEMENT ───────────────────────────────────────────────────

async function setSignalKey(key, direction) {
  await redis.set(key, direction, "EX", CONFIG.redisTTL);
  console.log(
    `[Redis] SET ${key} = ${direction}  (TTL: ${CONFIG.redisTTL / 3600}h)`,
  );
}

async function clearBothKeys() {
  await redis.del(CONFIG.redisKeyEma, CONFIG.redisKeyMacd);
  console.log("[Redis] CLEARED both signal keys after signal fired");
}

async function getBothKeys() {
  const [ema, macd] = await redis.mget(CONFIG.redisKeyEma, CONFIG.redisKeyMacd);
  return { ema, macd };
}

// ─── SIGNAL EMIT ─────────────────────────────────────────────────────────────

async function emitSignal(storedEma, storedMacd, currentPrice) {
  const timestamp = new Date().toISOString();
  const arrow = storedEma === "BULL" ? "🟢" : "🔴";
  const label = storedEma === "BULL" ? "BUY  (LONG) " : "SELL (SHORT)";

  console.log("");
  console.log("════════════════════════════════════════════════");
  console.log(
    `${arrow}  SIGNAL: ${label}  |  ${CONFIG.instrument}  |  ${timestamp}`,
  );
  console.log(`   Price  : ${currentPrice.toFixed(5)}`);
  console.log("   EMA 21/50 confirmed crossover          ✅");
  console.log("   MACD histogram zero-cross confirmed    ✅");
  console.log("   Both confluences aligned →", label.trim());
  console.log("════════════════════════════════════════════════");
  console.log("");

  const now = dayjs().tz("Australia/Brisbane");
  const brisbane_time = now.format("YYYY-MM-DD HH:mm:ss");

  await insert("manual_ema_macd", {
    storedEma,
    storedMacd,
    currentPrice,
    label,
    symbol: CONFIG.instrument,
    timestamp,
    brisbane_time,
  });

  const emailSubject = `🚨 ${label} signal fired on ${CONFIG.instrument} 🚨`;
  const emailBody = `
  ${arrow}  SIGNAL: ${label}  |  ${CONFIG.instrument}  |  ${timestamp}
   Price  : ${currentPrice.toFixed(5)}
   EMA 21/50 confirmed crossover          ✅
   MACD histogram zero-cross confirmed    ✅
   Both confluences aligned → ${label.trim()}
  `;
  console.log(`Email subject - ${emailSubject}`);
  console.log(emailBody);
  try {
    await sendEmail(emailSubject, emailBody);
  } catch (error) {
    console.error("Error sending email:", error);
  }

  // ── Hook ──────────────────────────────────────────────────────────────────
  // Add your Telegram / webhook / order placement here, e.g.:
  // await sendTelegramAlert({ direction, label, price: currentPrice, timestamp });
  // await placeOandaOrder({ direction, units: 1000 });
}

// ─── MAIN RUN LOOP ────────────────────────────────────────────────────────────

async function run() {
  console.log(
    `[${new Date().toISOString()}] Running signal check — ${CONFIG.instrument} ${CONFIG.granularity}`,
  );

  // 1. Fetch candles from Oanda
  let candles;
  try {
    candles = await fetchCandles();
    const latest = candles.at(-1);
    console.log(
      `[Data]  Fetched ${candles.length} candles.  Latest close: ${latest.close.toFixed(5)}  @ ${latest.time}`,
    );
  } catch (err) {
    console.error("[Fetch] Failed to get candles:", err.message);
    if (err.response) {
      console.error(
        "[Fetch] Oanda response:",
        err.response.status,
        JSON.stringify(err.response.data),
      );
    }
    return;
  }

  const closes = candles.map((c) => c.close);
  const currentPrice = closes.at(-1);

  // 2. Calculate indicators
  const ema21arr = calcEMA(closes, CONFIG.emaFast);
  const ema50arr = calcEMA(closes, CONFIG.emaSlow);
  const { histogram } = calcMACD(
    closes,
    CONFIG.macdFast,
    CONFIG.macdSlow,
    CONFIG.macdSignal,
  );

  // Log EMA state and slopes each run
  const slope21 = calcEMASlope(ema21arr, CONFIG.slopeLookback, currentPrice);
  const slope50 = calcEMASlope(ema50arr, CONFIG.slopeLookback, currentPrice);
  console.log(
    `[EMA]   21: ${ema21arr.at(-1)?.toFixed(5)}   50: ${ema50arr.at(-1)?.toFixed(5)}`,
  );
  console.log(
    `[EMA]   Slope21: ${slope21?.toFixed(5)}%   Slope50: ${slope50?.toFixed(5)}%   (min: ±${CONFIG.minSlopePercent}%)`,
  );

  // 3. Run detectors
  const emaSignal = detectEMACrossover(ema21arr, ema50arr, currentPrice);
  const macdSignal = detectMACDHistogram(histogram);

  console.log(`[EMA]   Signal: ${emaSignal ?? "none"}`);
  console.log(`[MACD]  Signal: ${macdSignal ?? "none"}`);

  // 4. Update Redis if new signals found
  if (emaSignal) await setSignalKey(CONFIG.redisKeyEma, emaSignal);
  if (macdSignal) await setSignalKey(CONFIG.redisKeyMacd, macdSignal);

  // 5. Read current Redis state
  const { ema: storedEma, macd: storedMacd } = await getBothKeys();
  console.log(
    `[Redis] State → EMA: ${storedEma ?? "empty"}   MACD: ${storedMacd ?? "empty"}`,
  );

  // 6. Check confluence
  if (storedEma && storedMacd && storedEma === storedMacd) {
    await emitSignal(storedEma, storedMacd, currentPrice);
    await clearBothKeys();
  } else {
    console.log("[Signal] No confluence yet — waiting for both keys to align.");
  }
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

cron.schedule("*/15 * * * *", async () => {
  console.log("══════════════════════════════════════════════════════");
  console.log("  EUR_USD — Oanda 15m Signal Engine");
  console.log("  EMA 21/50 (3-candle gap + slope filter) + MACD Histogram");
  console.log(`  Min slope threshold : ±${CONFIG.minSlopePercent}% per candle`);
  console.log(`  Redis TTL           : ${CONFIG.redisTTL / 3600}h`);
  console.log("══════════════════════════════════════════════════════");
  await run();
});
