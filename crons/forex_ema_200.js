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

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Counts how many times price flipped side of the EMA (bull + bear combined)
function countCrossovers(candles, period = 980, warmup = period * 2) {
  const closes = candles.map((c) => Number(c.close));
  const e = ema(closes, period);

  let count = 0;
  let lastSide = 0; // 1 = above, -1 = below

  for (let i = warmup; i < closes.length; i++) {
    const diff = closes[i] - e[i];
    const side = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    if (side === 0) continue; // exactly on EMA, keep previous side

    if (lastSide !== 0 && side !== lastSide) count++;
    lastSide = side;
  }
  return count;
}

// Usage: candlesBySymbol = { BTCUSDT: [...], ETHUSDT: [...], ... }
function rankPairs(candlesBySymbol, period = 980) {
  const results = Object.entries(candlesBySymbol).map(([symbol, candles]) => ({
    symbol,
    candles: candles.length,
    crossovers: countCrossovers(candles, period),
  }));

  return results.sort((a, b) => a.crossovers - b.crossovers); // fewest first
}

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

  console.log("--Running Ema200");

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
    //    "EUR_AUD", // 215
    //  "EUR_CAD", // 238
    //  "AUD_CAD", // 264
    //  "EUR_GBP", // 266

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
    //    "AUD_USD", // 31
    //  "USD_CHF", // 37
    //"USD_JPY", // 77
  ]) {
    let candles;
    try {
      candles = await getCandles(symbol.replace("_", ""), "1h", 9990);
    } catch (err) {
      console.error(err);
      continue;
    }

    if (candles.length < 900) {
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

    const theLatestCandle = candles[candles.length - 1];

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

    const closes = candles.map((c) => c.close);

    //const ema980 = EMA.calculate({ period: 980, values: closes });

    const emaPeriod = 980;
    const ema980 = EMA.calculate({
      period: emaPeriod,
      values: closes,
    });

    const theCrosses = countCrossovers(candles, emaPeriod);
    theCrossovers[symbol] = theCrosses;

    const latestEma980 = ema980[ema980.length - 1];
    const previousEma980 = ema980[ema980.length - 2];

    values[symbol] = latestEma980;

    const currentClose = closes[closes.length - 1];
    const previousClose = closes[closes.length - 2];

    const thePipSizeDiff = Math.abs(currentClose - latestEma980) / pipSize;

    const currentTimers = dayjs()
      .tz("Australia/Brisbane")
      .format("YYYY-MM-DD HH:mm:ss");

    if (previousClose < previousEma980 && currentClose > latestEma980) {
      let onlyClose = false;
      let placeNew = true;

      if (theCandleSize > 35) {
        onlyClose = true;
        placeNew = false;
      }

      if (placeNew) {
        await sendPushNotif(
          `Ema200 - ${symbol} at 15 Minutes - Placing Order, BULLISH,  at ${closes[closes.length - 1]}`,
        );
      }

      allSignals.push({
        direction: "buy",
        symbol: symbol,
        price: currentClose,
        onlyClose: onlyClose,
        placeNew: placeNew,
      });

      await insert("vortex_forex_hourly", {
        symbol,
        symbol_type: "Forex",
        time: currentTimers,
        timestamp: dayjs().tz("Australia/Brisbane").unix(),
        direction: "up",
        price: currentClose,
        pipSize: thePipSizeDiff,
      });
    } else if (previousClose > previousEma980 && currentClose < latestEma980) {
      let onlyClose = false;
      let placeNew = true;

      if (theCandleSize > 35) {
        onlyClose = true;
        placeNew = false;
      }

      if (placeNew) {
        console.log("Capital Orders Subscriber");

        await sendPushNotif(
          `Ema200 - ${symbol} at 15 Minutes - Placing Order, BEARISH,  at ${closes[closes.length - 1]}`,
        );
      }

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
      await rabbit.publish("orders", signal);
    }
  }
}

module.exports = forexEma200;
