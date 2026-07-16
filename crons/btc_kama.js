require("../config/config");
const https = require("https");

const { set, get, del } = require("../adapters/redis");
const calculatePKAMA = require("../indicators/kama");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const { fetchCandles: candlesFromBybit } = require("../exhanges/bybit_public");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Main ─────────────────────────────────────────────────────
async function btcKamaTouch() {
  await sleep(10);

  candles = await candlesFromBybit("BTCUSDT", 60, 800);
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
    const isCC = await get("btc_kama_touch");
    if (!isCC) {
      await set("btc_kama_touch", "ok", 3600 * 4);
      await sendPushNotif("BTC KAMA TOUCH - may Go UP again");
    }
  } else if (
    previousClose < previouspKama &&
    (latestClose >= latestpKama || latestHigh >= latestpKama)
  ) {
    const isCC = await get("btc_kama_touch");
    if (!isCC) {
      await set("btc_kama_touch", "ok", 3600 * 4);
      await sendPushNotif("BTC KAMA TOUCH - may Go DOWN again");
    }
  }
}

module.exports = btcKamaTouch;
