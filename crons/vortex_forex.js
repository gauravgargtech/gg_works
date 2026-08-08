require("../config/config");
const https = require("https");

const { sendPushNotif } = require("../config/telegram_notify");

const { insert } = require("../adapters/mongo");
const { set, get, del } = require("../adapters/redis");

const { fetchCandles } = require("../exhanges/oanda");

const getChoppinessIndex = require("../indicators/choppiness_index");

const aiBreakBands = require("../indicators/ai_breakout_bands");

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

    const closes = candles.map((c) => c.close);

    const bands = await aiBreakBands(symbol, candles);
    const latestBand = bands[bands.length - 1];

    const previousBand = bands[bands.length - 2];

    const latestBandSmooth = latestBand.smoothed;
    const previousBandSmooth = previousBand.smoothed;

    const latestClose = closes[closes.length - 1];
    const previousClose = closes[closes.length - 2];

    const currentTimers = dayjs()
      .tz("Australia/Brisbane")
      .format("YYYY-MM-DD HH:mm:ss");

    if (previousClose < previousBandSmooth && latestClose > latestBandSmooth) {
      await insert("vortex_forex_daily", {
        symbol,
        symbol_type: "Forex",
        time: currentTimers,
        timestamp: dayjs().tz("Australia/Brisbane").unix(),
        direction: "up",
        price: latestClose,
        previous_price: previousClose,
        previous_band: previousBandSmooth,
        latest_band: latestBandSmooth,
      });
      await set(`daily_bias_for_${symbol}_is`, "up", 3600 * 24 * 10);
    } else if (
      previousClose > previousBandSmooth &&
      latestClose < latestBandSmooth
    ) {
      await insert("vortex_forex_daily", {
        symbol,
        symbol_type: "Forex",
        time: currentTimers,
        timestamp: dayjs().tz("Australia/Brisbane").unix(),
        direction: "down",
        price: latestClose,
        previous_band: previousBandSmooth,
        latest_band: latestBandSmooth,
        previous_price: previousClose,
      });
      await set(`daily_bias_for_${symbol}_is`, "down", 3600 * 24 * 10);
    }
  }
  return;
}

module.exports = checkVortexForex;
