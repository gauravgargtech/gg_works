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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// -------------------- SCORE ENGINE --------------------
async function analyzePair(instrument) {
  console.log(`\nScanning ${instrument}...\n`);
  const candles = await fetchCandles(instrument, "H4", 500);

  const closes = candles.map((c) => c.close);

  const ema50 = EMA.calculate({ period: 200, values: closes });

  if (ema50.length < 60) return;

  const slope = emaSlope(ema50);

  const lastCandle = candles[candles.length - 1];

  console.log(slope);
  const lastEma = ema50[ema50.length - 1];

  let isReady = false;
  if (lastCandle.high > lastEma && lastCandle.low < lastEma) {
    isReady = true;
  }

  if (isReady) {
    const isCC = await get(`ema_crossing_simple_${instrument}`);
    if (!isCC) {
      await set(`ema_crossing_simple_${instrument}`, "oks", 3600 * 20);

      let bias = "";

      if (lastCandle.close > lastEma) bias = "up";
      else bias = "down";

      await sendPushNotif(
        `EMA 50 Crossing Simple:  ${instrument} | Bias: ${bias}`,
      );
    }
    console.log(`🔥 HIGH QUALITY SETUP: ${instrument} | Score: ${score}/10`);
  }
}

// -------------------- RUNNER --------------------
async function runEmaCrossingSimple() {
  console.log("\nScanning markets...\n");

  for (const p of FOREX_PAIRS) {
    try {
      await analyzePair(p);
      await sleep(500);
    } catch (e) {
      console.log(`Error: ${p}`);
    }
  }

  console.log("\nScan complete\n");
}

module.exports = runEmaCrossingSimple;
