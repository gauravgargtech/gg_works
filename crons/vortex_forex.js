require("../config/config");
const https = require("https");

const { sendPushNotif } = require("../config/telegram_notify");

const { insert } = require("../adapters/mongo");

const { fetchCandles } = require("../exhanges/oanda");

const getChoppinessIndex = require("../indicators/choppiness_index");

const vortexIndicator = require("../indicators/vortex");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Main ─────────────────────────────────────────────────────
async function checkVortexForex() {
  for (const coin of FOREX_PAIRS) {
    const symbol = coin;

    await sleep(1000);

    const now = new Date().toLocaleString("en-AU", {
      timeZone: "Australia/Brisbane",
    });

    const candles = await fetchCandles(symbol, "D", 800);

    const vortex = vortexIndicator(candles, 13);

    const currentVortex = vortex[vortex.length - 1];
    const secondLastVortex = vortex[vortex.length - 2];

    const choppiness = await getChoppinessIndex(candles, 14);
    const latestChoppiness = choppiness[choppiness.length - 1];

    const currentTimers = dayjs()
      .tz("Australia/Brisbane")
      .format("YYYY-MM-DD HH:mm:ss");

    if (
      currentVortex.vip > currentVortex.vim &&
      secondLastVortex.vip < secondLastVortex.vim &&
      latestChoppiness.chop <= 50
    ) {
      await sendPushNotif(`Forex Vortex Crossover 1D : ${symbol} - BULLISH`);
      await insert("vortex_forex_daily", {
        symbol,
        time: currentTimers,
        timestamp: dayjs().tz("Australia/Brisbane").unix(),
        vip: currentVortex.vip,
        vim: currentVortex.vim,
      });
    } else if (
      currentVortex.vip < currentVortex.vim &&
      secondLastVortex.vip > secondLastVortex.vim &&
      latestChoppiness.chop <= 50
    ) {
      await sendPushNotif(`Forex Vortex Crossover 1D : ${symbol} - BEARISH`);
      await insert("vortex_forex_daily", {
        symbol,
        time: currentTimers,
        timestamp: dayjs().tz("Australia/Brisbane").unix(),
        vip: currentVortex.vip,
        vim: currentVortex.vim,
      });
    }
  }
  return;
}

module.exports = checkVortexForex;
