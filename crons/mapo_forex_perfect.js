require("../config/config");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

const { getCandles: fetchCandles } = require("../exhanges/capital");

dayjs.extend(utc);
dayjs.extend(timezone);

const { EMA } = require("technicalindicators");

const { set, get, del } = require("../adapters/redis");

const { mapo } = require("../indicators/mapo_lux");
const { sendPushNotif } = require("../config/telegram_notify");

let INSTRUMENT = process.env.INSTRUMENT || "GOLD";
const CANDLE_COUNT = 4000;

async function main(symbol, theTime) {
  INSTRUMENT = symbol;
  console.log(
    `Fetching ${CANDLE_COUNT} × ${theTime} candles for ${INSTRUMENT}`,
  );

  const candles = await fetchCandles(INSTRUMENT, theTime, CANDLE_COUNT);
  console.log(`Got ${candles.length} complete candles.`);
  const closes = candles.map((c) => c.close);
  const latestClose = closes[closes.length - 1];

  const results = mapo(closes);

  const latestMapo = results.series[results.series.length - 1];
  const previousMapo = results.series[results.series.length - 2];

  if (latestMapo.bias !== previousMapo.bias) {
    await set(`mapo_forex_perfect_for_is_d_${INSTRUMENT}`, latestMapo.bias);
  }

  let isShiftDetected = false;
  const isRedisBias = await get(`mapo_forex_perfect_for_is_d_${INSTRUMENT}`);

  if (latestMapo.proximity <= 6 && previousMapo.proximity > 6 && isRedisBias) {
    isShiftDetected = true;
    await del(`mapo_forex_perfect_for_is_d_${INSTRUMENT}`);
  }

  const ema200 = EMA.calculate({ period: 200, values: closes });

  const latestEma200 = ema200[ema200.length - 1];

  let emaBias = "";
  if (latestClose > latestEma200) {
    emaBias = "bull";
  } else if (latestClose < latestEma200) {
    emaBias = "bear";
  }

  if (isShiftDetected && emaBias === isRedisBias) {
    await sendPushNotif(
      `MAPO GOLD PERFECT 15 Minute - ${INSTRUMENT}: Signal is ${latestMapo.bias} with proximity ${latestMapo.proximity} `,
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

const theForexPerfectMapo = async (theTime = "15m") => {
  await sleep(3);

  const isWeekend = isWeekender();
  if (isWeekend) return;

  const allCoins = ["GOLD"];

  for (const coin of allCoins) {
    await sleep(200);
    await main(coin, theTime);
  }
};

module.exports = theForexPerfectMapo;
