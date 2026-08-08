require("../config/config");
const https = require("https");

const vortexIndicator = require("../indicators/vortex");
const dayjs = require("dayjs");

const { set, get, del } = require("../adapters/redis");
const calculatePKAMA = require("../indicators/kama");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const aiBreakBands = require("../indicators/ai_breakout_bands");

const getChoppinessIndex = require("../indicators/choppiness_index");

const {
  getInstruments,
  placeOrder,
  closePositions,
  getPositions,
  getOpenTrades,
} = require("../exhanges/oanda_demo");

const { fetchCandles } = require("../exhanges/oanda");

const runTpForexHalf = async () => {
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
  if (day === 1 && hour < 7) {
    isWeekend = true;
  }

  if (isWeekend) {
    return;
  }

  const allTrades = await getOpenTrades();

  if (allTrades.length === 0) {
    console.log("No open trades.");
    return;
  }

  for (const trade of allTrades) {
    const symbol = trade.instrument;
    if (trade.state !== "OPEN") {
      continue;
    }
    let direction = "";
    let theBoundary;
    if (trade.currentUnits < 0) {
      direction = "down";
      theBoundary = await get(`daily_bias_for_${symbol}_is_lowerband`);
    } else {
      direction = "up";
      theBoundary = await get(`daily_bias_for_${symbol}_is_upperband`);
    }

    if (!theBoundary) {
      continue;
    }

    const candles = await fetchCandles(symbol, "M5", 4);

    const close = candles[candles.length - 1].close;
    const high = candles[candles.length - 1].high;
    const low = candles[candles.length - 1].low;

    if (direction === "up" && (close >= theBoundary || high >= theBoundary)) {
      await closePositions([trade.currentUnits / 2, 0], symbol);
    } else if (
      direction === "down" &&
      (close <= theBoundary || low <= theBoundary)
    ) {
      await closePositions([0, trade.currentUnits / 2], symbol);
    }
  }
};

module.exports = runTpForexHalf;
