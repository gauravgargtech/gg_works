require("../config/config");
const https = require("https");

const vortexIndicator = require("../indicators/vortex");
const dayjs = require("dayjs");

const { set, get, del } = require("../adapters/redis");
const { EMA } = require("technicalindicators");
const calculatePKAMA = require("../indicators/kama");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const aiBreakBands = require("../indicators/ai_breakout_bands");

const getChoppinessIndex = require("../indicators/choppiness_index");

const {
  getInstruments,
  placeOrder,
  closePositions,
  getPositions,
} = require("../exhanges/oanda_demo");

const { fetchCandles } = require("../exhanges/oanda");

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
async function autoForexOrder() {
  const now = dayjs().tz("Australia/Brisbane");
  const day = now.day(); // 0 Sun - 6 Sat
  const hour = now.hour();

  let isWeekend = false;
  // Saturday after 4am
  if (day === 6 && hour >= 4) {
    isWeekend = true;
  }

  // Sunday full day
  if (day === 0) {
    isWeekend = true;
  }

  // Monday before 4am
  if (day === 1 && hour < 9) {
    isWeekend = true;
  }

  if (isWeekend) {
    //return;
  }

  console.log("--Running auto fixex");

  for (const symbol of FOREX_PAIRS) {
    const candles = await fetchCandles(symbol, "H1", 800);
    await sleep(1);

    const closes = candles.map((c) => c.close);

    const bands = await aiBreakBands(symbol, candles);

    const latestBand = bands[bands.length - 1];

    const previousBand = bands[bands.length - 2];

    const latestBandSmooth = latestBand.smoothed;
    const previousBandSmooth = previousBand.smoothed;

    const latestClose = closes[closes.length - 1];
    const previousClose = closes[closes.length - 2];

    const instrumentDetails = await get(symbol);
    const pipSize = instrumentDetails.tickSize;

    if (previousClose < previousBandSmooth && latestClose > latestBandSmooth) {
      const positions = await getPositions(symbol);
      if (positions.length > 0) {
        await closePositions(positions, symbol);
      }
      await placeOrder(
        "buy",
        symbol,
        700,
        latestClose.toFixed(5) + pipSize * 120,
      );
    } else if (
      previousClose > previousBandSmooth &&
      latestClose < latestBandSmooth
    ) {
      const positions = await getPositions(symbol);
      if (positions.length > 0) {
        await closePositions(positions, symbol);
      }
      await placeOrder(
        "short",
        symbol,
        700,
        latestClose.toFixed(5) - pipSize * 120,
      );
      /*
      await sendPushNotif(
        `${symbol} BEARISH - Order Placed Demo at 15 minutes - at ${closes[closes.length - 1]}`,
      );
      */
    }
  }
}

module.exports = autoForexOrder;
