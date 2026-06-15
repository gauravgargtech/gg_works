require("../config/config");
const https = require("https");

const { set, get } = require("../adapters/redis");

const { sendPushNotif } = require("../config/telegram_notify");

const { fetchCandles, getTop100ByVolume } = require("../exhanges/bybit_public");

const axios = require("axios");

const SYMBOL = "BTCUSDT";
const INTERVAL = "3"; // 15-minute candles
const LENGTH = 14; // ADX length (from your Pine Script param)
const THRESHOLD = 25; // the level we watch for crossover
const LIMIT = 200; // enough candles for warm-up + stable ADX
const BASE_URL = "https://api.bybit.com";

async function fetchJSON(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const json = await new Promise((resolve, reject) => {
      https
        .get(url, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error("JSON parse error: " + e.message));
            }
          });
        })
        .on("error", reject);
    });

    // Rate limited — wait and retry
    if (
      json.retCode === 10006 ||
      json.retCode === 10018 ||
      (json.retMsg && json.retMsg.includes("Rate Limit"))
    ) {
      const wait = 5000 * (attempt + 1);
      console.warn(
        `Rate limited on attempt ${attempt + 1}, waiting ${wait / 1000}s...`,
      );
      await sleep(wait);
      continue;
    }

    return json; // success
  }
  throw new Error(`Max retries exceeded for: ${url}`);
}

// ─── ADX — exact translation of the Pine Script ───────────────
//
//  Pine line by line:
//
//  TrueRange = max(max(high-low, abs(high-nz(close[1]))), abs(low-nz(close[1])))
//  DM+ = high-nz(high[1]) > nz(low[1])-low  ?  max(high-nz(high[1]), 0)  : 0
//  DM- = nz(low[1])-low   > high-nz(high[1]) ? max(nz(low[1])-low, 0)   : 0
//
//  Smoothing (Wilder's running method, NOT classic RMA):
//    SmoothedTR[i]  = SmoothedTR[i-1]  - SmoothedTR[i-1]/len  + TR[i]
//    SmoothedDM+[i] = SmoothedDM+[i-1] - SmoothedDM+[i-1]/len + DM+[i]
//    SmoothedDM-[i] = SmoothedDM-[i-1] - SmoothedDM-[i-1]/len + DM-[i]
//    (nz() means treat na as 0 — at bar 0 all previous values = 0)
//
//  DI+  = SmoothedDM+ / SmoothedTR * 100
//  DI-  = SmoothedDM- / SmoothedTR * 100
//  DX   = abs(DI+ - DI-) / (DI+ + DI-) * 100
//  ADX  = sma(DX, len)   ← simple moving average of DX
//
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

  const last12ADx = results.slice(-12);

  let wasMarketSilent = false;

  for (const adx of last12ADx) {
    if (adx.adx < 14) {
      wasMarketSilent = true;
    }
  }

  return {
    curr,
    prev,
    // The key signal: ADX was below threshold, now crossed above
    crossedAbove: prev.adx < threshold && curr.adx >= threshold,
    // Also useful: ADX is above threshold AND still rising
    risingAbove: curr.adx >= threshold && curr.adx > prev.adx,
    // ADX is rising regardless of level
    rising: curr.adx > prev.adx,
    wasMarketSilent,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function batchProcess(items, batchSize, delayMs, fn) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(fn));
    if (i + batchSize < items.length) await sleep(delayMs);
  }
}

// ─── Main ─────────────────────────────────────────────────────
async function checkAdxTrend() {
  const coins = await getTop100ByVolume(20);

  /*
  const coins = [
    {
      symbol: "BTCUSDT",
      lastPrice: 0,
    },
    {
      symbol: "ETHUSDT",
      lastPrice: 0,
    },
    {
      symbol: "BNBUSDT",
      lastPrice: 0,
    },
    {
      symbol: "SOLUSDT",
      lastPrice: 0,
    },
  ];
  */

  await batchProcess(coins, 3, 3000, async (coin) => {
    const symbol = coin.symbol;

    console.log(`Scanning for ${symbol}...`);

    const now = new Date().toLocaleString("en-AU", {
      timeZone: "Australia/Brisbane",
    });

    const candles = await fetchCandles(symbol, INTERVAL, LIMIT);
    const results = calculateADX(candles, LENGTH);
    const check = checkCrossover(results, THRESHOLD);

    if (!check) {
      console.log("Not enough data yet.");
      return;
    }

    const { curr, prev } = check;

    if (check.crossedAbove && check.wasMarketSilent) {
      const iscC = await get(`${symbol}_adx_value`);

      if (!iscC) {
        await sendPushNotif(`3 Minute : ${symbol} ADX above ${THRESHOLD} and rising
        ${curr.diPlus > curr.diMinus ? "🟢 DI+ leading (bullish)" : "🔴 DI- leading (bearish)"}`);
        await set(`${symbol}_adx_value`, JSON.stringify(check), 1800);
      }
    }
  });
  return;
}

module.exports = checkAdxTrend;
