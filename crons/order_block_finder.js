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
  for (const coin of FOREX_PAIRS) {
    const symbol = coin;

    await sleep(1000);

    console.log(`Scanning for ${symbol}...`);

    const candles = await fetchCandles(symbol, theTimeInterval, 900);

    const orderBlocks = await findOrberBlocks(candles);

    if (orderBlocks.bullishOBs) {
      await set(
        `bullishOBs_${symbol}_${theTimeInterval}`,
        JSON.stringify(orderBlocks.bullishOBs),
      );
    }
    if (orderBlocks.bearishOBs) {
      await set(
        `bearishOBs_${symbol}_${theTimeInterval}`,
        JSON.stringify(orderBlocks.bearishOBs),
      );
    }
  }
  return;
}

module.exports = orderBlockFinder;
