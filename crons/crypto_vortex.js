require("../config/config");
const https = require("https");

const { sendPushNotif } = require("../config/telegram_notify");

const { insert } = require("../adapters/mongo");
const calculatePKAMA = require("../indicators/kama");

const { fetchCandles, getTop100ByVolume } = require("../exhanges/bybit_public");

const { computeTSI } = require("../indicators/tsi");

const vortexIndicator = require("../indicators/vortex");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { get, set, del } = require("../adapters/redis");

dayjs.extend(utc);
dayjs.extend(timezone);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Main ─────────────────────────────────────────────────────
async function checkCryptoVortex() {
  const tickers = await getTop100ByVolume(20);

  for (let i = 0; i < tickers.length; i++) {
    const { symbol, lastPrice, volume24h } = tickers[i];

    await sleep(1000);

    const candles = await fetchCandles(symbol, 240, 800);

    const vortex = vortexIndicator(candles, 13);
    const closes = candles.map((c) => c.close);

    const pkama = calculatePKAMA(closes);

    const latestpKama = pkama[pkama.length - 1];
    const latestClose = closes[closes.length - 1];

    const { tsi, signal } = computeTSI(closes, 22, 10, 13);

    const currentTSI = tsi[tsi.length - 1];
    const currentSignal = signal[signal.length - 1];

    const secondLastTSI = tsi[tsi.length - 2];
    const secondLastSignal = signal[signal.length - 2];
    const redisKey = `tsi_${symbol}_direction_gbp_symbols`;

    if (currentTSI < currentSignal && secondLastTSI > secondLastSignal) {
      await del(redisKey);

      await del(`vortex_${symbol}_direction_gbp_symbols`);

      if (currentTSI > 10 && currentSignal > 10) {
        await set(redisKey, "down");
      }
    } else if (currentTSI > currentSignal && secondLastTSI < secondLastSignal) {
      await del(redisKey);
      await del(`vortex_${symbol}_direction_gbp_symbols`);

      if (currentTSI < 10 && currentSignal < 10) {
        await set(redisKey, "up");
      }
    }

    const isTrendEstablished = await get(redisKey);
    if (!isTrendEstablished) continue;

    const currentVortex = vortex[vortex.length - 1];
    const previousVortex = vortex[vortex.length - 2];
    const thirdVortex = vortex[vortex.length - 3];
    const fourthVortex = vortex[vortex.length - 4];

    const lastCandle = candles[candles.length - 1];

    let currentDirection = "";

    if (currentVortex.vip > currentVortex.vim && isTrendEstablished === "up") {
      const isCC = await get(`vortex_${symbol}_direction_gbp_symbols`);
      if (!isCC) {
        await set(`vortex_${symbol}_direction_gbp_symbols`, "up", 3600 * 20);
        await sendPushNotif(
          `Crypto 4 Hours : ${symbol} Vortex Detected 4 Hour - Going UP, Bullish`,
        );
      }
    } else if (
      currentVortex.vip < currentVortex.vim &&
      isTrendEstablished === "down"
    ) {
      const isCC = await get(`vortex_${symbol}_direction_gbp_symbols`);
      if (!isCC) {
        await set(`vortex_${symbol}_direction_gbp_symbols`, "down", 3600 * 20);
        await sendPushNotif(
          `Crypto 4 Hours : ${symbol} Vortex Detected 4 Hour - Going Down, Bearish`,
        );
      }
    }
  }
  return;
}

module.exports = checkCryptoVortex;
