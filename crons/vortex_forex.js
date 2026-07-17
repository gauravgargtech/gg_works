require("../config/config");
const https = require("https");

const { sendPushNotif } = require("../config/telegram_notify");

const { fetchCandles } = require("../exhanges/oanda");

const vortexIndicator = require("../indicators/vortex");

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

    if (
      currentVortex.vip > currentVortex.vim &&
      secondLastVortex.vip < secondLastVortex.vim
    ) {
      await sendPushNotif(`Forex Vortex Crossover 1D : ${symbol} - BULLISH`);
    } else if (
      currentVortex.vip < currentVortex.vim &&
      secondLastVortex.vip > secondLastVortex.vim
    ) {
      await sendPushNotif(`Forex Vortex Crossover 1D : ${symbol} - BEARISH`);
    }
  }
  return;
}

module.exports = checkVortexForex;
