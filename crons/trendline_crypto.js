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
const calculateAdaptiveTrendline = require("../indicators/trendline_adaptive");

const CONFIG = {
  limit: 500,
  pivot: 5, // candles each side to confirm a swing point
  buffer: 0.002, // 0.2% beyond the line counts as a real break
  minGap: 8, // min candles between the two points of a line
};

function findPivots(candles, t, k) {
  const lows = [];
  const highs = [];
  for (let i = k; i <= t - k; i++) {
    let isLow = true;
    let isHigh = true;
    for (let j = i - k; j <= i + k; j++) {
      if (candles[j].low < candles[i].low) isLow = false;
      if (candles[j].high > candles[i].high) isHigh = false;
    }
    if (isLow) lows.push(i);
    if (isHigh) highs.push(i);
  }
  return { lows, highs };
}

// Build a line from two points on log price; returns a function giving price at index x.
function makeLine(a, pa, b, pb) {
  const la = Math.log(pa);
  const slope = (Math.log(pb) - la) / (b - a);
  return (x) => Math.exp(la + slope * (x - a));
}

/** Check candle t (the last closed candle) for a trendline break. */
function detect(candles, t, { pivot, buffer, minGap }) {
  const signals = [];
  const { lows, highs } = findPivots(candles, t, pivot);

  // Uptrend line -> SELL on break below
  if (lows.length >= 2) {
    const b = lows[lows.length - 1];
    const a = lows[lows.length - 2];
    if (b - a >= minGap && candles[b].low > candles[a].low) {
      const line = makeLine(a, candles[a].low, b, candles[b].low);
      let intact = true;
      for (let i = b + 1; i < t; i++) {
        if (candles[i].close < line(i)) {
          intact = false;
          break;
        }
      }
      if (intact && candles[t].close < line(t) * (1 - buffer)) {
        signals.push({
          side: "SELL",
          reason: "Closed below uptrend line",
          price: candles[t].close,
          line: line(t),
          points: [a, b],
          index: t,
        });
      }
    }
  }

  // Downtrend line -> BUY on break above
  if (highs.length >= 2) {
    const b = highs[highs.length - 1];
    const a = highs[highs.length - 2];
    if (b - a >= minGap && candles[b].high < candles[a].high) {
      const line = makeLine(a, candles[a].high, b, candles[b].high);
      let intact = true;
      for (let i = b + 1; i < t; i++)
        if (candles[i].close > line(i)) {
          intact = false;
          break;
        }
      if (intact && candles[t].close > line(t) * (1 + buffer)) {
        signals.push({
          side: "BUY",
          reason: "Closed above downtrend line",
          price: candles[t].close,
          line: line(t),
          points: [a, b],
          index: t,
        });
      }
    }
  }
  return signals;
}

// ---------- output ----------
const fmtTime = (ms) =>
  new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
function printSignal(s, candles) {
  console.log(
    `${s.side.padEnd(4)} | ${fmtTime(candles[s.index].time)} | close ${s.price.toFixed(4)} ` +
      `| line ${s.line.toFixed(4)} | ${s.reason}`,
  );
}

function scanHistory(candles) {
  const start = CONFIG.pivot * 2 + CONFIG.minGap + 5;
  let count = 0;
  for (let t = start; t < candles.length; t++) {
    for (const s of detect(candles, t, CONFIG)) {
      printSignal(s, candles);
      count++;
    }
  }
  console.log(`\n${count} signal(s) in ${candles.length} candles.`);
}

function checkLatest(candles) {
  const t = candles.length - 1;
  const signals = detect(candles, t, CONFIG);
  console.log(
    `Last closed candle: ${fmtTime(candles[t].time)}  close ${candles[t].close}`,
  );
  if (!signals.length) console.log("No trendline break on the latest candle.");
  signals.forEach((s) => printSignal(s, candles));
}

async function watch() {
  let lastTime = 0;
  console.log(
    `Watching ${CONFIG.symbol} ${CONFIG.interval} ... (Ctrl+C to stop)`,
  );
  const tick = async () => {
    try {
      const candles = await fetchCandles(CONFIG);
      const last = candles[candles.length - 1];
      if (last.time === lastTime) return;
      lastTime = last.time;
      const signals = detect(candles, candles.length - 1, CONFIG);
      console.log(
        `[${fmtTime(last.time)}] closed at ${last.close}${signals.length ? "" : " - no break"}`,
      );
      signals.forEach((s) => printSignal(s, candles));
      // TODO: send Telegram/Discord alert here
    } catch (e) {
      console.error("Fetch failed:", e.message);
    }
  };
  await tick();
  setInterval(tick, 60 * 1000);
}

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

async function trendlineCrypto() {
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

  const coinData = await getCoinsWithMarketCapAtLeast(120_000_000);

  const top50Pairs = coinData
    .slice(0, 100)
    .map((coin) => ({ symbol: coin.symbol.toUpperCase() + "USDT" }));

  const fromAPI = [];

  for (const top50 of top50Pairs) {
    if (!["USDTUSDT", "USDCUSDT", "USD1USDT"].includes(top50.symbol)) {
      fromAPI.push(top50.symbol);
    }
  }

  const diffPairs = _.difference(fromAPI, CRYPTO_PAIRS_MAINS);

  const diffPairss = [
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
    "SUIUSDT",
    "CRVUSDT",
    "CHZUSDT",
    "XRPUSDT",
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
  await set("candles_for_pkama", Number(7500));

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
  const bigCandleObj = {};

  console.log(allPairs);
  console.log("--allPairs--");
  console.log(allPairs.length);

  for (const pair of allPairs) {
    const symbol = pair;

    let isSymbolFromPosition = false;
    if (!fromAPI.includes(symbol)) {
      //isSymbolFromPosition = true;
    }

    let candles;
    try {
      candles = await fetchCandles(symbol, 240, candlesForKama);
    } catch (err) {
      continue;
    }

    //const isVolumeSpiked = recentVolumeSpike(candles, 3, 20, 1.5);

    const bigCandles = findBigCandles(candles, 5, candlesForKama);

    console.log(
      `Fetched ${candles.length} candles for ${symbol}--------------------------`,
    );

    bigCandleObj[symbol] = bigCandles.length;

    if (
      bigCandles.length > 35 &&
      !allPositionsFromAllAccounts.includes(symbol)
    ) {
      //continue;
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

    if (theLatestCandle.close > 20) {
      continue;
    }

    const theCandleSize =
      ((theLatestCandle.high - theLatestCandle.low) / theLatestCandle.low) *
      100;

    const closes = candles.map((c) => c.close);

    const trend = calculateAdaptiveTrendline(candles, {
      periodMode: true,
      devMultiplier: 2,
      timeframe: "4h",
      symbolType: "crypto",
    });

    const upperLevel = trend.upperEndPrice;
    const lowerLevel = trend.lowerEndPrice;

    const trendStrength = trend.trendStrength.toLowerCase();
    const pearson = trend.pearsonR;

    const currentClose = closes[closes.length - 1];
    const currentHigh = candles[candles.length - 1].high;
    const currentLow = candles[candles.length - 1].low;

    theCrossovers[symbol] = 0;

    if (
      trendStrength.indexOf("strong") &&
      pearson > 0.6 &&
      currentHigh > lowerLevel &&
      currentLow < lowerLevel
    ) {
      let onlyClose = false;
      let placeNew = true;

      if (theCandleSize.toFixed(2) > 4 || isSymbolFromPosition) {
        onlyClose = true;
        placeNew = false;
      }

      if (isWeekend) {
        onlyClose = true;
        placeNew = false;
      }

      if (placeNew) {
        await sendPushNotif(
          `Crypto - ${symbol} at 4 Hours - Placing Order, BULLISH,  at ${closes[closes.length - 1]}, candle size is ${theCandleSize}`,
        );
      }

      allSignals.push({
        direction: "buy",
        symbol: symbol,
        price: currentClose,
        onlyClose: onlyClose,
        placeNew: placeNew,
        candleSize: theCandleSize,
        sl: currentLow,
      });
    } else if (
      trendStrength.indexOf("weak") &&
      pearson > 0.6 &&
      currentHigh > upperLevel &&
      currentLow < upperLevel
    ) {
      let onlyClose = false;
      let placeNew = true;

      if (theCandleSize.toFixed(2) > 4 || isSymbolFromPosition) {
        onlyClose = true;
        placeNew = false;
      }

      if (isWeekend) {
        onlyClose = true;
        placeNew = false;
      }

      if (placeNew) {
        await sendPushNotif(
          `Crypto - ${symbol} at 4 Hours - Placing Order, BEARISH,  at ${closes[closes.length - 1]}, candle size is ${theCandleSize}`,
        );
      }

      allSignals.push({
        direction: "sell",
        symbol: symbol,
        price: currentClose,
        onlyClose: onlyClose,
        placeNew: placeNew,
        candleSize: theCandleSize,
        sl: currentHigh,
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
          continue;
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
        `Crypto - ${signal.symbol} at 4 Hours will be ${signal.placeNew ? "NEW" : "CLOSE"} Order, ${signal.direction.toUpperCase()},  at ${signal.price}, candle size is ${signal.candleSize}`,
      );
    }
  }
}

module.exports = trendlineCrypto;
