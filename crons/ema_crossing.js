require("../config/config");
const axios = require("axios");
const { EMA } = require("technicalindicators");

const API_KEY = process.env.OANDA_API_KEY;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;

const { get, set } = require("../adapters/redis");
const { fetchCandles } = require("../exhanges/oanda");

const { sendPushNotif } = require("../config/telegram_notify");

function emaSlope(ema) {
  const last = ema[ema.length - 1];
  const prev = ema[ema.length - 5];
  if (last > prev) return "UP";
  if (last < prev) return "DOWN";
  return "FLAT";
}

// -------------------- DISPLACEMENT --------------------
function displacement(candle, avgBody) {
  const body = Math.abs(candle.close - candle.open);
  return body > avgBody * 1.5;
}

// -------------------- FVG DETECTION --------------------
// Classic 3-candle imbalance
function detectFVG(candles) {
  const zones = [];

  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c3 = candles[i];

    // Bullish FVG
    if (c1.high < c3.low) {
      zones.push({
        type: "bullish",
        low: c1.high,
        high: c3.low,
      });
    }

    // Bearish FVG
    if (c1.low > c3.high) {
      zones.push({
        type: "bearish",
        low: c3.high,
        high: c1.low,
      });
    }
  }

  return zones;
}

// -------------------- LIQUIDITY SWEEP --------------------
function liquiditySweep(candles) {
  const recent = candles.slice(-20);

  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);

  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);

  const last = candles[candles.length - 1];

  const sweepHigh = last.high > maxHigh && last.close < maxHigh;
  const sweepLow = last.low < minLow && last.close > minLow;

  return {
    sweepHigh,
    sweepLow,
  };
}

// -------------------- M15 CONFIRMATION (SIMPLIFIED) --------------------
async function m15Confirmation(instrument) {
  const candles = await fetchCandles(instrument, "M15", 60);

  const closes = candles.map((c) => c.close);
  const ema = EMA.calculate({ period: 20, values: closes });

  const last = candles[candles.length - 1];
  const emaLast = ema[ema.length - 1];

  // simple alignment proxy
  return last.close > emaLast ? "UP" : "DOWN";
}

// -------------------- SCORE ENGINE --------------------
async function analyzePair(instrument) {
  console.log(`\nScanning ${instrument}...\n`);
  const candles = await fetchCandles(instrument, "H4", 120);

  const closes = candles.map((c) => c.close);

  const ema50 = EMA.calculate({ period: 50, values: closes });

  if (ema50.length < 60) return;

  const slope = emaSlope(ema50);

  const last = candles[candles.length - 1];

  const avgBody =
    candles.slice(-20).reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 20;

  let score = 0;

  // 1. EMA trend
  if (slope !== "FLAT") score += 2;

  // 2. Displacement
  if (displacement(last, avgBody)) score += 2;

  // 3. FVG
  const fvg = detectFVG(candles.slice(-30));
  if (fvg.length > 0) score += 2;

  // 4. Liquidity sweep
  const sweep = liquiditySweep(candles);
  if (sweep.sweepHigh || sweep.sweepLow) score += 2;

  // 5. M15 confirmation
  const m15 = await m15Confirmation(instrument);
  if (
    (slope === "UP" && m15 === "UP") ||
    (slope === "DOWN" && m15 === "DOWN")
  ) {
    score += 2;
  }

  // ---------------- OUTPUT ----------------
  if (score >= 6) {
    await sendPushNotif(
      `🚀 HIGH QUALITY SETUP: FVG + DISPLACEMENT - ${instrument} | Score: ${score}/10`,
    );
    console.log(`🔥 HIGH QUALITY SETUP: ${instrument} | Score: ${score}/10`);
  } else if (score >= 5) {
    console.log(`⚠️ WATCHLIST: ${instrument} | Score: ${score}/10`);
  }
}

// -------------------- RUNNER --------------------
async function runEmaCrossing() {
  console.log("\nScanning markets...\n");

  for (const p of FOREX_PAIRS) {
    try {
      await analyzePair(p);
    } catch (e) {
      console.log(`Error: ${p}`);
    }
  }

  console.log("\nScan complete\n");
}

module.exports = runEmaCrossing;
