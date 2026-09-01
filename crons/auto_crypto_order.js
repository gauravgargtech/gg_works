require("../config/config");

const RabbitMQ = require("../adapters/rabbitmq");

const dayjs = require("dayjs");

const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const { set, get, del } = require("../adapters/redis");
const calculatePKAMA = require("../indicators/kama");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const aiBreakBands = require("../indicators/ai_breakout_bands");

const { fetchCandles, getTop100ByVolume } = require("../exhanges/bybit_public");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Main ─────────────────────────────────────────────────────
async function autoCryptoOrder() {
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
    isWeekend = true;
  }

  // Monday before 4am
  if (day === 1 && hour < 7) {
    isWeekend = true;
  }

  if (isWeekend) {
    return;
  }

  const top50Pairs = await getTop100ByVolume(50);

  const rabbit = RabbitMQ.getInstance();

  console.log("--Running auto fixex");

  const allSignals = [];
  const allPartials = [];

  for (const pair of top50Pairs) {
    const symbol = pair.symbol;

    let candles;
    try {
      candles = await fetchCandles(symbol, 60, 500);
    } catch (err) {
      continue;
    }

    if (candles.length < 400) {
      continue;
    }

    console.log(`Scanning symbol: ${symbol}`);

    await sleep(2);

    const theLatestCandle = candles[candles.length - 1];

    const theCandleSize =
      Math.abs(theLatestCandle.low - theLatestCandle.high) * 100;

    const closes = candles.map((c) => c.close);

    const bands = await aiBreakBands(symbol, candles);

    const currentBand = bands[bands.length - 1].smoothed;
    const previousBand = bands[bands.length - 2].smoothed;

    const currentUpperBand = bands[bands.length - 1].upperBand;
    const currentLowerBand = bands[bands.length - 1].lowerBand;

    const pkama = await calculatePKAMA(candles);

    const currentKama = pkama[pkama.length - 1];
    const previousKama = pkama[pkama.length - 2];

    const currentClose = closes[closes.length - 1];
    const previousClose = closes[closes.length - 2];

    const isSymbolBuyOrSell = await get(
      `crypto_new_gg_works_direction_for${symbol}`,
    );

    if (
      isSymbolBuyOrSell &&
      isSymbolBuyOrSell === "buy" &&
      (currentClose < currentKama || currentClose < currentBand)
    ) {
      /*
      allSignals.push({
        direction: "buy",
        symbol: symbol,
        price: currentClose,
        onlyClose: true,
        placeNew: false,
      });
      */
      await del(`crypto_new_gg_works_direction_for${symbol}`);
    } else if (
      isSymbolBuyOrSell &&
      isSymbolBuyOrSell === "sell" &&
      (currentClose > currentKama || currentClose > currentBand)
    ) {
      /*
      allSignals.push({
        direction: "buy",
        symbol: symbol,
        price: currentClose,
        onlyClose: true,
        placeNew: false,
      });
      */
      await del(`crypto_new_gg_works_direction_for${symbol}`);
    }

    if (
      previousClose < previousKama &&
      currentClose > currentKama // It means current price is greater than Pkama
      //previousClose < previousBand &&
      //currentClose > currentBand

      //latestClose > latestBandSmooth &&
      //latestTsi > latestSignal &&
      //latestSignal < 0 &&
      //latestVortex.vip > latestVortex.vim &&
      //latestVortex.vip >= 1.1 &&
      //latestVortex.vim <= 0.9
    ) {
      await set(`crypto_new_gg_works_direction_for${symbol}`, "buy");
      let onlyClose = false;
      let placeNew = true;

      if (theCandleSize > 20) {
        onlyClose = true;
        placeNew = false;
      }

      if (placeNew) {
        await sendPushNotif(
          `Crypto - ${symbol} at 1 Hour - Placing Order, BULLISH,  at ${closes[closes.length - 1]}`,
        );
      }

      allSignals.push({
        direction: "buy",
        symbol: symbol,
        price: currentClose,
        onlyClose: onlyClose,
        placeNew: placeNew,
      });
    } else if (
      previousClose > previousKama &&
      currentClose < currentKama
      //previousClose > previousBand &&
      //currentClose < currentBand

      //latestClose < latestBandSmooth &&
      //latestTsi < latestSignal &&
      //latestSignal > 0 &&
      //latestVortex.vip < latestVortex.vim &&
      //latestVortex.vim >= 1.1 &&
      //latestVortex.vip <= 0.9
    ) {
      await set(`crypto_new_gg_works_direction_for${symbol}`, "sell");

      let onlyClose = false;
      let placeNew = true;

      if (theCandleSize > 20) {
        onlyClose = true;
        placeNew = false;
      }

      if (placeNew) {
        console.log("Capital Orders Subscriber");

        await sendPushNotif(
          `Crypto - ${symbol} at 1 Hour - Placing Order, BEARISH,  at ${closes[closes.length - 1]}`,
        );
      }

      allSignals.push({
        direction: "sell",
        symbol: symbol,
        price: currentClose,
        onlyClose: onlyClose,
        placeNew: placeNew,
      });
    }

    const isSymbolBuyOrSellNew = await get(
      `crypto_new_gg_works_direction_for${symbol}`,
    );

    if (
      isSymbolBuyOrSellNew &&
      isSymbolBuyOrSellNew === "buy" &&
      symbol !== "GOLD"
    ) {
      allPartials.push({
        direction: "BUY",
        symbol: symbol.replace("_", ""),
        tp1: currentUpperBand,
      });
    } else if (
      isSymbolBuyOrSellNew &&
      isSymbolBuyOrSellNew === "sell" &&
      symbol !== "GOLD"
    ) {
      allPartials.push({
        direction: "SELL",
        symbol: symbol.replace("_", ""),
        tp1: currentLowerBand,
      });
    }
  }

  if (allSignals.length > 0) {
    for (const signal of allSignals) {
      await sleep(1);
      await rabbit.publish("crypto_orders", signal);
    }
  }
  if (allPartials.length > 0) {
    for (const partial of allPartials) {
      //await sleep(1);
      //await rabbit.publish("crypto_partials", partial);
    }
  }
}

module.exports = autoCryptoOrder;
