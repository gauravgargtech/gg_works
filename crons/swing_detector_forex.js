require("../config/config");

const { fetchCandles } = require("../exhanges/oanda");

const { get, set } = require("../adapters/redis");
const { sendPushNotif } = require("../config/telegram_notify");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const swingDetectorForex = async () => {
  for (const coin of FOREX_PAIRS) {
    await sleep(1000);
    const candles = await fetchCandles(coin, "M3", 3);

    const swingHighs = JSON.parse(await get(`swing_high_${coin}`));
    const swingLows = JSON.parse(await get(`swing_low_${coin}`));

    const latestCandle = candles[candles.length - 1];

    const instrumentDetails = await get(coin);
    const pipSize = instrumentDetails.tickSize;

    const theLow = latestCandle.low - pipSize * 2;
    const theHigh = latestCandle.high + pipSize * 2;

    for (const low of swingLows) {
      if (theHigh >= low.price && theLow <= low.price) {
        const isCC = await get(`swing_low_detected_${coin}`);
        if (!isCC) {
          await set(`swing_low_detected_${coin}`, "ok", 3600 * 4);
          await sendPushNotif(
            `Swing low detected for ${coin} at 1 Day level ${low.price}`,
          );
        }
      }
    }

    for (const high of swingHighs) {
      if (theLow <= high.price && theHigh >= high.price) {
        const isCC = await get(`swing_high_detected_${coin}`);
        if (!isCC) {
          await set(`swing_high_detected_${coin}`, "ok", 3600 * 4);
          await sendPushNotif(
            `Swing high detected for ${coin} at 1 Day level ${high.price}`,
          );
        }
      }
    }
  }
  return;
};

module.exports = swingDetectorForex;
