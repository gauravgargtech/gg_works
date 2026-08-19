require("../config/config");
const https = require("https");

const { set, get, del } = require("../adapters/redis");
const calculatePKAMA = require("../indicators/kama");
const vortexIndicator = require("../indicators/vortex");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { insert } = require("../adapters/mongo");
const { getCandles } = require("../exhanges/capital");

dayjs.extend(utc);
dayjs.extend(timezone);

const { fetchCandles } = require("../exhanges/oanda");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Main ─────────────────────────────────────────────────────
async function forexKamaTouch() {
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

  for (const pair of FOREX_PAIRS_EXT) {
    await sleep(1);

    candles = await getCandles(pair.replace("_", ""), "4h", 800);

    console.log(`Got ${candles.length} candles for ${pair}`);

    //candles = await fetchCandles(pair, "H4", 800);
    const closes = candles.map((c) => c.close);

    const pkama = await calculatePKAMA(closes);
    const latestKama = pkama[pkama.length - 1];
    const previousKama = pkama[pkama.length - 2];

    const vortex = vortexIndicator(candles, 13);
    const currentVortex = vortex[vortex.length - 1];

    const latestCandle = candles[candles.length - 1];
    const latestClose = latestCandle.close;
    const previousClose = candles[candles.length - 2].close;

    const instrumentDetails = await get(pair);
    const pipSize = instrumentDetails.tickSize;

    if (latestClose > latestKama && previousClose < previousKama) {
      await sendPushNotif(
        `${pair} at 4 Hours - Going UP, BULLISH, Kama Only UP at ${closes[closes.length - 1]}`,
      );
      await set(`${pair}_forex_kama_touch_the_direction`, "up");
      await insert("pkama_touch", {
        pair: pair,
        close: latestClose,
        previousClose: previousClose,
        previousKama: previousKama,
        kama: latestKama,
        vortex: currentVortex,
        pipSize: pipSize,
        time: dayjs().tz("Australia/Brisbane").format(),
      });
    } else if (latestClose < latestKama && previousClose > previousKama) {
      await sendPushNotif(
        `${pair} at 4 Hours - Going Down, BEARISH, Kama Only Down at ${closes[closes.length - 1]}`,
      );
      await set(`${pair}_forex_kama_touch_the_direction`, "down");
      await insert("pkama_touch", {
        pair: pair,
        close: latestClose,
        previousClose: previousClose,
        previousKama: previousKama,
        kama: latestKama,
        vortex: currentVortex,
        pipSize: pipSize,
        time: dayjs().tz("Australia/Brisbane").format(),
      });
    }
  }
}

module.exports = forexKamaTouch;
