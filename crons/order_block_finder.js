require("../config/config");
const https = require("https");

const { set, get, del } = require("../adapters/redis");
const { EMA } = require("technicalindicators");

const { sendPushNotif } = require("../config/telegram_notify");

const { fetchCandles } = require("../exhanges/oanda");

const findOrberBlocks = require("../indicators/order_block");
const axios = require("axios");

// ─── Helpers ──────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Main ─────────────────────────────────────────────────────
async function orderBlockFinder(theTimeInterval = "H4") {
  let theCoins = FOREX_PAIRS;

  if (theTimeInterval === "H1" || theTimeInterval === "H4") {
    theCoins = FOREX_PAIRS_GOOD;
  }
  for (const coin of theCoins) {
    const symbol = coin;

    await sleep(1000);

    console.log(`Scanning for ${symbol}...`);

    const candles = await fetchCandles(symbol, theTimeInterval, 900);

    const orderBlocks = await findOrberBlocks(candles);

    if (orderBlocks.bullishOBs) {
      await set(
        `bullishOBs_${symbol}_${theTimeInterval}`,
        JSON.stringify(orderBlocks.bullishOBs),
        3600 * 100,
      );
    }
    if (orderBlocks.bearishOBs) {
      await set(
        `bearishOBs_${symbol}_${theTimeInterval}`,
        JSON.stringify(orderBlocks.bearishOBs),
        3600 * 100,
      );
    }
  }
  return;
}

module.exports = orderBlockFinder;
