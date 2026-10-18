require("../config/config");

const RabbitMQ = require("../adapters/rabbitmq");

const dayjs = require("dayjs");

const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
dayjs.extend(utc);
dayjs.extend(timezone);
const { getCoinsWithMarketCapAtLeast } = require("../exhanges/coingecko");
const powerKama = require("../indicators/pkama_old");
const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const { fetchCandles } = require("../exhanges/bybit_public");
const { getAllActivePositions, getBalance } = require("../exhanges/bybit");
const { get, set } = require("../adapters/redis");
const timeFrame = 3;
const {
  getAllActivePositions: getAllActivePositionsDemo10k,
} = require("../exhanges/bybit");

// Detects a run of 8-10 candles in one direction followed by an opposite candle.

const MIN_RUN = 8;
const MAX_RUN = 20;

// 1 = up (green), -1 = down (red), 0 = doji (open === close)
function direction(c) {
  if (c.close > c.open) return 1;
  if (c.close < c.open) return -1;
  return 0;
}

function findReversals(candles, minRun = MIN_RUN, maxRun = MAX_RUN) {
  const results = [];
  let runDir = 0;
  let runLen = 0;

  for (let i = 0; i < candles.length; i++) {
    const dir = direction(candles[i]);

    if (dir !== 0 && dir === runDir) {
      runLen++;
    } else {
      // Current candle breaks the run: was the run long enough?
      if (
        runDir !== 0 &&
        dir === -runDir &&
        runLen >= minRun &&
        runLen <= maxRun
      ) {
        results.push({
          runDirection: runDir === 1 ? "UP" : "DOWN",
          runLength: runLen,
          runStart: candles[i - runLen].openTime,
          reversalCandle: candles[i].openTime,
        });
        console.log(
          `${runLen} ${runDir === 1 ? "UP" : "DOWN"} candles, then reversal at ${candles[i].openTime}`,
        );
      }
      // Start a new run (a doji resets everything)
      runDir = dir;
      runLen = dir === 0 ? 0 : 1;
    }
  }
  return results;
}

// For checking only the latest closed candle (live use):
function checkLatest(candles, minRun = MIN_RUN, maxRun = MAX_RUN) {
  const last = candles[candles.length - 1];
  const lastDir = direction(last);
  if (lastDir === 0) return false;

  let runLen = 0;
  const runDir = -lastDir;
  for (
    let i = candles.length - 2;
    i >= 0 && direction(candles[i]) === runDir;
    i--
  ) {
    runLen++;
  }
  if (runLen >= minRun && runLen <= maxRun) {
    console.log(
      `${runLen} ${runDir === 1 ? "UP" : "DOWN"} candles, then reversal at ${last.openTime}`,
    );
    return true;
  }
  return false;
}

const sleepMS = async (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function bhediya() {
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
    //isWeekend = true;
  }

  // Monday before 4am
  if (day === 1 && hour < 2) {
    //isWeekend = true;
  }

  //const top50Pairs = await getTop100ByVolume(30);

  const coinData = await getCoinsWithMarketCapAtLeast(120_000_000);

  const top50Pairs = coinData
    .slice(0, 100)
    .map((coin) => ({ symbol: coin.symbol.toUpperCase() + "USDT" }));

  const allPairs = [];

  for (const top50 of top50Pairs) {
    if (!["USDTUSDT", "USDCUSDT", "USD1USDT"].includes(top50.symbol)) {
      allPairs.push(top50.symbol);
    }
  }

  const reversalsFound = [];

  for (const pair of allPairs) {
    const symbol = pair;

    let candles;
    try {
      candles = await fetchCandles(symbol, timeFrame, 30);
    } catch (err) {
      continue;
    }

    const reversals = findReversals(candles);

    if (reversals.length > 0) {
      reversalsFound.push(reversals);
    }

    console.log(
      `Fetched ${candles.length} candles for ${symbol}--------------------------`,
    );

    await sleepMS(500);
  }

  if (reversalsFound.length > 0) {
    for (const reversal of reversalsFound) {
      console.log(
        `Reversal found: ${reversal.runLength} candles went ${reversal.runDirection}, then reversal at ${reversal.reversalCandle}, look for reversal`,
      );
      sendPushNotif(
        `Reversal found: ${reversal.runLength} candles went ${reversal.runDirection}, then reversal at ${reversal.reversalCandle}, look for reversal`,
      );
      await sleepMS(500);
    }
  }
}

module.exports = bhediya;
