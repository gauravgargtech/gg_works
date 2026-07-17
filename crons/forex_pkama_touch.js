require("../config/config");
const https = require("https");

const { set, get, del } = require("../adapters/redis");
const calculatePKAMA = require("../indicators/kama");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const { fetchCandles } = require("../exhanges/oanda");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Main ─────────────────────────────────────────────────────
async function forexKamaTouch() {
  await sleep(10);

  for (const pair of FOREX_PAIRS) {
    await sleep(2);

    candles = await fetchCandles(pair, "H4", 800);
    const closes = candles.map((c) => c.close);

    const pkama = calculatePKAMA(closes);

    const latestpKama = pkama[pkama.length - 1];
    const latestClose = closes[closes.length - 1];
    const latestLow = candles[candles.length - 1].high;
    const latestHigh = candles[candles.length - 1].low;

    const previouspKama = pkama[pkama.length - 2];
    const previousClose = closes[closes.length - 2];

    if (
      previousClose > previouspKama &&
      (latestClose <= latestpKama || latestLow <= latestpKama)
    ) {
      const isCC = await get(`kama_touched_by_${pair}`);
      if (!isCC) {
        await set(`kama_touched_by_${pair}`, "ok", 3600 * 12);
        await sendPushNotif(`${pair} KAMA TOUCH 4H - may Go UP again`);
      }
    } else if (
      previousClose < previouspKama &&
      (latestClose >= latestpKama || latestHigh >= latestpKama)
    ) {
      const isCC = await get(`kama_touched_by_${pair}`);
      if (!isCC) {
        await set(`kama_touched_by_${pair}`, "ok", 3600 * 12);
        await sendPushNotif(`${pair} KAMA TOUCH 4 H - may Go DOWN again`);
      }
    }
  }
}

module.exports = forexKamaTouch;
