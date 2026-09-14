require("../config/config");

const { insert } = require("../adapters/mongo");
const { getCurrentPrice } = require("../exhanges/capital_demo");

const RabbitMQ = require("../adapters/rabbitmq");

const dayjs = require("dayjs");

const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const { set, get, del } = require("../adapters/redis");
const calculatePKAMA = require("../indicators/kama");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const { getCandles } = require("../exhanges/capital");

const aiBreakBands = require("../indicators/ai_breakout_bands");

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
      candles = await getCandles(symbol.replace("_", ""), "15m", 999);
    } catch (err) {
      continue;
    }

    if (candles.length < 900) {
      console.log(`Not enough candles for ${symbol}`);
      continue;
    }

    const currentCandleTime = candles[candles.length - 1].brisbaneTime;

    const timess = dayjs(currentCandleTime);
    const differenceInMinutes = dayjs().diff(timess, "minute");

    console.log(
      `Current candle time for ${symbol}: ${currentCandleTime}, difference in minutes: ${differenceInMinutes}`,
    );

    if (differenceInMinutes < 14 || differenceInMinutes > 20) {
      continue;
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

    let thePkamaLenght = 100;

    if (symbol === "GOLD") {
      thePkamaLenght = 200;
    }

    const pkama = await calculatePKAMA(newCandles, thePkamaLenght);

    const currentKama = pkama[pkama.length - 1];
    const previousKama = pkama[pkama.length - 2];

    const currentClose = closes[closes.length - 1];
    const previousClose = closes[closes.length - 2];

    const latestClose = closes[closes.length - 1];

    const thePipSizeDiff = Math.abs(currentClose - currentKama) / pipSize;

    const currentTimers = dayjs()
      .tz("Australia/Brisbane")
      .format("YYYY-MM-DD HH:mm:ss");

    if (
      previousClose < previousKama &&
      currentClose > currentKama // It means current price is greater than Pkama
      //previousClose < previousBand &&
      //currentClose > currentBand

      //latestClose > latestBandSmooth &&
      //latestTsi > latestSignal &&
      //latestSignal < 0 &&
      //latestVortex.vip > latestVortex.vim &&
      //latestVortex.vip >= 1.1 &&
      //latestVortex.vim <= 0.9
    ) {
      await set(`new_gg_works_direction_for${symbol}`, "buy");
      let onlyClose = false;
      let placeNew = true;

      if (theCandleSize > 25) {
        onlyClose = true;
        placeNew = false;
      }

      if (placeNew) {
        await sendPushNotif(
          `${symbol} at 1 Hour - Placing Order, BULLISH,  at ${closes[closes.length - 1]}`,
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
    } else if (
      previousClose > previousKama &&
      currentClose < currentKama
      //previousClose > previousBand &&
      //currentClose < currentBand

      //latestClose < latestBandSmooth &&
      //latestTsi < latestSignal &&
      //latestSignal > 0 &&
      //latestVortex.vip < latestVortex.vim &&
      //latestVortex.vim >= 1.1 &&
      //latestVortex.vip <= 0.9
    ) {
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
          `${symbol} at 1 Hour - Placing Order, BEARISH,  at ${closes[closes.length - 1]}`,
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
