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

const runTpForex = async () => {
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
    if (trade.currentUnits < 0) {
      direction = "down";
    } else {
      direction = "up";
    }

    console.log(direction);
    const candles = await fetchCandles(symbol, "H1", 900);

    const vortex = vortexIndicator(candles, 13);

    const currentVortex = vortex[vortex.length - 1];
    const previousVortex = vortex[vortex.length - 2];

    if (
      direction === "up" &&
      previousVortex.vip > previousVortex.vim &&
      currentVortex.vip < currentVortex.vim
    ) {
      await closePositions([trade.currentUnits, 0], symbol);
    } else if (
      direction === "down" &&
      previousVortex.vim > previousVortex.vip &&
      currentVortex.vim < currentVortex.vip
    ) {
      await closePositions([0, trade.currentUnits], symbol);
    }
  }
};

module.exports = runTpForex;
