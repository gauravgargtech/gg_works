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
  getPrice,
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
      //theBoundary = await get(`daily_bias_for_${symbol}_is_lowerband`);
    } else {
      direction = "up";
      //theBoundary = await get(`daily_bias_for_${symbol}_is_upperband`);
    }

    const currentPrice = await getPrice(symbol);

    if (!currentPrice?.bid) {
      continue;
    }

    const instrumentDetails = await get(symbol);
    const pipSize = instrumentDetails.tickSize;

    const profitInPips = Math.abs(currentPrice?.bid - trade.price) / pipSize;

    if (profitInPips < 49) {
      continue;
    }

    const cachedFirst25 = await get(`is_first_25_taken_for_${symbol}`);

    if (!cachedFirst25 && profitInPips > 49 && profitInPips < 80) {
      await set(`is_first_25_taken_for_${symbol}`, "yes");
      const unitsToBeClosed = parseInt(trade.currentUnits / 4);

      if (unitsToBeClosed > 0) {
        await closePositions([trade.currentUnits / 4, 0], symbol);
      } else {
        await closePositions([0, trade.currentUnits / 4], symbol);
      }
    }

    const cachedFirst50 = await get(`is_first_50_taken_for_${symbol}`);

    if (!cachedFirst50 && profitInPips > 80 && profitInPips < 120) {
      await set(`is_first_50_taken_for_${symbol}`, "yes");
      const unitsToBeClosed = parseInt(trade.currentUnits / 4);

      if (unitsToBeClosed > 0) {
        await closePositions([trade.currentUnits / 4, 0], symbol);
      } else {
        await closePositions([0, trade.currentUnits / 4], symbol);
      }
    }
  }
};

module.exports = runTpForexHalf;
