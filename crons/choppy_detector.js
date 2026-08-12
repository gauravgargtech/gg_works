require("../config/config");
const https = require("https");

const vortexIndicator = require("../indicators/vortex");
const dayjs = require("dayjs");

const { set, get, del } = require("../adapters/redis");
const { EMA } = require("technicalindicators");
const calculatePKAMA = require("../indicators/kama");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const aiBreakBands = require("../indicators/ai_breakout_bands");

const getChoppinessIndex = require("../indicators/choppiness_index");

const { fetchCandles } = require("../exhanges/oanda");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function choppyDetector() {
  let choppySymbols = 0;
  const theSymbols = [];
  for (const symbol of FOREX_PAIRS) {
    const candles = await fetchCandles(symbol, "H1", 800);
    await sleep(1);

    const closes = candles.map((c) => c.close);

    const bands = await aiBreakBands(symbol, candles);

    const latestBand = bands[bands.length - 1];

    const instrumentDetails = await get(symbol);
    const pipSize = instrumentDetails.tickSize;

    const theDiff = latestBand.upperBand - latestBand.lowerBand;
    const thePipDiff = theDiff / pipSize;

    const previousBand = bands[bands.length - 2];

    const latestBandSmooth = latestBand.smoothed;
    const previousBandSmooth = previousBand.smoothed;

    const latestClose = closes[closes.length - 1];
    const previousClose = closes[closes.length - 2];

    if (thePipDiff < 70) {
      choppySymbols++;
      theSymbols.push(symbol);
    }
  }

  console.log(`Choppy symbol count: ${choppySymbols}`);

  console.log("Choppy symbols: ", theSymbols);

  if (choppySymbols > 5) {
    await set("choppy_symbols_count", choppySymbols);
    await set("is_choppy_market", "yes");
  } else {
    await set("choppy_symbols_count", choppySymbols);
    await del("is_choppy_market");
  }
}

module.exports = choppyDetector;
