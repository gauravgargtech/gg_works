require("../config/config");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

const { getCandles: fetchCandles } = require("../exhanges/capital");
const { insert } = require("../adapters/mongo");

dayjs.extend(utc);
dayjs.extend(timezone);

const { EMA } = require("technicalindicators");

const { set, get, del } = require("../adapters/redis");

const { mapo } = require("../indicators/mapo_lux");
const { sendPushNotif } = require("../config/telegram_notify");

const { annotateCandles } = require("../indicators/triple_ema");

let INSTRUMENT = process.env.INSTRUMENT || "GOLD";
const CANDLE_COUNT = 1999;

async function main(symbol, theTime) {
  INSTRUMENT = symbol;
  console.log(
    `Fetching ${CANDLE_COUNT} × ${theTime} candles for ${INSTRUMENT}`,
  );

  const candles = await fetchCandles(INSTRUMENT, theTime, CANDLE_COUNT);
  const closes = candles.map((c) => c.close);
  const latestClose = closes[closes.length - 1];

  const signal = annotateCandles(candles);

  if (!signal.signal) {
    return;
  }
  await sendPushNotif(
    `Triple EMA 15 Minutes - ${INSTRUMENT}: Signal is ${signal.signal} at price of ${latestClose} `,
  );

  return;
}

const isWeekender = () => {
  const now = dayjs().tz("Australia/Brisbane");
  const day = now.day(); // 0 Sun - 6 Sat
  const hour = now.hour();

  console.log(`Day is ${day} and hour is ${hour}`);

  let isWeekend = false;
  if (day === 6 && hour >= 4) {
    isWeekend = true;
  }

  if (day === 0) {
    isWeekend = true;
  }
  if (day === 1 && hour < 11) {
    isWeekend = true;
  }
  if (hour > 1 && hour < 8) {
    isWeekend = true;
  }
  return isWeekend;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tripleEmaChecker = async (theTime = "15m") => {
  await sleep(3);

  const isWeekend = isWeekender();
  if (isWeekend) return;

  const allCoins = [
    "GOLD",
    "EUR_USD",
    "GBP_USD",
    "USD_JPY",
    "AUD_USD",
    "USD_CHF",
    "USD_CAD",
    "NZD_USD",
    "EUR_JPY",
    "GBP_JPY",
    "AUD_JPY",
    "CAD_JPY",
    "AUD_CAD",
    "EUR_CHF",
    "AUD_NZD",
    "BTC_USD",
  ];

  for (const coin of allCoins) {
    await sleep(200);
    await main(coin.replace("_", ""), theTime);
  }
};

module.exports = tripleEmaChecker;
