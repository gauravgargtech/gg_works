require("../config/config");

const { insert } = require("../adapters/mongo");
const { getCurrentPrice } = require("../exhanges/capital_demo");

const RabbitMQ = require("../adapters/rabbitmq");

const dayjs = require("dayjs");

const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const calculateAdaptiveTrendline = require("../indicators/trendline_adaptive");

dayjs.extend(utc);
dayjs.extend(timezone);

const { EMA } = require("technicalindicators");

const { get } = require("../adapters/redis");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const { getCandles } = require("../exhanges/capital");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Main ─────────────────────────────────────────────────────
async function forexAdaptiveTrendline() {
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

  const allSignals = [];
  const values = {};

  for (const symbol of [
    "AUD_USD",
    "GOLD",
    "USD_CAD",
    "USD_JPY",
    "USD_CHF",
    "USD_CAD",
    "NZD_USD",
    "EUR_USD",
    "GBP_USD",
  ]) {
    let candles;
    try {
      candles = await getCandles(symbol.replace("_", ""), "1h", 1980);
    } catch (err) {
      console.error(err);
      continue;
    }

    if (candles.length < 900) {
      console.log(`Not enough candles for ${symbol}`);
      continue;
    }

    const trend = calculateAdaptiveTrendline(candles, {
      periodMode: true,
      devMultiplier: 2,
      timeframe: "1h",
      symbolType: "forex",
    });

    const upperLevel = trend.upperEndPrice;
    const lowerLevel = trend.lowerEndPrice;

    const currentHigh = candles[candles.length - 1].high;
    const currentLow = candles[candles.length - 1].low;

    console.log(`Scanning symbol: ${symbol}`);

    await sleep(2);

    if (currentHigh > lowerLevel && currentLow < lowerLevel) {
      await sendPushNotif(
        `Adaptive Trend - ${symbol} at 1 Hour - Check Manually`,
      );
    } else if (currentHigh > upperLevel && currentLow < upperLevel) {
      await sendPushNotif(
        `Adaptive Trend - ${symbol} at 1 Hour - Check Manually`,
      );
    }
  }
}

module.exports = forexAdaptiveTrendline;
