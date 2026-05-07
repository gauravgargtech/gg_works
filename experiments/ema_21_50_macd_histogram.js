"use strict";

/**
 * BTCUSDT Perpetual — 15m Signal Engine
 *
 * Logic:
 *  - Fetches 15m klines from Bybit every 15 minutes
 *  - EMA 21/50 confirmed crossover (3-candle widening gap rule) → sets redis key: signal:ema
 *  - MACD histogram zero-line cross with growing bars → sets redis key: signal:macd
 *  - When BOTH keys exist AND are same direction → fire signal, then clear both keys
 *  - Keys persist indefinitely until the other confluences arrives or direction flips
 */
require("../config/config");
const process = require("process");
const { insert } = require("../adapters/mongo");

const Redis = require("ioredis");
const axios = require("axios");
const cron = require("node-cron");
const { sendEmail } = require("../common/email.js");
const { sendSignalAlert } = require("../config/telegram_notify");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: "BTCUSDT",
  interval: "15", // 15m kline
  limit: 120, // candles fetched (enough for EMA 50 + confirmation candles)
  bybitBase: "https://api.bybit.com",

  // EMA periods
  emaFast: 21,
  emaSlow: 50,

  // MACD default settings
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  // 3-candle gap confirmation: gap must widen for this many candles after cross
  gapConfirmCandles: 3,

  // EMA slope / angle filter
  // Slope is measured as (EMA change over N candles) / currentPrice * 100
  // i.e. % of price moved per candle — tune this threshold to taste
  // ~0.05% per candle ≈ visually steep enough on 15m BTC chart
  slopeLookback: 5, // candles to measure slope over
  minSlopePercent: 0.05, // minimum slope % to accept crossover (reject flat crosses)

  // Redis keys
  redisKeyEma: "signal:ema",
  redisKeyMacd: "signal:macd",

  // Redis TTL (seconds) — safety expiry so stale keys don't live forever (e.g. 4 hours)
  redisTTL: 60 * 60 * 4,

  redis: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    password: process.env.REDIS_PASSWORD || undefined,
  },
};

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

  // seed with SMA
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

  // signal line is EMA of macdLine (use only non-null values, but keep index aligned)
  const macdValid = macdLine.filter((v) => v !== null);
  const signalOnly = calcEMA(macdValid, signal);

  // re-align signal back to full length
  const signalLine = new Array(closes.length).fill(null);
  let si = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null) {
      signalLine[i] = signalOnly[si++] ?? null;
    }
  }

  const histogram = closes.map((_, i) =>
    macdLine[i] !== null && signalLine[i] !== null
      ? macdLine[i] - signalLine[i]
      : null,
  );

  return { macdLine, signalLine, histogram };
}

/**
 * Calculate the slope of an EMA array over the last `lookback` candles,
 * normalised as a percentage of currentPrice per candle.
 *
 * Positive = rising, Negative = falling.
 * Returns null if not enough data.
 */
function calcEMASlope(emaArr, lookback, currentPrice) {
  const len = emaArr.length;
  const curr = emaArr[len - 1];
  const prev = emaArr[len - 1 - lookback];

  if (curr === null || prev === null || currentPrice === 0) return null;

  // Total change over lookback candles, expressed as % of price per candle
  return ((curr - prev) / lookback / currentPrice) * 100;
}

// ─── BYBIT DATA FETCH ─────────────────────────────────────────────────────────

async function fetchKlines() {
  const url = `${CONFIG.bybitBase}/v5/market/kline`;
  const params = {
    category: "linear",
    symbol: CONFIG.symbol,
    interval: CONFIG.interval,
    limit: CONFIG.limit,
  };

  const { data } = await axios.get(url, { params, timeout: 10000 });

  if (data.retCode !== 0) {
    throw new Error(`Bybit API error: ${data.retMsg}`);
  }

  // Bybit returns newest first — reverse so index 0 = oldest
  const raw = data.result.list.reverse();

  // Each item: [startTime, open, high, low, close, volume, turnover]
  return raw.map((k) => ({
    time: parseInt(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── EMA CROSSOVER DETECTION ──────────────────────────────────────────────────

/**
 * Detect confirmed EMA 21/50 crossover using:
 *  1. 3-candle widening gap rule
 *  2. EMA 21 slope must exceed MIN_SLOPE_PERCENT (angle filter)
 *  3. EMA 50 slope must not be strongly opposing the cross direction
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

    // ── Gap widening check (3 candles) ────────────────────────────────────────
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

    if (!gapConfirmed) break; // most recent cross failed gap rule — stop

    // ── Slope / angle check ────────────────────────────────────────────────────
    const slope21 = calcEMASlope(ema21, CONFIG.slopeLookback, currentPrice);
    const slope50 = calcEMASlope(ema50, CONFIG.slopeLookback, currentPrice);
    const minSlope = CONFIG.minSlopePercent;

    if (slope21 === null || slope50 === null) break;

    if (crossedBull) {
      // EMA 21 must be rising strongly
      if (slope21 < minSlope) {
        console.log(
          `[EMA] BULL cross found but EMA21 slope too flat (${slope21.toFixed(4)}% < ${minSlope}%) — rejected`,
        );
        break;
      }
      // EMA 50 must not be falling sharply against the move
      if (slope50 < -minSlope) {
        console.log(
          `[EMA] BULL cross found but EMA50 opposing slope too strong (${slope50.toFixed(4)}%) — rejected`,
        );
        break;
      }
      console.log(
        `[EMA] BULL cross confirmed — EMA21 slope: ${slope21.toFixed(4)}%  EMA50 slope: ${slope50.toFixed(4)}%`,
      );
      return "BULL";
    }

    if (crossedBear) {
      // EMA 21 must be falling strongly
      if (slope21 > -minSlope) {
        console.log(
          `[EMA] BEAR cross found but EMA21 slope too flat (${slope21.toFixed(4)}% > -${minSlope}%) — rejected`,
        );
        break;
      }
      // EMA 50 must not be rising sharply against the move
      if (slope50 > minSlope) {
        console.log(
          `[EMA] BEAR cross found but EMA50 opposing slope too strong (${slope50.toFixed(4)}%) — rejected`,
        );
        break;
      }
      console.log(
        `[EMA] BEAR cross confirmed — EMA21 slope: ${slope21.toFixed(4)}%  EMA50 slope: ${slope50.toFixed(4)}%`,
      );
      return "BEAR";
    }

    break;
  }

  return null;
}

// ─── MACD HISTOGRAM DETECTION ────────────────────────────────────────────────

/**
 * Detect MACD histogram zero-line cross with at least 2 growing bars after cross.
 *
 * Returns 'BULL' (cross from negative to positive, bars growing positive),
 *         'BEAR' (cross from positive to negative, bars growing negative),
 *         or null.
 */
function detectMACDHistogram(histogram) {
  const len = histogram.length;
  if (len < 4) return null;

  // Look at last few bars: we need cross + 2 growing bars
  // i = cross candle, i+1 and i+2 must be growing in same direction
  // Check most recent possible cross (len-3 gives room for 2 confirmation bars)
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

    if (crossedBull) {
      // bars must both be positive and growing
      if (bar1 > curr && bar2 > bar1) return "BULL";
    }

    if (crossedBear) {
      // bars must both be negative and growing more negative
      if (bar1 < curr && bar2 < bar1) return "BEAR";
    }

    // Only check most recent cross
    break;
  }

  return null;
}

// ─── REDIS STATE MANAGEMENT ───────────────────────────────────────────────────

async function setSignalKey(key, direction) {
  await redis.set(key, direction, "EX", CONFIG.redisTTL);
  console.log(`[Redis] SET ${key} = ${direction}`);
}

async function clearBothKeys() {
  await redis.del(CONFIG.redisKeyEma, CONFIG.redisKeyMacd);
  console.log("[Redis] CLEARED both signal keys after signal fired");
}

async function getBothKeys() {
  const [ema, macd] = await redis.mget(CONFIG.redisKeyEma, CONFIG.redisKeyMacd);
  return { ema, macd };
}

// ─── SIGNAL LOGIC ─────────────────────────────────────────────────────────────

async function emitSignal(storedEma, storedMacd, currentPrice) {
  const timestamp = new Date().toISOString();
  const arrow = storedEma === "BULL" ? "🟢" : "🔴";
  const label = storedEma === "BULL" ? "LONG" : "SHORT";

  console.log("");
  console.log("════════════════════════════════════════");
  console.log(
    `${arrow}  SIGNAL: ${label}  |  ${CONFIG.symbol}  |  ${timestamp}`,
  );
  console.log("   EMA 21/50 confirmed crossover ✅");
  console.log("   MACD histogram zero-cross confirmed ✅");
  console.log("   Both confluences aligned →", label);
  console.log("════════════════════════════════════════");
  console.log("");

  const now = dayjs().tz("Australia/Brisbane");
  const brisbane_time = now.format("YYYY-MM-DD HH:mm:ss");

  await insert("manual_ema_macd", {
    storedEma,
    storedMacd,
    currentPrice,
    label,
    symbol: CONFIG.symbol,
    timestamp,
    brisbane_time: brisbane_time,
  });

  const emailSubject = `🚨 ${label} signal fired on ${CONFIG.symbol} 🚨`;
  const emailBody = `
  ${arrow}  SIGNAL: ${label}  |  ${CONFIG.symbol}  |  ${timestamp}
   EMA 21/50 confirmed crossover ✅
   MACD histogram zero-cross confirmed ✅
   Both confluences aligned → ${label}
  `;

  try {
    await sendSignalAlert(CONFIG.symbol, label, currentPrice, {
      time: brisbane_time,
    });
  } catch (error) {
    console.error("Error sending signal alert:", error);
  }

  console.log(`[Email] Sending email: ${emailSubject}`);
  console.log(`[Email] ${emailBody}`);
  try {
    await sendEmail(emailSubject, emailBody);
  } catch (error) {
    console.error("Error sending email:", error);
  }

  // Hook: replace or extend this with webhook / exchange order / telegram alert
  // e.g. await sendTelegramAlert(label, timestamp);
}

// ─── MAIN RUN LOOP ────────────────────────────────────────────────────────────

async function btcSignals() {
  console.log(
    `[${new Date().toISOString()}] Running signal check — ${CONFIG.symbol} ${CONFIG.interval}m`,
  );

  // 1. Fetch candles
  let klines;
  try {
    klines = await fetchKlines();
    console.log(
      `[Data] Fetched ${klines.length} candles. Latest close: ${klines.at(-1).close}`,
    );
  } catch (err) {
    console.error("[Fetch] Failed to get klines:", err.message);
    return;
  }

  const closes = klines.map((k) => k.close);
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

  // Log current EMA values and slopes for visibility
  const slope21 = calcEMASlope(ema21arr, CONFIG.slopeLookback, currentPrice);
  const slope50 = calcEMASlope(ema50arr, CONFIG.slopeLookback, currentPrice);
  console.log(
    `[EMA]  21: ${ema21arr.at(-1)?.toFixed(2)}  50: ${ema50arr.at(-1)?.toFixed(2)}`,
  );
  console.log(
    `[EMA]  Slope21: ${slope21?.toFixed(4)}%  Slope50: ${slope50?.toFixed(4)}%  (min: ±${CONFIG.minSlopePercent}%)`,
  );

  // 3. Detect signals
  const emaSignal = detectEMACrossover(ema21arr, ema50arr, currentPrice);
  const macdSignal = detectMACDHistogram(histogram);

  console.log(`[EMA]  Crossover detected: ${emaSignal ?? "none"}`);
  console.log(`[MACD] Histogram signal  : ${macdSignal ?? "none"}`);

  // 4. Update Redis keys if new signals detected
  if (emaSignal) await setSignalKey(CONFIG.redisKeyEma, emaSignal);
  if (macdSignal) await setSignalKey(CONFIG.redisKeyMacd, macdSignal);

  // 5. Read current state of both keys
  const { ema: storedEma, macd: storedMacd } = await getBothKeys();
  console.log(
    `[Redis] Current state → EMA: ${storedEma ?? "empty"} | MACD: ${storedMacd ?? "empty"}`,
  );

  // 6. Check confluence — both must exist AND be same direction
  if (storedEma && storedMacd && storedEma === storedMacd) {
    await emitSignal(storedEma, storedMacd, currentPrice);
    await clearBothKeys();
  } else {
    console.log("[Signal] No confluence yet — waiting for both keys to align.");
  }
}

module.exports = btcSignals;
