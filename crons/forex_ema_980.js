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

const { set, get, del } = require("../adapters/redis");
const calculatePKAMA = require("../indicators/kama");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const { getCandles } = require("../exhanges/capital");

const aiBreakBands = require("../indicators/ai_breakout_bands");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Main ─────────────────────────────────────────────────────
async function forexEma980() {
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

  console.log("--Running Ema80");

  const allSignals = [];
  const values = {};

  for (const symbol of FOREX_PAIRS) {
    let candles;
    try {
      candles = await getCandles(symbol.replace("_", ""), "15m", 4800);
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

    const ema980 = EMA.calculate({ period: 980, values: closes });

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
          `Ema980 - ${symbol} at 1 Hour - Placing Order, BULLISH,  at ${closes[closes.length - 1]}`,
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
          `Ema980 - ${symbol} at 1 Hour - Placing Order, BEARISH,  at ${closes[closes.length - 1]}`,
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
        price: currentClose,
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

module.exports = forexEma980;
