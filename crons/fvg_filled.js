require("../config/config");

const { find } = require("../adapters/mongo");
const { fetchCandles } = require("../exhanges/oanda");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

const { get, set } = require("../adapters/redis");

const { sendPushNotif } = require("../config/telegram_notify");

dayjs.extend(utc);
dayjs.extend(timezone);

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const checkIfFVGFilled = async () => {
  const pairs = await find("fvg_forex_deep", {});

  for (const pair of pairs) {
    console.log(`Scanning for Pair : ${pair.instrument}`);

    const range = pair.gapLow - pair.gapHigh;

    const fib50 = pair.gapHigh + range * 0.5;
    const fib618 = pair.gapHigh + range * 0.65;

    const candles = await fetchCandles(pair.instrument, "M3", 5);

    const fvgType = pair.type;
    let touchPoint;

    const timeDiff = dayjs(candles[candles.length - 1].time).diff(
      pair.time,
      "hours",
    );

    if (timeDiff > 30) {
      continue;
    }

    const isCC = await get(`fvg_forex_deep_${pair.instrument}`);

    if (isCC) {
      continue;
    }

    const latestCandle = candles[candles.length - 1];

    if (
      pair.type === "BEARISH" &&
      latestCandle.high >= fib618 &&
      latestCandle.high <= fib50
    ) {
      await sendPushNotif(
        `FOREX FVG at Level:  ${pair.instrument} filled, check now ${fvgType}, at ${latestCandle.close}`,
      );
      await set(`fvg_forex_deep_${pair.instrument}`, "23", 3600 * 4);
    } else if (
      pair.type.toLowerCase() === "bullish" &&
      latestCandle.low <= fib618 &&
      latestCandle.low >= fib50
    ) {
      await sendPushNotif(
        `FOREX FVG at Level:  ${pair.instrument} filled, check now ${fvgType}, at ${latestCandle.close}`,
      );
      await set(`fvg_forex_deep_${pair.instrument}`, "23", 3600 * 4);
    }
    await sleep(1);
  }

  return true;
};

module.exports = checkIfFVGFilled;
