require("../config/config");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

const { getCandles: fetchCandles } = require("../exhanges/capital");

dayjs.extend(utc);
dayjs.extend(timezone);

const { SMA } = require("technicalindicators");

const { sendPushNotif } = require("../config/telegram_notify");

let INSTRUMENT = process.env.INSTRUMENT || "GOLD";
const CANDLE_COUNT = 980;

async function main(symbol, theTime) {
  INSTRUMENT = symbol;
  console.log(
    `Fetching ${CANDLE_COUNT} × ${theTime} candles for ${INSTRUMENT}`,
  );

  const candles = await fetchCandles(INSTRUMENT, theTime, CANDLE_COUNT);
  console.log(`Got ${candles.length} complete candles.`);
  const closes = candles.map((c) => c.close);

  const ema200 = SMA.calculate({ period: 50, values: closes });

  const latestEma200 = ema200[ema200.length - 1];
  const previousEma200 = ema200[ema200.length - 2];

  const latestClose = closes[closes.length - 1];
  const previousClose = closes[closes.length - 2];

  if (previousEma200 > previousClose && latestEma200 < latestClose) {
    await sendPushNotif(
      `SMA 200 at 4 Hours for - ${INSTRUMENT}: Signal is BEAR at price of ${latestClose} `,
    );
  } else if (previousEma200 < previousClose && latestEma200 > latestClose) {
    await sendPushNotif(
      `SMA 200 at 4 Hours for - ${INSTRUMENT}: Signal is BULL at price of ${latestClose} `,
    );
  }

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

const forexSma200 = async (theTime = "4h") => {
  await sleep(3);

  const isWeekend = isWeekender();
  if (isWeekend) return;

  const allCoins = ["AUD_USD", "USD_CAD", "NZD_USD", "EUR_CHF"];

  for (const coin of allCoins) {
    await sleep(200);
    await main(coin.replace("_", ""), theTime);
  }
  return;
};

module.exports = forexSma200;
