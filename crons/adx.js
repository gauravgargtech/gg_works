require("../config/config");

const { set, get } = require("../adapters/redis");

const { sendPushNotif } = require("../config/telegram_notify");

const axios = require("axios");

const SYMBOL = "BTCUSDT";
const INTERVAL = "15"; // 15-minute candles
const LENGTH = 10; // ADX length (from your Pine Script param)
const THRESHOLD = 20; // the level we watch for crossover
const LIMIT = 200; // enough candles for warm-up + stable ADX

// ─── Fetch candles from Bybit ─────────────────────────────────
async function fetchCandles(symbol, interval, limit) {
  const { data } = await axios.get("https://api.bybit.com/v5/market/kline", {
    params: { category: "linear", symbol, interval, limit },
  });

  if (data.retCode !== 0) throw new Error(`Bybit error: ${data.retMsg}`);

  // Bybit returns newest first — reverse so index 0 = oldest candle
  return [...data.result.list].reverse().map((k) => ({
    time: new Date(parseInt(k[0])).toLocaleString("en-AU", {
      timeZone: "Australia/Brisbane",
    }),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));
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

  return {
    curr,
    prev,
    // The key signal: ADX was below threshold, now crossed above
    crossedAbove: prev.adx < threshold && curr.adx >= threshold,
    // Also useful: ADX is above threshold AND still rising
    risingAbove: curr.adx >= threshold && curr.adx > prev.adx,
    // ADX is rising regardless of level
    rising: curr.adx > prev.adx,
  };
}

async function getTop100ByVolume() {
  const cached = await get("TOP_COINS_CACHE_BYBIT");
  if (cached) return JSON.parse(cached);

  const url = `${BASE_URL}/v5/market/tickers?category=linear`;
  const data = await fetchJSON(url);

  const MIN_VOLUME_USDT = 10_000_000; // $50M daily turnover
  const MIN_PRICE_USDT = 0.01; // drop sub-cent tokens
  const MIN_MARKET_CAP = 100_000_000; // $100M (needs extra call, see below)

  if (data.retCode !== 0) throw new Error(`Bybit error: ${data.retMsg}`);

  const tickers = data.result.list
    // Only USDT-settled perpetuals (e.g. BTCUSDT), skip inverse / spot
    .filter((t) => t.symbol.endsWith("USDT") && parseFloat(t.turnover24h) > 0)
    // Sort descending by 24h quote volume (turnover24h is in USDT)
    .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
    .filter((t) => t.symbol.endsWith("USDT") && parseFloat(t.turnover24h) > 0)
    .filter((t) => parseFloat(t.turnover24h) >= MIN_VOLUME_USDT)
    .filter((t) => parseFloat(t.lastPrice) >= MIN_PRICE_USDT)
    .slice(0, 300)
    .map((t) => ({
      symbol: t.symbol,
      lastPrice: parseFloat(t.lastPrice),
      volume24h: parseFloat(t.turnover24h),
    }));

  await set("TOP_COINS_CACHE_BYBIT", JSON.stringify(tickers), 3600); // cache 5 min

  return tickers;
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
  const coins = await getTop100ByVolume();

  await batchProcess(coins, 5, 3000, async (coin) => {
    const symbol = coin.symbol;

    const now = new Date().toLocaleString("en-AU", {
      timeZone: "Australia/Brisbane",
    });
    console.log(`\n${"═".repeat(52)}`);
    console.log(` ADX SCANNER  |  ${SYMBOL}  |  ${INTERVAL}m  |  ${now}`);
    console.log(`${"═".repeat(52)}`);

    const candles = await fetchCandles(symbol, INTERVAL, LIMIT);
    const results = calculateADX(candles, LENGTH);
    const check = checkCrossover(results, THRESHOLD);

    if (!check) {
      console.log("Not enough data yet.");
      return;
    }

    const { curr, prev } = check;

    if (check.risingAbove) {
      const iscC = await get(`${symbol}_adx_value`);

      if (!iscC) {
        await sendPushNotif(`
        ADX above ${THRESHOLD} and rising for Symbol ${symbol}
        ${curr.diPlus > curr.diMinus ? "🟢 DI+ leading (bullish)" : "🔴 DI- leading (bearish)"}
        `);
        await set(`${symbol}_adx_value`, JSON.stringify(check), 3600);
      }
    }

    console.log(`${"─".repeat(52)}`);
  });
}

module.exports = checkAdxTrend;
