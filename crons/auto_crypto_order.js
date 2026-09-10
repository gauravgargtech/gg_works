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
const { getAllActivePositions } = require("../exhanges/bybit");

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
    //return;
  }

  const top50Pairs = await getTop100ByVolume(20);

  const fromAPI = [];

  for (const top50 of top50Pairs) {
    fromAPI.push(top50.symbol);
  }

  const diffPairs = _.difference(fromAPI, CRYPTO_PAIRS_MAINS);

  let activePositions;
  try {
    activePositions = await getAllActivePositions();
  } catch (err) {
    console.error("Error fetching active positions: ", err);
  }

  const allPairs = [];

  for (const pair of diffPairs) {
    allPairs.push(pair);
  }
  const allPairsFromPosition = {};
  if (activePositions && activePositions.length > 0) {
    for (const position of activePositions) {
      if (!allPairs.includes(position.symbol)) {
        allPairs.push(position.symbol);
      }
      allPairsFromPosition[position.symbol] = {
        symbol: position.symbol,
        side: position.side,
        size: position.size,
      };
    }
  }

  const rabbit = RabbitMQ.getInstance();

  console.log("--Running auto crypto order");

  const allSignals = [];

  for (const pair of allPairs) {
    const symbol = pair;

    let isSymbolFromPosition = false;
    if (!fromAPI.includes(symbol)) {
      isSymbolFromPosition = true;
    }

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
      ((theLatestCandle.high - theLatestCandle.low) / theLatestCandle.low) *
      100;

    const closes = candles.map((c) => c.close);

    const pkama = await calculatePKAMA(candles);

    const currentKama = pkama[pkama.length - 1];
    const previousKama = pkama[pkama.length - 2];

    const currentClose = closes[closes.length - 1];
    const previousClose = closes[closes.length - 2];

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
      let onlyClose = false;
      let placeNew = true;

      if (theCandleSize.toFixed(2) > 2 || isSymbolFromPosition) {
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
      let onlyClose = false;
      let placeNew = true;

      if (theCandleSize.toFixed(2) > 2 || isSymbolFromPosition) {
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

    if (allPairsFromPosition?.[symbol]) {
      const position = allPairsFromPosition[symbol];
      if (position.side.toLowerCase() === "buy" && currentClose < currentKama) {
        allSignals.push({
          direction: "buy",
          symbol: symbol,
          price: currentClose,
          onlyClose: true,
          placeNew: false,
        });
      } else if (
        position.side.toLowerCase() === "sell" &&
        currentClose > currentKama
      ) {
        allSignals.push({
          direction: "sell",
          symbol: symbol,
          price: currentClose,
          onlyClose: true,
          placeNew: false,
        });
      }
    }
  }

  if (allSignals.length > 0) {
    for (const signal of allSignals) {
      await sleep(1);
      await rabbit.publish("crypto_orders", signal);
      await sendPushNotif(
        `Crypto - ${signal.symbol} at 1 Hour will be ${signal.placeNew ? "NEW" : "CLOSE"} Order, ${signal.direction.toUpperCase()},  at ${signal.price}`,
      );
    }
  }
}

module.exports = autoCryptoOrder;
