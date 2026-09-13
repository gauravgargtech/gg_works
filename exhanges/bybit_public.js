require("../config/config");
const https = require("https");
const axios = require("axios");
const { set, get } = require("../adapters/redis");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);
const BASE_URL = "https://api.bybit.com";

async function fetchJSON(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const json = await new Promise((resolve, reject) => {
      https
        .get(url, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error("JSON parse error: " + e.message));
            }
          });
        })
        .on("error", reject);
    });

    // Rate limited — wait and retry
    if (
      json.retCode === 10006 ||
      json.retCode === 10018 ||
      (json.retMsg && json.retMsg.includes("Rate Limit"))
    ) {
      const wait = 5000 * (attempt + 1);
      console.warn(
        `Rate limited on attempt ${attempt + 1}, waiting ${wait / 1000}s...`,
      );
      await sleep(wait);
      continue;
    }

    return json; // success
  }
  throw new Error(`Max retries exceeded for: ${url}`);
}

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function fetchCandles(symbol, interval, limit = 1000) {
  console.log(`Fetching ${symbol} ${interval}m candles, requested: ${limit}`);

  const MAX_BYBIT_LIMIT = 1000;
  const allCandles = [];

  let end = undefined;

  while (allCandles.length < limit) {
    const remaining = limit - allCandles.length;
    const requestLimit = Math.min(remaining, MAX_BYBIT_LIMIT);

    await sleep(1);
    const params = {
      category: "linear",
      symbol,
      interval,
      limit: requestLimit,
    };

    // For subsequent requests, fetch candles older than
    // the oldest candle we already have.
    if (end !== undefined) {
      params.end = end;
    }

    console.log(
      `Bybit request: ${symbol} ${interval}m, limit=${requestLimit}, end=${end}`,
    );

    const { data } = await axios.get("https://api.bybit.com/v5/market/kline", {
      params,
    });

    if (data.retCode !== 0) {
      console.error("Bybit error:", data.retMsg);
      break;
    }

    const list = data.result.list;

    if (!list || list.length === 0) {
      break;
    }

    allCandles.push(...list);

    // Bybit returns newest -> oldest.
    // list[list.length - 1] is the oldest candle in this batch.
    const oldestTimestamp = Number(list[list.length - 1][0]);

    end = oldestTimestamp - 1;

    // If Bybit returned fewer than requested, there may be
    // no more historical candles available.
    if (list.length < requestLimit) {
      break;
    }
  }

  // Remove duplicates based on timestamp
  const uniqueCandles = [
    ...new Map(allCandles.map((k) => [Number(k[0]), k])).values(),
  ];

  // Oldest -> newest
  uniqueCandles.sort((a, b) => Number(a[0]) - Number(b[0]));

  // Remove current unfinished candle
  const closedCandles = uniqueCandles.slice(0, -1);

  // Return exactly requested number if possible
  const selectedCandles = closedCandles.slice(-limit);

  const theData = selectedCandles.map((k) => ({
    flatTime: Number(k[0]),

    time: dayjs(Number(k[0]))
      .tz("Australia/Brisbane")
      .format("YYYY-MM-DDTHH:mm:ss.SSS"),

    openTime: dayjs(Number(k[0]))
      .tz("Australia/Brisbane")
      .format("YYYY-MM-DD HH:mm:ss"),

    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: Number(k[5]),
  }));

  console.log(`Fetched ${theData.length} closed candles...`);

  return theData;
}

async function getTop100ByVolume(theCount = 300) {
  const cached = await get("TOP_COINS_CACHE_BYBIT");
  const url = `${BASE_URL}/v5/market/tickers?category=linear`;
  const data = await fetchJSON(url);

  const MIN_VOLUME_USDT = 10_000_000; // $10M daily turnover
  const MIN_PRICE_USDT = 0.1; // drop sub-cent tokens
  const MIN_MARKET_CAP = 100_000_000; // $100M (needs extra call, see below)

  if (data.retCode !== 0) throw new Error(`Bybit error: ${data.retMsg}`);

  const tickers = data.result.list
    // Only USDT-settled perpetuals (e.g. BTCUSDT), skip inverse / spot
    .filter((t) => t.symbol.endsWith("USDT") && parseFloat(t.turnover24h) > 0)
    // Sort descending by 24h quote volume (turnover24h is in USDT)
    .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
    .filter((t) => t.symbol.endsWith("USDT") && parseFloat(t.turnover24h) > 0)
    .filter((t) => parseFloat(t.turnover24h) >= MIN_VOLUME_USDT)
    .filter((t) => parseFloat(t.lastPrice) <= 10)
    .filter((t) => parseFloat(t.lastPrice) >= MIN_PRICE_USDT)
    .filter((t) => !t.symbol.includes("LDOUSD"))
    .slice(0, theCount)
    .map((t) => {
      return {
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPrice),
        volume24h: parseFloat(t.turnover24h),
      };
    });

  return tickers;
}

module.exports = { fetchCandles, getTop100ByVolume };
