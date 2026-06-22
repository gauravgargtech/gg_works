require("../config/config");

const { find } = require("../adapters/mongo");
const { fetchCandles } = require("../exhanges/oanda");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

const { sendPushNotif } = require("../config/telegram_notify");

dayjs.extend(utc);
dayjs.extend(timezone);

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const checkIfFVGFilled = async () => {
  const pairs = await find("fvg_forex_deep", {});

  for (const pair of pairs) {
    console.log(`Scanning for Pair : ${pair.pair}`);

    const candles = await fetchCandles(pair.pair, "M5", 10);

    const fvgType = pair.type;
    let touchPoint;

    if (fvgType.toLowerCase() === "bullish") {
      touchPoint =
        candles[candles.length - 1].low + candles[candles.length - 1].low / 70;
    } else {
      touchPoint =
        candles[candles.length - 1].high -
        candles[candles.length - 1].high / 70;
    }
    const timeDiff = dayjs(candles[candles.length - 1].time).diff(
      pair.time,
      "hours",
    );

    if (timeDiff > 150) {
      continue;
    }

    if (fvgType.toLowerCase() === "bullish" && pair.entry <= touchPoint) {
      await sendPushNotif(
        `FOREX FVG:  ${pair.pair} filled, check now ${fvgType}, at ${pair.entry}`,
      );
    } else if (
      fvgType.toLowerCase() === "bearish" &&
      pair.entry >= touchPoint
    ) {
      await sendPushNotif(
        `FOREX FVG:  ${pair.pair} filled, check now ${fvgType}, at ${pair.entry}`,
      );
    }
    await sleep(1);
  }

  return true;
};

module.exports = checkIfFVGFilled;
