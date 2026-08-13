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

  for (const pair of FOREX_PAIRS) {
    await sleep(1);

    candles = await fetchCandles(pair, "H4", 800);
    const closes = candles.map((c) => c.close);

    const pkama = calculatePKAMA(closes);
    const latestKama = pkama[pkama.length - 1];

    const vortex = vortexIndicator(candles, 13);
    const currentVortex = vortex[vortex.length - 1];

    const latestCandle = candles[candles.length - 1];
    const latestClose = latestCandle.close;

    const instrumentDetails = await get(pair);
    const pipSize = instrumentDetails.tickSize;

    const theCandleSize = (latestCandle.high - latestCandle.low) / pipSize;

    if (theCandleSize > 40) {
      console.log(
        `Latest candle size is too large: ${theCandleSize} pips. Skipping XAU order.`,
      );
      continue; // Skip this symbol if the latest candle is too large
    }

    const differenceFromKama = Math.abs(latestClose - latestKama) / pipSize;

    if (differenceFromKama > 40) {
      console.log(
        `Too far from Kama: ${differenceFromKama} pips. Skipping XAU order.`,
      );
      continue; // Skip this symbol if the latest candle is too large
    }

    if (currentVortex.vip > currentVortex.vim && latestClose > latestKama) {
      await sendPushNotif(
        `${pair} at 4 Hours - Going UP, BULLISH, Kama + Vortex UP at ${closes[closes.length - 1]}`,
      );
    } else if (
      currentVortex.vip < currentVortex.vim &&
      latestClose < latestKama
    ) {
      await sendPushNotif(
        `${pair} at 4 Hours - Going Down, BEARISH, Kama + Vortex Down at ${closes[closes.length - 1]}`,
      );
    }
  }
}

module.exports = forexKamaTouch;
