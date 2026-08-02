require("../config/config");
const https = require("https");

const { set, get, del } = require("../adapters/redis");
const calculatePKAMA = require("../indicators/kama");
const vortexIndicator = require("../indicators/vortex");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");
const getChoppinessIndex = require("../indicators/choppiness_index");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { computeTSI } = require("../indicators/tsi");

dayjs.extend(utc);
dayjs.extend(timezone);

const { fetchCandles } = require("../exhanges/oanda");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Main ─────────────────────────────────────────────────────
async function slowVortexTsiForex() {
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

    const vortex = vortexIndicator(candles, 200);

    const latestClose = closes[closes.length - 1];

    const currentVortex = vortex[vortex.length - 1];

    const { tsi, signal } = computeTSI(closes, 150, 30, 13);

    const currentTSI = tsi[tsi.length - 1];

    const pkama = calculatePKAMA(closes);
    const latestpKama = pkama[pkama.length - 1];

    const choppiness = await getChoppinessIndex(candles, 14);
    const latestChoppiness = choppiness[choppiness.length - 1];

    if (
      latestClose > latestpKama &&
      currentVortex.vip > currentVortex.vim &&
      currentTSI > 0 &&
      latestChoppiness.chop <= 50
    ) {
      const isCC = await get(`kama_touched_by_${pair}_uppp`);
      if (!isCC) {
        await set(`kama_touched_by_${pair}_uppp`, "up", 3600 * 48);
        await sendPushNotif(
          `${pair} Slow Vortex + TSI + Kama Directional - Going UP`,
        );
        console.log(`${pair} Slow Vortex + TSI + Kama Directional - Going UP`);
      }
    } else if (
      latestClose < latestpKama &&
      currentVortex.vip < currentVortex.vim &&
      currentTSI < 0 &&
      latestChoppiness.chop <= 50
    ) {
      const isCC = await get(`kama_touched_by_${pair}_down`);
      if (!isCC) {
        await set(`kama_touched_by_${pair}_down`, "up", 3600 * 48);
        await sendPushNotif(
          `${pair} Slow Vortex + TSI + Kama Directional - Going Down`,
        );
        console.log(
          `${pair} Slow Vortex + TSI + Kama Directional - Going Down`,
        );
      }
    }
  }
}

module.exports = slowVortexTsiForex;
