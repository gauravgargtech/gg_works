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

const checkIsEntryIsReady = async (pair, isRedisReady) => {
  const candles = await fetchCandles(pair, "H1", 800);
  const closes = candles.map((c) => c.close);

  const pkama = calculatePKAMA(closes);

  const vortex = vortexIndicator(candles, 13);

  const currentVortex = vortex[vortex.length - 1];
  const secondLastVortex = vortex[vortex.length - 2];

  if (
    isRedisReady === "up" &&
    currentVortex.vip > currentVortex.vim &&
    secondLastVortex.vip < secondLastVortex.vim
  ) {
    const isCC = await get(`kama_touched_by_okokok_${pair}`);
    if (!isCC) {
      await set(`kama_touched_by_okokok_${pair}`, "up", 3600 * 12);

      await sendPushNotif(
        `${pair} is ready - KAMA TOUCH 4 Hours + Ready at 1 Hour - UP`,
      );
    }
  } else if (
    isRedisReady === "down" &&
    currentVortex.vip < currentVortex.vim &&
    secondLastVortex.vip > secondLastVortex.vim
  ) {
    const isCC = await get(`kama_touched_by_okokok_${pair}`);
    if (!isCC) {
      await set(`kama_touched_by_okokok_${pair}`, "down", 3600 * 12);

      await sendPushNotif(
        `${pair} is ready - KAMA TOUCH 4 Hours + Ready at 1 Hour - DOWN`,
      );
    }
  }
};

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Main ─────────────────────────────────────────────────────
async function forexKamaTouch() {
  await sleep(10);

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
    await sleep(2);

    candles = await fetchCandles(pair, "H4", 800);
    const closes = candles.map((c) => c.close);

    const pkama = calculatePKAMA(closes);

    const vortex = vortexIndicator(candles, 13);

    const currentVortex = vortex[vortex.length - 1];
    const secondLastVortex = vortex[vortex.length - 2];

    const latestpKama = pkama[pkama.length - 1];
    const latestClose = closes[closes.length - 1];
    const latestLow = candles[candles.length - 1].high;
    const latestHigh = candles[candles.length - 1].low;

    const previouspKama = pkama[pkama.length - 2];
    const previousClose = closes[closes.length - 2];

    if (
      previousClose > previouspKama &&
      (latestClose <= latestpKama || latestLow <= latestpKama)
    ) {
      const isCC = await get(`kama_touched_by_${pair}`);
      if (!isCC) {
        await set(`kama_touched_by_${pair}`, "up", 3600 * 18);
      }
    } else if (
      previousClose < previouspKama &&
      (latestClose >= latestpKama || latestHigh >= latestpKama)
    ) {
      const isCC = await get(`kama_touched_by_${pair}`);
      if (!isCC) {
        await set(`kama_touched_by_${pair}`, "down", 3600 * 18);
      }
    }

    const isRedisReady = await get(`kama_touched_by_${pair}`);

    if (isRedisReady) {
      await checkIsEntryIsReady(pair, isRedisReady);
    }
  }
}

module.exports = forexKamaTouch;
