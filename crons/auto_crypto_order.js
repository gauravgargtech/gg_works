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

const { fetchCandles, getTop100ByVolume } = require("../exhanges/bybit_public");
const { getAllActivePositions, getBalance } = require("../exhanges/bybit");
const { get, set } = require("../adapters/redis");
const timeFrame = 15;
const {
  getAllActivePositions: getAllActivePositionsDemo10k,
} = require("../exhanges/bybit_demo_10k");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const sleepMS = async (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function findBigCandles(candles, thresholdPct = 10, lookback = 100) {
  const recent = candles.slice(-lookback); // last 100 candles (oldest-first array)
  const found = [];

  for (const c of recent) {
    const rangePct = ((c.high - c.low) / c.low) * 100;
    if (rangePct >= thresholdPct) {
      found.push({ openTime: c.openTime, rangePct: +rangePct.toFixed(2) });
      console.log(`${c.openTime}: high-low range ${rangePct.toFixed(2)}%`);
    }
  }
  return found;
}

function recentVolumeSpike(candles, lookback = 3, length = 20, mult = 1.5) {
  for (let k = 0; k < lookback; k++) {
    const slice = candles.slice(0, candles.length - k);
    if (volumeSpike(slice, length, mult)) return true;
  }
  return false;
}

function volumeSpike(candles, length = 20, mult = 1.5) {
  const n = candles.length;
  if (n < length + 1) return false;

  let sum = 0;
  for (let i = n - 1 - length; i < n - 1; i++) {
    sum += candles[i].volume; // previous 20 candles, excluding the current one
  }
  const avg = sum / length;

  return candles[n - 1].volume > mult * avg;
}

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
    //isWeekend = true;
  }

  // Monday before 4am
  if (day === 1 && hour < 2) {
    //isWeekend = true;
  }

  //const top50Pairs = await getTop100ByVolume(30);

  //const coinData = await getCoinsWithMarketCapAtLeast(120_000_000);

  /*
  const top50Pairs = coinData
    .slice(0, 100)
    .map((coin) => ({ symbol: coin.symbol.toUpperCase() + "USDT" }));
    */

  const fromAPI = [];

  /*
  for (const top50 of top50Pairs) {
    if (!["USDTUSDT", "USDCUSDT", "USD1USDT"].includes(top50.symbol)) {
      fromAPI.push(top50.symbol);
    }
  }
    */

  //const diffPairs = _.difference(fromAPI, CRYPTO_PAIRS_MAINS);

  const diffPairs = [
    "LITUSDT",
    "INJUSDT",
    "JSTUSDT",
    "CVXUSDT",
    "JUPUSDT",
    "BATUSDT",
    "SEIUSDT",
    "RENDERUSDT",
    "PYTHUSDT",
    "ARBUSDT",
    "OPUSDT",
    "ALGOUSDT",
  ];

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

  const allActivePositions = [];
  if (activePositions && activePositions.length > 0) {
    for (const position of activePositions) {
      console.log("Active position: ");
      console.log(position);
      if (!allPairs.includes(position.symbol)) {
        allPairs.push(position.symbol);
      }

      fromAPI.push(position.symbol);
      allActivePositions.push({
        symbol: position.symbol,
        side: position.side,
        size: position.size,
      });
    }
  }

  let activePositionsDemo10k;
  try {
    activePositionsDemo10k = await getAllActivePositionsDemo10k();
  } catch (err) {
    console.error("Error fetching active positions: ", err);
  }
  console.log(activePositionsDemo10k);
  console.log("--activePositionsDemo10k--");
  if (activePositionsDemo10k && activePositionsDemo10k.length > 0) {
    for (const position of activePositionsDemo10k) {
      console.log("Active position Demo account: ");
      console.log(position);
      if (!allPairs.includes(position.symbol)) {
        allPairs.push(position.symbol);
      }
      fromAPI.push(position.symbol);

      allActivePositions.push({
        symbol: position.symbol,
        side: position.side,
        size: position.size,
      });
    }
  }

  const rabbit = RabbitMQ.getInstance();

  console.log("--Running auto crypto order");

  const allSignals = [];

  let candlesForKama = await get("candles_for_pkama");

  if (candlesForKama) {
    await set("candles_for_pkama", Number(Number(candlesForKama) + 1));
  } else {
    await set("candles_for_pkama", Number(7264));
    candlesForKama = 7264;
  }

  console.log(
    `Candles for KAMA ------------------------------------ : ${candlesForKama}`,
  );

  const allPositionsFromAllAccounts = [];

  for (const position of allActivePositions) {
    allPositionsFromAllAccounts.push(position.symbol);
  }

  const theCrossovers = {};

  for (const pair of allPairs) {
    const symbol = pair;

    let isSymbolFromPosition = false;
    if (!fromAPI.includes(symbol)) {
      isSymbolFromPosition = true;
    }

    let candles;
    try {
      candles = await fetchCandles(symbol, timeFrame, candlesForKama);
    } catch (err) {
      continue;
    }

    //const isVolumeSpiked = recentVolumeSpike(candles, 3, 20, 1.5);

    const bigCandles = findBigCandles(candles, 5, candlesForKama);

    console.log(
      `Fetched ${candles.length} candles for ${symbol}--------------------------`,
    );

    if (
      bigCandles.length > 25 &&
      !allPositionsFromAllAccounts.includes(symbol)
    ) {
      continue;
    }

    if (candles.length < candlesForKama - 5) {
      continue;
    }
    if (candles.length < 5000) {
      continue;
    }

    console.log(`Scanning symbol: ${symbol}`);

    await sleepMS(500);

    const theLatestCandle = candles[candles.length - 1];

    if (theLatestCandle.close > 10) {
      continue;
    }

    const theCandleSize =
      ((theLatestCandle.high - theLatestCandle.low) / theLatestCandle.low) *
      100;

    const closes = candles.map((c) => c.close);

    const newCandles = candles.map((c) => ({
      openTime: dayjs(c.flatTime).valueOf(),
      closeTime: dayjs(c.flatTime).add(timeFrame, "minutes").valueOf(),
      time: c.flatTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    const pkama = await powerKama(newCandles, 150, symbol, timeFrame);

    console.log(`PKAMA for ${symbol}: ${pkama[pkama.length - 1]}`);

    const currentKama = pkama[pkama.length - 1];
    const previousKama = pkama[pkama.length - 2];

    const currentClose = closes[closes.length - 1];
    const previousClose = closes[closes.length - 2];

    theCrossovers[symbol] = 0;

    try {
      for (const [idx, candle] of Object.entries(candles)) {
        if (Number(idx) > 0) {
          if (
            candles[idx - 1].close < pkama[idx - 1] &&
            candle.close > pkama[idx]
          ) {
            theCrossovers[symbol]++;
          } else if (
            candles[idx - 1].close > pkama[idx - 1] &&
            candle.close < pkama[idx]
          ) {
            theCrossovers[symbol]++;
          }
        }
      }
    } catch (err) {
      ///
    }

    if (
      previousClose < previousKama &&
      currentClose > currentKama // It means current price is greater than Pkama
    ) {
      let onlyClose = false;
      let placeNew = true;

      /* Bad check
      if (currentClose > latestEma200) {
        onlyClose = false;
        placeNew = true;
      }
        */

      if (theCandleSize.toFixed(2) > 3 || isSymbolFromPosition) {
        onlyClose = true;
        placeNew = false;
      }

      if (isWeekend) {
        onlyClose = true;
        placeNew = false;
      }

      if (placeNew) {
        await sendPushNotif(
          `Crypto - ${symbol} at 1 Hour - Placing Order, BULLISH,  at ${closes[closes.length - 1]}, candle size is ${theCandleSize}`,
        );
      }

      allSignals.push({
        direction: "buy",
        symbol: symbol,
        price: currentClose,
        onlyClose: onlyClose,
        placeNew: placeNew,
        candleSize: theCandleSize,
      });
    } else if (previousClose > previousKama && currentClose < currentKama) {
      let onlyClose = false;
      let placeNew = true;

      /*
      if (latestEma200 > currentClose) {
        onlyClose = false;
        placeNew = true;
      }
        */

      if (theCandleSize.toFixed(2) > 3 || isSymbolFromPosition) {
        onlyClose = true;
        placeNew = false;
      }

      if (isWeekend) {
        onlyClose = true;
        placeNew = false;
      }

      if (placeNew) {
        await sendPushNotif(
          `Crypto - ${symbol} at 1 Hour - Placing Order, BEARISH,  at ${closes[closes.length - 1]}, candle size is ${theCandleSize}`,
        );
      }

      allSignals.push({
        direction: "sell",
        symbol: symbol,
        price: currentClose,
        onlyClose: onlyClose,
        placeNew: placeNew,
        candleSize: theCandleSize,
      });
    }
  }

  try {
    const currentBalanceInAud = await getBalance();
    const theBalanceFromRedis = await get("bybit_mains_current_balance");
    console.log(`Current balance in AUD: ${currentBalanceInAud}`);

    if (!theBalanceFromRedis) {
      await set("bybit_mains_current_balance", currentBalanceInAud);
    } else {
      // if currentbalance in aud is 10% more than the balance in redis, update it
      if (currentBalanceInAud > theBalanceFromRedis * 1.1) {
        await set("bybit_mains_current_balance", currentBalanceInAud);
        allActivePositions.sort(
          (a, b) => Number(b.unrealisedPnl) - Number(a.unrealisedPnl),
        );

        let ccc = 0;

        for (const position of allActivePositions) {
          allSignals.push({
            direction: position.side === "Buy" ? "sell" : "buy",
            symbol: position.symbol,
            price: "",
            onlyClose: true,
            placeNew: false,
            candleSize: 2,
          });
          if (ccc > 2) {
            break;
          }
          ccc++;
        }
      }
    }
  } catch (err) {
    console.error("Error in autoCryptoOrder: ", err);
  }

  allSignals.sort((a, b) => Number(a.placeNew) - Number(b.placeNew));

  if (allSignals.length > 0) {
    for (const signal of allSignals) {
      await sleep(1);
      await rabbit.publish("crypto_orders", signal);
      await sendPushNotif(
        `Crypto - ${signal.symbol} at 1 Hour will be ${signal.placeNew ? "NEW" : "CLOSE"} Order, ${signal.direction.toUpperCase()},  at ${signal.price}, candle size is ${signal.candleSize}`,
      );
    }
  }
}

module.exports = autoCryptoOrder;
