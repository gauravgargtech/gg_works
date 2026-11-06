require("../config/config");

const { insert } = require("../adapters/mongo");
const { getCurrentPrice } = require("../exhanges/capital_demo");

const RabbitMQ = require("../adapters/rabbitmq");

const dayjs = require("dayjs");

const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const { EMA } = require("technicalindicators");

const { get } = require("../adapters/redis");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const { getCandles } = require("../exhanges/capital");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Signal settings ──────────────────────────────────────────
const EMA_PERIOD = 980;

// Anti-chop filters (same meaning as in the backtest):
const BUFFER_PIPS = 20; // close must be this many pips beyond the EMA (uses your pipSize below)
const CONFIRM_BARS = 5; // ...and stay beyond it for this many consecutive closes
const COOLDOWN_BARS = 2; // minimum candles between two signals for the same symbol

// Only publish a signal if it fired on one of the last N candles (0 = the latest candle only).
const SIGNAL_MAX_AGE_BARS = 0;

// Set to true if getCandles() returns the still-forming candle as the last one
// and you want signals on closed candles only.
const DROP_FORMING_CANDLE = false;

// <FILTER_START>
/**
 * Replays the filtered crossover logic over the candle history and returns every signal.
 * Stateless on purpose: the "last side" and "last signal" are rebuilt from the candles,
 * so a restart or redeploy can't cause duplicate or missed alerts.
 *
 * A signal fires when the last `confirmBars` closes are ALL beyond EMA +/- buffer on the
 * same side, that side differs from the previous signal's side, and the cooldown has passed.
 * Price wandering inside the buffer zone produces nothing.
 */
function findFilteredSignals(
  closes,
  emaAt,
  { period, buffer, confirmBars, cooldownBars },
) {
  const sideAt = (j) => {
    const e = emaAt[j];
    if (j < 0 || e == null) return null;
    if (closes[j] > e + buffer) return "long";
    if (closes[j] < e - buffer) return "short";
    return null;
  };

  // Side price was on before we start scanning, so only a real cross triggers.
  let lastSide = closes[period - 1] > emaAt[period - 1] ? "long" : "short";
  let lastSignalIndex = null;
  const signals = [];

  for (let i = period; i < closes.length; i++) {
    let desired = sideAt(i);
    for (let k = 1; k < confirmBars && desired; k++) {
      if (sideAt(i - k) !== desired) desired = null;
    }

    const cooledDown =
      lastSignalIndex === null || i - lastSignalIndex >= cooldownBars;

    if (desired && desired !== lastSide && cooledDown) {
      lastSide = desired;
      lastSignalIndex = i;
      signals.push({ index: i, side: desired });
    }
  }

  return signals;
}
// <FILTER_END>

// ─── Main ─────────────────────────────────────────────────────
async function forexEma200() {
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
  if (day === 1 && hour < 7) {
    isWeekend = true;
  }

  if (isWeekend) {
    return;
  }

  const rabbit = RabbitMQ.getInstance();

  console.log("--Running Ema980");

  const allSignals = [];
  const values = {};

  const theCrossovers = {};

  for (const symbol of [
    "EUR_USD", // 115
    "USD_CAD", // 122
    "AUD_NZD", // 125
    "NZD_JPY", // 131
    "EUR_JPY", // 141
    "GBP_JPY", // 142
    "NZD_USD", // 165
    "EUR_CHF", // 174
    "CAD_JPY", // 178
    "GBP_USD", // 208
    "GOLD",
    // "EUR_AUD",  // 215
    // "EUR_CAD",  // 238
    //  "AUD_CAD",  // 264
    //  "EUR_GBP"   // 266

    //  "EUR_CHF", // 1
    // "EUR_JPY", // 2
    //  "NZD_JPY", // 6
    //  "GBP_JPY", // 7
    // "AUD_NZD", // 8
    // "NZD_USD", // 10
    // "CAD_JPY", // 13
    // "EUR_USD", // 13
    // "AUD_CAD", // 15
    // "USD_CAD", // 16
    // "EUR_GBP", // 17
    // "GBP_USD", // 18
    // "EUR_AUD", // 18
    // "EUR_CAD", // 18
    //  "AUD_JPY", // 20
    //  "GBP_AUD", // 23
    // "GOLD", // 23
    //"AUD_USD", // 31
    //  "USD_CHF", // 37
    //    "USD_JPY", // 77
  ]) {
    let candles;
    try {
      candles = await getCandles(symbol.replace("_", ""), "1h", 1990);
    } catch (err) {
      console.error(err);
      continue;
    }

    // Need the EMA warm-up plus enough candles for the confirmation window.
    if (candles.length < EMA_PERIOD + CONFIRM_BARS + 10) {
      console.log(`Not enough candles for ${symbol}`);
      continue;
    }

    const currentCandleTime = candles[candles.length - 1].brisbaneTime;

    const candleTime = dayjs.tz(
      currentCandleTime,
      "YYYY-MM-DD HH:mm:ss",
      "Australia/Brisbane",
    );

    const currentTime = dayjs().tz("Australia/Brisbane");

    const differenceInMinutes = currentTime.diff(candleTime, "minute");

    console.log(
      `Current candle time for ${symbol}: ${currentCandleTime}, difference in minutes: ${differenceInMinutes}`,
    );

    if (differenceInMinutes < 14) {
      await sleep(10);
    }

    console.log(`Scanning symbol: ${symbol}`);

    await sleep(2);

    const signalCandles = DROP_FORMING_CANDLE ? candles.slice(0, -1) : candles;
    const theLatestCandle = signalCandles[signalCandles.length - 1];

    let pipSize;
    if (symbol === "GOLD") {
      const theCurrentPrice = await getCurrentPrice(symbol);

      pipSize = 10 ** -theCurrentPrice.pipPosition;
    } else {
      const instrumentDetails = await get(symbol);
      pipSize = instrumentDetails.tickSize;
    }

    const theCandleSize =
      (theLatestCandle.high - theLatestCandle.low) / pipSize;

    const closes = signalCandles.map((c) => c.close);

    // EMA values are shorter than closes: EMA index 0 = candle index EMA_PERIOD - 1.
    // Align them so emaAt[candleIndex] lines up with closes[candleIndex].
    const emaValues = EMA.calculate({ period: EMA_PERIOD, values: closes });
    const emaAt = new Array(closes.length).fill(null);
    emaValues.forEach((v, k) => {
      emaAt[k + EMA_PERIOD - 1] = v;
    });

    const lastIndex = closes.length - 1;
    const latestEma = emaAt[lastIndex];
    const currentClose = closes[lastIndex];

    values[symbol] = latestEma;

    const thePipSizeDiff = Math.abs(currentClose - latestEma) / pipSize;

    // All filtered signals in the history (also used as the "crossover" count).
    const signals = findFilteredSignals(closes, emaAt, {
      period: EMA_PERIOD,
      buffer: BUFFER_PIPS * pipSize,
      confirmBars: CONFIRM_BARS,
      cooldownBars: COOLDOWN_BARS,
    });

    theCrossovers[symbol] = signals.length;

    const latestSignal = signals[signals.length - 1];
    const isFresh =
      latestSignal && latestSignal.index >= lastIndex - SIGNAL_MAX_AGE_BARS;

    if (!isFresh) {
      continue;
    }

    const signalCandle = signalCandles[latestSignal.index];
    const signalPrice = closes[latestSignal.index];

    const currentTimers = dayjs()
      .tz("Australia/Brisbane")
      .format("YYYY-MM-DD HH:mm:ss");

    let onlyClose = false;
    let placeNew = true;

    if (theCandleSize > 35) {
      onlyClose = true;
      placeNew = false;
    }

    if (latestSignal.side === "long") {
      if (placeNew) {
        await sendPushNotif(
          `Ema980 - ${symbol} at 1 Hour - Placing Order, BULLISH,  at ${signalPrice}`,
        );
      }

      allSignals.push({
        direction: "buy",
        symbol: symbol,
        price: signalPrice,
        onlyClose: onlyClose,
        placeNew: placeNew,
        // unique per signal, so the consumer can ignore a redelivered message
        signalId: `${symbol}-buy-${signalCandle.brisbaneTime}`,
      });

      await insert("vortex_forex_hourly", {
        symbol,
        symbol_type: "Forex",
        time: currentTimers,
        timestamp: dayjs().tz("Australia/Brisbane").unix(),
        direction: "up",
        price: signalPrice,
        pipSize: thePipSizeDiff,
      });
    } else {
      if (placeNew) {
        console.log("Capital Orders Subscriber");

        await sendPushNotif(
          `Ema980 - ${symbol} at 1 Hour - Placing Order, BEARISH,  at ${signalPrice}`,
        );
      }

      allSignals.push({
        direction: "sell",
        symbol: symbol,
        price: signalPrice,
        onlyClose: onlyClose,
        placeNew: placeNew,
        signalId: `${symbol}-sell-${signalCandle.brisbaneTime}`,
      });
    }
  }

  if (allSignals.length > 0) {
    for (const signal of allSignals) {
      await sleep(1);
      await rabbit.publish("orders", signal);
    }
  }
}

module.exports = forexEma200;
