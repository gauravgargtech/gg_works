require("../config/config");
const https = require("https");

const vortexIndicator = require("../indicators/vortex");

const { set, get, del } = require("../adapters/redis");
const { EMA } = require("technicalindicators");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const { fetchCandles, getInstruments } = require("../exhanges/oanda");

const { fetchCandles: candlesFromBybit } = require("../exhanges/bybit_public");

function ema(values, length) {
  const alpha = 2 / (length + 1);
  const out = new Array(values.length).fill(null);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

function doubleSmooth(src, long, short) {
  const firstSmooth = ema(src, long);
  return ema(firstSmooth, short);
}

function computeTSI(closes, long, short, signalLen) {
  // pc = change(close) -> first element has no prior bar, Pine treats it as NaN.
  // We'll set the first pc to 0 so smoothing has a defined seed (Pine's ta.ema
  // effectively ignores leading na values until the first real number appears).
  const pc = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    pc[i] = closes[i] - closes[i - 1];
  }
  const absPc = pc.map(Math.abs);

  const doubleSmoothedPc = doubleSmooth(pc, long, short);
  const doubleSmoothedAbsPc = doubleSmooth(absPc, long, short);

  const tsi = doubleSmoothedPc.map((v, i) => {
    const denom = doubleSmoothedAbsPc[i];
    return denom === 0 ? 0 : (100 * v) / denom;
  });

  const signal = ema(tsi, signalLen);

  return { tsi, signal };
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

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Main ─────────────────────────────────────────────────────
async function vortedAdx() {
  const FOREX_PAIRS_GOODS = ["XAU_USD", "BTC_USD"];
  for (const symbol of FOREX_PAIRS_GOOD) {
    let candles;
    if (symbol === "BTC_USD") {
      candles = await candlesFromBybit("BTCUSDT", 60, 800);
    } else {
      candles = await fetchCandles(symbol, "H1", 800);
    }
    await sleep(1);

    const vortex = vortexIndicator(candles, 14);
    const closes = candles.map((c) => c.close);

    const { tsi, signal } = computeTSI(closes, 22, 10, 13);

    const currentTSI = tsi[tsi.length - 1];
    const currentSignal = signal[signal.length - 1];

    const secondLastTSI = tsi[tsi.length - 2];
    const secondLastSignal = signal[signal.length - 2];
    const redisKey = `tsi_${symbol}_direction`;

    if (currentTSI < currentSignal && secondLastTSI > secondLastSignal) {
      await del(redisKey);

      await del(`vortex_${symbol}_direction`);

      if (currentTSI > 10 && currentSignal > 10) {
        await set(redisKey, "down");
      }
    } else if (currentTSI > currentSignal && secondLastTSI < secondLastSignal) {
      await del(redisKey);
      await del(`vortex_${symbol}_direction`);

      if (currentTSI < 10 && currentSignal < 10) {
        await set(redisKey, "up");
      }
    }

    const isTrendEstablished = await get(redisKey);
    if (!isTrendEstablished) continue;

    const currentVortex = vortex[vortex.length - 1];
    const previousVortex = vortex[vortex.length - 2];
    const thirdVortex = vortex[vortex.length - 3];
    const fourthVortex = vortex[vortex.length - 4];

    const lastCandle = candles[candles.length - 1];

    const adx = calculateADX(candles, 8);
    const currentADX = adx[adx.length - 1];
    const previousADX = adx[adx.length - 2];
    const thirdADX = adx[adx.length - 3];
    const fourthADX = adx[adx.length - 4];

    let currentDirection = "";

    if (
      currentVortex.vip > currentVortex.vim &&
      currentADX.diPlus > currentADX.diMinus &&
      isTrendEstablished === "up"
    ) {
      const isCC = await get(`vortex_${symbol}_direction`);
      if (!isCC) {
        await set(`vortex_${symbol}_direction`, "up", 3600 * 6);
        await sendPushNotif(
          `${symbol} Vortex Detected 1 Hour - Going UP, Bullish`,
        );
      }
    } else if (
      currentVortex.vip < currentVortex.vim &&
      currentADX.diPlus < currentADX.diMinus &&
      isTrendEstablished === "down"
    ) {
      const isCC = await get(`vortex_${symbol}_direction`);
      if (!isCC) {
        await set(`vortex_${symbol}_direction`, "down", 3600 * 6);
        await sendPushNotif(
          `${symbol} Vortex Detected 1 Hour - Going Down, Bearish`,
        );
      }
    }
  }
}

module.exports = vortedAdx;
