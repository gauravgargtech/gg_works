require("../config/config");

const { insert } = require("../adapters/mongo");
const { getCurrentPrice } = require("../exhanges/capital_demo");

const RabbitMQ = require("../adapters/rabbitmq");

const dayjs = require("dayjs");

const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

const timeframe = 15;

dayjs.extend(utc);
dayjs.extend(timezone);

const powerKama = require("../indicators/pkama_old");

const { set, get, del } = require("../adapters/redis");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const { getCandles } = require("../exhanges/capital");

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
  if (day === 1 && hour < 7) {
    isWeekend = true;
  }

  if (isWeekend) {
    return;
  }

  const rabbit = RabbitMQ.getInstance();

  console.log("--Running auto fixex");

  const allSignals = [];

  for (const symbol of FOREX_PAIRS) {
    let candles;
    try {
      candles = await getCandles(
        symbol.replace("_", ""),
        `${timeframe}m`,
        1990,
      );
    } catch (err) {
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

    const newCandles = candles.map((c) => ({
      openTime: dayjs(c.openTime).tz("Australia/Brisbane").valueOf(),
      closeTime: dayjs(c.openTime)
        .add(timeframe, "minutes")
        .tz("Australia/Brisbane")
        .valueOf(),
      time: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    let thePkamaLenght = 100;

    if (symbol === "GOLD") {
      thePkamaLenght = 200;
    }

    const pkama = await powerKama(
      newCandles,
      thePkamaLenght,
      symbol,
      timeframe,
    );

    console.log(`Latest Kama is - ${pkama[pkama.length - 1]}`);

    const currentKama = pkama[pkama.length - 1];
    const previousKama = pkama[pkama.length - 2];

    const currentClose = closes[closes.length - 1];
    const previousClose = closes[closes.length - 2];

    const latestClose = closes[closes.length - 1];

    const thePipSizeDiff = Math.abs(currentClose - currentKama) / pipSize;

    const currentTimers = dayjs()
      .tz("Australia/Brisbane")
      .format("YYYY-MM-DD HH:mm:ss");

    if (previousClose < previousKama && currentClose > currentKama) {
      await set(`new_gg_works_direction_for${symbol}`, "buy");
      let onlyClose = false;
      let placeNew = true;

      if (theCandleSize > 25) {
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

      await insert("vortex_forex_hourly", {
        symbol,
        symbol_type: "Forex",
        time: currentTimers,
        timestamp: dayjs().tz("Australia/Brisbane").unix(),
        direction: "up",
        price: latestClose,
        pipSize: thePipSizeDiff,
      });
    } else if (previousClose > previousKama && currentClose < currentKama) {
      await set(`new_gg_works_direction_for${symbol}`, "sell");

      let onlyClose = false;
      let placeNew = true;

      if (theCandleSize > 25) {
        onlyClose = true;
        placeNew = false;
      }

      if (placeNew) {
        console.log("Capital Orders Subscriber");

        await sendPushNotif(
          `${symbol} at 15 Minute - Placing Order, BEARISH,  at ${closes[closes.length - 1]}`,
        );
      } else {
        await sendPushNotif(
          `${symbol} at 15 Minute - Closing Order, BEARISH,  at ${closes[closes.length - 1]}`,
        );
      }

      allSignals.push({
        direction: "sell",
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
        direction: "down",
        price: latestClose,
        pipSize: thePipSizeDiff,
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

module.exports = autoForexOrder;
