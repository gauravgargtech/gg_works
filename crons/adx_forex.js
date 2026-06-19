require("../config/config");
const https = require("https");

const { set, get, del } = require("../adapters/redis");
const { EMA } = require("technicalindicators");

const { sendPushNotif } = require("../config/telegram_notify");

const { fetchCandles } = require("../exhanges/oanda");

const axios = require("axios");

const SYMBOL = "BTCUSDT";
const LENGTH = 12; // ADX length (from your Pine Script param)
const THRESHOLD = 20; // the level we watch for crossover
const LIMIT = 800; // enough candles for warm-up + stable ADX
const BASE_URL = "https://api.binance.com";

// ─── Bybit interval string → Binance interval string ──────────
// Bybit uses plain minute numbers ("3", "15", "60", "D", etc.)
// Binance uses labels like "3m", "15m", "1h", "1d", etc.
function toBinanceInterval(interval) {
  const map = {
    1: "1m",
    3: "3m",
    5: "5m",
    15: "15m",
    30: "30m",
    60: "1h",
    120: "2h",
    240: "4h",
    360: "6h",
    720: "12h",
    D: "1d",
    W: "1w",
    M: "1M",
  };
  return map[String(interval)] || `${interval}m`;
}

function calculateADX(candles, len) {
  const n = candles.length;

  // ── Step 1: Raw TR, DM+, DM- ─────────────────────────────
  const TR = new Array(n).fill(0);
  const DMPlus = new Array(n).fill(0);
  const DMMinus = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    // nz(x[1]) → 0 on the very first bar, previous value otherwise
    const prevHigh = i > 0 ? candles[i - 1].high : 0;
    const prevLow = i > 0 ? candles[i - 1].low : 0;
    const prevClose = i > 0 ? candles[i - 1].close : 0;

    // TrueRange = max(max(high-low, |high-prevClose|), |low-prevClose|)
    TR[i] = Math.max(
      Math.max(high - low, Math.abs(high - prevClose)),
      Math.abs(low - prevClose),
    );

    const upMove = high - prevHigh; // high - nz(high[1])
    const downMove = prevLow - low; // nz(low[1]) - low

    // DM+: only count when upMove wins and is positive
    DMPlus[i] = upMove > downMove ? Math.max(upMove, 0) : 0;
    // DM-: only count when downMove wins and is positive
    DMMinus[i] = downMove > upMove ? Math.max(downMove, 0) : 0;
  }

  // ── Step 2: Wilder's smoothing ────────────────────────────
  // SmoothedX[i] = SmoothedX[i-1] - SmoothedX[i-1]/len + X[i]
  // At i=0: SmoothedX[-1] = 0 (nz), so SmoothedX[0] = TR[0]
  const sTR = new Array(n).fill(0);
  const sDMPlus = new Array(n).fill(0);
  const sDMMinus = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const pTR = i > 0 ? sTR[i - 1] : 0;
    const pDP = i > 0 ? sDMPlus[i - 1] : 0;
    const pDM = i > 0 ? sDMMinus[i - 1] : 0;

    sTR[i] = pTR - pTR / len + TR[i];
    sDMPlus[i] = pDP - pDP / len + DMPlus[i];
    sDMMinus[i] = pDM - pDM / len + DMMinus[i];
  }

  // ── Step 3: DI+, DI-, DX ─────────────────────────────────
  const diPlus = new Array(n).fill(0);
  const diMinus = new Array(n).fill(0);
  const dx = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    if (sTR[i] === 0) continue;

    diPlus[i] = (sDMPlus[i] / sTR[i]) * 100;
    diMinus[i] = (sDMMinus[i] / sTR[i]) * 100;

    const diSum = diPlus[i] + diMinus[i];
    dx[i] = diSum === 0 ? 0 : (Math.abs(diPlus[i] - diMinus[i]) / diSum) * 100;
  }

  // ── Step 4: ADX = sma(DX, len) ───────────────────────────
  // Simple moving average — null until we have `len` DX values
  const adx = new Array(n).fill(null);

  for (let i = len - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - len + 1; j <= i; j++) sum += dx[j];
    adx[i] = sum / len;
  }

  // Return full dataset
  return candles.map((c, i) => ({
    ...c,
    diPlus: +diPlus[i].toFixed(4),
    diMinus: +diMinus[i].toFixed(4),
    dx: +dx[i].toFixed(4),
    adx: adx[i] !== null ? +adx[i].toFixed(4) : null,
  }));
}

// ─── Check for ADX crossing above threshold ───────────────────
function checkCrossover(results, threshold) {
  // Only use bars where ADX is fully calculated
  const valid = results.filter((r) => r.adx !== null);
  if (valid.length < 2) return null;

  const curr = valid[valid.length - 1];
  const prev = valid[valid.length - 2];

  const last12ADx = results.slice(-22);

  let wasMarketSilent = false;

  for (const adx of last12ADx) {
    if (adx.adx < 18) {
      wasMarketSilent = true;
    }
  }

  return {
    curr,
    prev,
    // The key signal: ADX was below threshold, now crossed above
    crossedAbove: prev.adx < threshold && curr.adx >= threshold,
    // Also useful: ADX is above threshold AND still rising
    risingAbove: curr.adx >= threshold && curr.adx > prev.adx && curr.adx < 28,
    // ADX is rising regardless of level
    rising: curr.adx > prev.adx,
    wasMarketSilent,
  };
}

// ─── Helpers ──────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function batchProcess(items, batchSize, delayMs, fn) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(fn));
    if (i + batchSize < items.length) await sleep(delayMs);
  }
}

// ─── Main ─────────────────────────────────────────────────────
async function checkAdxTrendForex(theTimeInterval = "H4") {
  for (const coin of FOREX_PAIRS) {
    const symbol = coin;

    await sleep(1000);

    const redisKeyUp = `${symbol}_adx_value_up_${theTimeInterval}`;
    const redisKeyDown = `${symbol}_adx_value_down_${theTimeInterval}`;

    console.log(`Scanning for ${symbol}...`);

    const now = new Date().toLocaleString("en-AU", {
      timeZone: "Australia/Brisbane",
    });

    const candles = await fetchCandles(symbol, theTimeInterval, LIMIT);

    const results = calculateADX(candles, LENGTH);
    const check = checkCrossover(results, THRESHOLD);

    if (!check) {
      console.log("Not enough data yet.");
      return;
    }
    const currentPrice = candles[candles.length - 1].close;

    const { curr, prev } = check;

    const closes = candles.map((c) => c.close);

    const ema200 = EMA.calculate({ period: 200, values: closes });

    const ema200Last = ema200[ema200.length - 1];

    const latestCandleClose = candles[candles.length - 1].close;

    const latestCandleHigh = candles[candles.length - 1].high;
    const latestCandleLow = candles[candles.length - 1].low;

    const adjustedEma200High = 1.001 * ema200Last;
    const adjustedEma200Low = 0.999 * ema200Last;

    /*
    if (latestCandleClose < ema200 && latestCandleHigh >= adjustedEma200High) {
      await del(redisKeyDown);
    } else if (
      latestCandleClose > ema200 &&
      latestCandleLow <= adjustedEma200Low
    ) {
      await del(redisKeyUp);
    }

    if (latestCandleClose > ema200 && latestCandleLow < ema200) {
      await del(redisKeyUp);
    } else if (ema200 > latestCandleClose && latestCandleHigh > ema200) {
      await del(redisKeyDown);
    }
      */

    let percentageDiff;
    if (ema200Last > latestCandleClose) {
      percentageDiff = ((latestCandleClose - ema200Last) / ema200Last) * 100;
    } else {
      percentageDiff =
        ((ema200Last - latestCandleClose) / latestCandleClose) * 100;
    }

    let isEMA200Aligned = false;

    if (curr.diPlus > curr.diMinus && currentPrice > ema200Last) {
      isEMA200Aligned = true;
    } else if (curr.diPlus < curr.diMinus && currentPrice < ema200Last) {
      isEMA200Aligned = true;
    }

    const last12Candles = candles.slice(-12);
    let isComingFromDiffDirection = false;

    for (const cg of last12Candles) {
      if (curr.diPlus > curr.diMinus && cg.low <= ema200Last) {
        isComingFromDiffDirection = true;
      } else if (curr.diPlus < curr.diMinus && cg.high >= ema200Last) {
        isComingFromDiffDirection = true;
      }
    }

    if (
      (check.crossedAbove || check.risingAbove) &&
      check.wasMarketSilent &&
      isEMA200Aligned &&
      isComingFromDiffDirection
    ) {
      let iscC = false;
      if (curr.diPlus > curr.diMinus) {
        iscC = await get(redisKeyUp);
      } else if (curr.diPlus < curr.diMinus) {
        iscC = await get(redisKeyDown);
      }

      if (!iscC) {
        await sendPushNotif(`${percentageDiff < 0.2 ? "GOLDEN : " : ""} ${theTimeInterval} Minutes : ${symbol} ADX above ${THRESHOLD} and rising
        ${curr.diPlus > curr.diMinus ? "🟢 DI+ leading (bullish)" : "🔴 DI- leading (bearish)"}`);

        let cacheExpiry = 3600 * 16;
        if (theTimeInterval === "D") {
          cacheExpiry = 3600 * 24 * 3;
        }

        if (curr.diPlus > curr.diMinus) {
          await set(redisKeyUp, JSON.stringify(check), cacheExpiry);
        } else if (curr.diPlus < curr.diMinus) {
          await set(redisKeyDown, JSON.stringify(check), cacheExpiry);
        }
      }
    }
  }
  return;
}

module.exports = checkAdxTrendForex;
