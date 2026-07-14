require("../config/config");
const https = require("https");

const { sendPushNotif } = require("../config/telegram_notify");
const { get, set, del } = require("../adapters/redis");

const { fetchCandles } = require("../exhanges/oanda");

const vortexIndicator = require("../indicators/vortex");
const { computeTSI } = require("../indicators/tsi");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Main ─────────────────────────────────────────────────────
async function checkVortexBTC() {
  const symbol = "BTC_USD";

  await sleep(3000);

  const now = new Date().toLocaleString("en-AU", {
    timeZone: "Australia/Brisbane",
  });

  const candles = await fetchCandles(symbol, "H1", 800);

  if (!candles[candles.length - 1]?.close) return;
  const currentPrice = candles[candles.length - 1].close;

  const vortex = vortexIndicator(candles, 14);

  const { tsi, signal } = computeTSI(
    candles.map((c) => c.close),
    25,
    13,
    13,
  );

  const currentTSI = tsi[tsi.length - 1];
  const currentSignal = signal[signal.length - 1];

  const secondLastTSI = tsi[tsi.length - 2];
  const secondLastSignal = signal[signal.length - 2];

  const thirdLastTSI = tsi[tsi.length - 3];
  const thirdLastSignal = signal[signal.length - 3];

  const currentVortex = vortex[vortex.length - 1];
  const secondLastVortex = vortex[vortex.length - 2];

  if (thirdLastTSI < thirdLastSignal && currentTSI > currentSignal) {
    await set(`tsi_${symbol}_direction_1hrs`, "up");
    await sendPushNotif(
      `${symbol} Vortex Crossover 1 Hour Direction changed to BULLISH at ${currentPrice}`,
    );
    await del(`tsi_${symbol}_direction_1hrs_ups`);
    await del(`tsi_${symbol}_direction_1hrs_downs`);
  } else if (thirdLastTSI > thirdLastSignal && currentTSI < currentSignal) {
    await set(`tsi_${symbol}_direction_1hrs`, "down");
    await sendPushNotif(
      `${symbol} Vortex Crossover 1 Hour Direction changed to BEARISH at ${currentPrice}`,
    );
    await del(`tsi_${symbol}_direction_1hrs_ups`);
    await del(`tsi_${symbol}_direction_1hrs_downs`);
  }

  const theDirection = await get(`tsi_${symbol}_direction_1hrs`, "down");

  if (theDirection == "up" && currentVortex.vip > currentVortex.vim) {
    const isCC = await get(`tsi_${symbol}_direction_1hrs_ups`);
    if (!isCC) {
      await sendPushNotif(
        `${symbol} Vortex Crossover 1 Hour : ${symbol} - BULLISH at ${currentPrice}`,
      );
      await set(`tsi_${symbol}_direction_1hrs_ups`, "ok");
    }
  } else if (theDirection == "down" && currentVortex.vip < currentVortex.vim) {
    const isCC = await get(`tsi_${symbol}_direction_1hrs_downs`);

    if (!isCC) {
      await sendPushNotif(
        `${symbol} Vortex Crossover 1 Hour : ${symbol} - BEARISH at ${currentPrice}`,
      );
      await set(`tsi_${symbol}_direction_1hrs_downs`, "ok");
    }
  }

  return;
}

module.exports = checkVortexBTC;
