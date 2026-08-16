require("../config/config");
const https = require("https");

const { set, get, del } = require("../adapters/redis");
const calculatePKAMA = require("../indicators/kama");
const vortexIndicator = require("../indicators/vortex");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");
const aiBreakBands = require("../indicators/ai_breakout_bands");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { insert } = require("../adapters/mongo");
const { computeTSI } = require("../indicators/tsi");

dayjs.extend(utc);
dayjs.extend(timezone);

const { fetchCandles } = require("../exhanges/oanda");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Main ─────────────────────────────────────────────────────
async function forexKamaMulti() {
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
    const symbol = pair;

    candles = await fetchCandles(pair, "H4", 800);
    const closes = candles.map((c) => c.close);

    const pkama = calculatePKAMA(closes);
    const latestKama = pkama[pkama.length - 1];
    const previousKama = pkama[pkama.length - 2];

    const latestCandle = candles[candles.length - 1];
    const latestClose = latestCandle.close;
    const previousClose = candles[candles.length - 2].close;

    const instrumentDetails = await get(pair);
    const pipSize = instrumentDetails.tickSize;
    let direction = "";

    if (latestClose > latestKama) {
      direction = "up";
    } else if (latestClose < latestKama) {
      direction = "down";
    }

    const candlesAt15 = await fetchCandles(pair, "M15", 800);
    const candlesAt15Closes = candlesAt15.map((c) => c.close);

    const latestCloseAt15 = candlesAt15Closes[candlesAt15Closes.length - 1];

    const pkamaAt15 = calculatePKAMA(candlesAt15Closes);

    const bandsAt15 = await aiBreakBands(symbol, candlesAt15);

    const latestBand = bandsAt15[bandsAt15.length - 1];

    const theDiff = Math.abs(latestCloseAt15 - pkamaAt15[pkamaAt15.length - 1]);
    const thePipDiffBands = theDiff / pipSize;

    const vortex = vortexIndicator(candles, 13);

    const tsiResult = computeTSI(candlesAt15Closes, 22, 10, 13);

    const latestSignal = tsiResult.signal[tsiResult.signal.length - 1];
    const latestTsi = tsiResult.tsi[tsiResult.tsi.length - 1];

    if (
      direction === "up" &&
      latestCloseAt15 > pkamaAt15[pkamaAt15.length - 1] &&
      latestTsi > latestSignal &&
      latestTsi > 0 &&
      latestCloseAt15 > latestBand.smoothed &&
      thePipDiffBands < 8
    ) {
      const isCC = await get(`${pair}_forex_kama_touch_the_direction_lets_see`);
      if (!isCC) {
        await set(
          `${pair}_forex_kama_touch_the_direction_lets_see`,
          "up",
          3600 * 2,
        );
        await sendPushNotif(
          `${pair} at 15 Minutes - Going UP, BULLISH, Kama Only Up at ${latestCloseAt15}`,
        );
      }
    } else if (
      direction === "down" &&
      latestCloseAt15 < pkamaAt15[pkamaAt15.length - 1] &&
      latestSignal > latestTsi &&
      latestSignal < 0 &&
      latestCloseAt15 < latestBand.smoothed &&
      thePipDiffBands < 8
    ) {
      const isCC = await get(
        `${pair}_forex_kama_touch_the_direction_lets_see`,
        "down",
      );
      if (!isCC) {
        await set(
          `${pair}_forex_kama_touch_the_direction_lets_see`,
          "down",
          3600 * 2,
        );
        await sendPushNotif(
          `${pair} at 15 Minutes - Going DOWN, BEARISH, Kama Only Down at ${latestCloseAt15}`,
        );
      }
    }
  }
}

module.exports = forexKamaMulti;
