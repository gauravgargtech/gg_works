require("../config/config");
const https = require("https");
const RabbitMQ = require("../adapters/rabbitmq");

const vortexIndicator = require("../indicators/vortex");
const dayjs = require("dayjs");

const { set, get, del } = require("../adapters/redis");
const { EMA } = require("technicalindicators");
const calculatePKAMA = require("../indicators/kama");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const powerKama = require("../indicators/pkama_old");

const { getCandles } = require("../exhanges/capital");

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

async function xau15Minutes() {
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
    return;
  }
  const allSignals = [];
  console.log("--Running");

  const rabbit = RabbitMQ.getInstance();

  const symbol = "GOLD";
  const candles = await getCandles(symbol, "15m", 1500);
  await sleep(1);

  const closes = candles.map((c) => c.close);

  const newCandles = candles.map((c) => ({
    openTime: dayjs(c.openTime).tz("Australia/Brisbane").valueOf(),
    closeTime: dayjs(c.openTime)
      .add(15, "minutes")
      .tz("Australia/Brisbane")
      .valueOf(),
    time: c.openTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));

  let thePkamaLenght = 150;

  const pkama = await powerKama(newCandles, thePkamaLenght, symbol, 15);

  const currentKama = pkama[pkama.length - 1];
  const previousKama = pkama[pkama.length - 1];

  const latestCandle = candles[candles.length - 1];

  const theCandleSize = latestCandle.high - latestCandle.low;

  if (theCandleSize > 10) {
    console.log(
      `Latest candle size is too large: ${theCandleSize} pips. Skipping XAU order.`,
    );
  }
  const previousClose = candles[candles.length - 2].close;

  const currentClose = latestCandle.close;
  const latestClose = latestCandle.close;

  const tsi = computeTSI(closes, 100, 50, 13);

  const latestTsi = tsi.tsi[tsi.tsi.length - 1];
  const previousTsi = tsi.tsi[tsi.tsi.length - 2];

  if (currentClose > currentKama) {
    let onlyClose = false;
    let placeNew = true;

    if (previousTsi < 0 && latestTsi > 0) {
      if (theCandleSize > 30) {
        onlyClose = true;
        placeNew = false;
      }
      if (placeNew) {
        await sendPushNotif(
          `${symbol} at 15 Minute - Placing Order, BULLISH,  at ${closes[closes.length - 1]}`,
        );
      } else {
        await sendPushNotif(
          `${symbol} at 15 Minute - Closing Order, BULLISH,  at ${closes[closes.length - 1]}`,
        );
      }
      allSignals.push({
        direction: "buy",
        symbol: symbol,
        price: currentClose,
        onlyClose: onlyClose,
        placeNew: placeNew,
      });
    } else if (previousTsi > 0 && latestTsi < 0) {
      onlyClose = true;
      placeNew = false;

      await sendPushNotif(
        `${symbol} at 15 Minute - Closing Order, BULLISH,  at ${closes[closes.length - 1]}`,
      );
      allSignals.push({
        direction: "buy",
        symbol: symbol,
        price: currentClose,
        onlyClose: onlyClose,
        placeNew: placeNew,
      });
    }
  } else if (currentClose < currentKama) {
    let onlyClose = false;
    let placeNew = true;

    if (previousTsi > 0 && latestTsi < 0) {
      if (theCandleSize > 30) {
        onlyClose = true;
        placeNew = false;
      }
      if (placeNew) {
        await sendPushNotif(
          `${symbol} at 15 Minute - Placing Order, BULLISH,  at ${closes[closes.length - 1]}`,
        );
      } else {
        await sendPushNotif(
          `${symbol} at 15 Minute - Closing Order, BULLISH,  at ${closes[closes.length - 1]}`,
        );
      }
      allSignals.push({
        direction: "sell",
        symbol: symbol,
        price: currentClose,
        onlyClose: onlyClose,
        placeNew: placeNew,
      });
    } else if (previousTsi < 0 && latestTsi > 0) {
      onlyClose = true;
      placeNew = false;

      await sendPushNotif(
        `${symbol} at 15 Minute - Closing Order, BULLISH,  at ${closes[closes.length - 1]}`,
      );
      allSignals.push({
        direction: "sell",
        symbol: symbol,
        price: currentClose,
        onlyClose: onlyClose,
        placeNew: placeNew,
      });
    }
  }

  if (allSignals.length > 0) {
    for (const signal of allSignals) {
      await sleep(1);
      //await rabbit.publish("orders", signal);
    }
  }
}

module.exports = xau15Minutes;
