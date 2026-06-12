/**
 * BTCUSDT.P MACD Color Change Monitor (15-minute TF)
 * Replicates CM_MacD_Ult_MTF Pine Script logic
 *
 * MACD color rules (from Pine Script):
 *   lime  (GREEN) → outMacD >= outSignal  (MACD is above or crossing up Signal)
 *   red   (RED)   → outMacD <  outSignal  (MACD is below or crossing down Signal)
 *
 * Logs every time the color changes between GREEN ↔ RED on a closed 15m candle.
 *
 * Usage:
 *   node btc-macd-monitor.js
 *
 * Dependencies: none (uses built-in https module)
 */

require("../config/config");
const https = require("https");
const BASE_URL = "https://api.bybit.com";

const CONFIG = {
  interval: "15", // 15 minute candles
  limit: 500, // 500 candles = ~5 days of context
  extremeHigh: 85, // top 15% of range = overbought
  extremeLow: 15, // bottom 15% of range = oversold
  scanEveryMins: 5, // re-scan every 5 minutes
};

const { ADX } = require("technicalindicators");
const { MACD } = require("technicalindicators");

const CATEGORY = "linear"; // BTCUSDT.P = linear perpetual on Bybit
const INTERVAL = "15"; // 15-minute candles
const FAST_LENGTH = 12;
const SLOW_LENGTH = 26;
const SIGNAL_LENGTH = 9;
const HISTORY_CANDLES = 300; // enough for EMA warm-up

const { set, get } = require("../adapters/redis");

const { sendPushNotif } = require("../config/telegram_notify");

const aiBreakBands = require("../indicators/ai_breakout_bands");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function batchProcess(items, batchSize, delayMs, fn) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(fn));
    if (i + batchSize < items.length) await sleep(delayMs);
  }
}

// ─── MACD calculation + range analysis ───────────────────────
function calcMacdAgain(closes) {
  const results = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  const lines = results.map((r) => r.MACD);
  const latest = results[results.length - 1];

  const highest = Math.max(...lines);
  const lowest = Math.min(...lines);
  const range = highest - lowest;
  const percentile = ((latest.MACD - lowest) / range) * 100;

  // Normalised = MACD as % of price (so BTC and SOL are comparable)
  const price = closes[closes.length - 1];
  const normMACD = (latest.MACD / price) * 100;

  return {
    macd: latest.MACD,
    signal: latest.signal,
    histogram: latest.histogram,
    highest,
    lowest,
    percentile,
    normMACD,
    price,
  };
}

// ─── Determine zone + reversal signal ────────────────────────
function getSignal(r) {
  const p = r.percentile;
  const h = r.histogram;

  if (p >= CONFIG.extremeHigh) {
    // Extra confirmation: histogram starting to shrink = momentum fading
    const fading = h < 0;
    return {
      signal: "up",
      emoji: "🔴",
      zone: "EXTREME HIGH",
      alert: fading,
      note: fading
        ? "⚡ Histogram turning negative — momentum fading, reversal likely"
        : "⚠️  Still pushing up — watch for histogram to turn",
    };
  }

  if (p <= CONFIG.extremeLow) {
    const fading = h > 0;
    return {
      signal: "down",
      emoji: "🟢",
      zone: "EXTREME LOW",
      alert: fading,
      note: fading
        ? "⚡ Histogram turning positive — momentum fading, reversal likely"
        : "⚠️  Still pushing down — watch for histogram to turn",
    };
  }

  if (p >= 70)
    return {
      emoji: "🟠",
      zone: "HIGH",
      alert: false,
      note: "Elevated — not extreme yet",
    };
  if (p <= 30)
    return {
      emoji: "🔵",
      zone: "LOW",
      alert: false,
      note: "Depressed — not extreme yet",
    };

  return {
    emoji: "⬜",
    zone: "NEUTRAL",
    alert: false,
    note: "Near midrange — no reversal edge",
  };
}

// ─── ASCII progress bar for percentile ───────────────────────
function buildBar(pct) {
  const filled = Math.round(pct / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return `[${bar}]`;
}

const BASE_URL_BINANCE = "https://fapi.binance.com"; // USDT-margined futures

async function getTop100ByVolume() {
  const cached = await get("TOP_COINS_CACHE_BYBIT");

  if (cached && JSON.parse(cached).length > 0) {
    return JSON.parse(cached);
  }

  const url = `${BASE_URL}/v5/market/tickers?category=linear`;
  const data = await fetchJSON(url);

  const MIN_VOLUME_USDT = 10_000_000; // $50M daily turnover
  const MIN_PRICE_USDT = 0.01; // drop sub-cent tokens
  const MIN_MARKET_CAP = 100_000_000; // $100M (needs extra call, see below)

  if (data.retCode !== 0) throw new Error(`Bybit error: ${data.retMsg}`);

  const tickers = data.result.list
    // Only USDT-settled perpetuals (e.g. BTCUSDT), skip inverse / spot
    .filter((t) => t.symbol.endsWith("USDT") && parseFloat(t.turnover24h) > 0)
    // Sort descending by 24h quote volume (turnover24h is in USDT)
    .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
    .filter((t) => t.symbol.endsWith("USDT") && parseFloat(t.turnover24h) > 0)
    .filter((t) => parseFloat(t.turnover24h) >= MIN_VOLUME_USDT)
    //    .filter((t) => parseFloat(t.lastPrice) >= MIN_PRICE_USDT)
    .slice(0, 300)
    .map((t) => ({
      symbol: t.symbol,
      lastPrice: parseFloat(t.lastPrice),
      volume24h: parseFloat(t.turnover24h),
    }));

  await set("TOP_COINS_CACHE_BYBIT", JSON.stringify(tickers), 3600); // cache 5 min

  return tickers;
}

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

// Bybit interval '15' → Binance needs '15m', '1h', '4h', '1d' etc.
const INTERVAL_MAP = {
  1: "1m",
  3: "3m",
  5: "5m",
  15: "15m",
  30: "30m",
  60: "1h",
  120: "2h",
  240: "4h",
  360: "6h",
  720: "12h",
  D: "1d",
  W: "1w",
  M: "1M",
};

async function fetchKlines(symbol, limit = HISTORY_CANDLES) {
  const url =
    `https://api.bybit.com/v5/market/kline` +
    `?category=${CATEGORY}&symbol=${symbol}&interval=${INTERVAL}&limit=${limit}`;

  const json = await fetchJSON(url);

  if (json.retCode !== 0) {
    throw new Error(`Bybit API error: ${json.retMsg}`);
  }

  // Bybit returns newest first: [ [startTime, open, high, low, close, volume, turnover], ... ]
  const raw = json.result.list;

  // Reverse so index 0 = oldest
  return raw
    .slice()
    .reverse()
    .map((k) => ({
      time: new Date(Number(k[0])).toISOString(),
      openTime: dayjs(Number(k[0]))
        .tz("Australia/Brisbane")
        .format("YYYY-MM-DD HH:mm:ss"),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
    }));
}

/**
 * EMA calculation (matches Pine Script ema()).
 * Returns array of EMA values aligned with `prices` (same length).
 * First (length-1) values use SMA seed.
 */
function ema(prices, length) {
  const k = 2 / (length + 1);
  const result = new Array(prices.length).fill(null);

  // Seed with SMA of first `length` bars
  let sum = 0;
  for (let i = 0; i < length; i++) sum += prices[i];
  result[length - 1] = sum / length;

  for (let i = length; i < prices.length; i++) {
    result[i] = prices[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/**
 * SMA calculation (matches Pine Script sma()).
 */
function sma(values, length) {
  const result = new Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i - length + 1; j <= i; j++) {
      if (values[j] !== null) {
        sum += values[j];
        count++;
      }
    }
    if (count === length) result[i] = sum / length;
  }
  return result;
}

function computeADX(candles, len = 10) {
  const n = candles.length;

  const tr = new Array(n).fill(0);
  const dmP = new Array(n).fill(0);
  const dmM = new Array(n).fill(0);

  // --- per-bar TR and DM ---
  for (let i = 1; i < n; i++) {
    const { high, low } = candles[i];
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;
    const prevClose = candles[i - 1].close;

    tr[i] = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    dmP[i] = high - prevHigh > prevLow - low ? Math.max(high - prevHigh, 0) : 0;
    dmM[i] = prevLow - low > high - prevHigh ? Math.max(prevLow - low, 0) : 0;
  }

  // --- Wilder smoothing (same formula as Pine: val - val/len + new) ---
  const sTR = new Array(n).fill(0);
  const sDMP = new Array(n).fill(0);
  const sDMM = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    sTR[i] = sTR[i - 1] - sTR[i - 1] / len + tr[i];
    sDMP[i] = sDMP[i - 1] - sDMP[i - 1] / len + dmP[i];
    sDMM[i] = sDMM[i - 1] - sDMM[i - 1] / len + dmM[i];
  }

  // --- DI+, DI-, DX ---
  const diP = new Array(n).fill(0);
  const diM = new Array(n).fill(0);
  const dx = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    if (sTR[i] === 0) continue;
    diP[i] = (sDMP[i] / sTR[i]) * 100;
    diM[i] = (sDMM[i] / sTR[i]) * 100;
    const sum = diP[i] + diM[i];
    dx[i] = sum === 0 ? 0 : (Math.abs(diP[i] - diM[i]) / sum) * 100;
  }

  // --- ADX = simple moving average of DX over `len` bars ---
  const adx = new Array(n).fill(0);
  for (let i = len; i < n; i++) {
    let sum = 0;
    for (let j = i - len + 1; j <= i; j++) sum += dx[j];
    adx[i] = sum / len;
  }

  return { diP, diM, dx, adx };
}

/**
 * Compute MACD, Signal, and color for each candle.
 * Returns array of { openTime, macd, signal, color } (nulls for warm-up bars).
 */
function computeMACD(candles) {
  const closes = candles.map((c) => c.close);

  const fastEMA = ema(closes, FAST_LENGTH);
  const slowEMA = ema(closes, SLOW_LENGTH);

  // macd line
  const macdLine = closes.map((_, i) =>
    fastEMA[i] !== null && slowEMA[i] !== null ? fastEMA[i] - slowEMA[i] : null,
  );

  // signal = SMA(macd, 9)
  const signalLine = sma(macdLine, SIGNAL_LENGTH);

  return candles.map((c, i) => {
    if (macdLine[i] === null || signalLine[i] === null) {
      return { openTime: c.openTime, macd: null, signal: null, color: null };
    }
    const color = macdLine[i] >= signalLine[i] ? "GREEN" : "RED";
    return {
      openTime: dayjs(c.openTime)
        .tz("Australia/Brisbane")
        .format("YYYY-MM-DD HH:mm:ss"),
      macd: macdLine[i],
      signal: signalLine[i],
      color,
    };
  });
}

// ─── State ─────────────────────────────────────────────────────────────────────

let lastColor = null;
let lastCandleTime = null;
let initialized = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkMacdAdxReversal() {
  try {
    //await sleep(60 * 1000);
    const coins = await getTop100ByVolume();

    console.log(coins);

    await batchProcess(coins, 3, 3000, async (coin) => {
      const symbol = coin.symbol;
      console.log(`Scanning MACD + ADX for ${symbol}...`);

      let candles;

      candles = await fetchKlines(symbol, HISTORY_CANDLES);
      const bands = await aiBreakBands(symbol, candles);

      const lastBand = bands[bands.length - 1];

      const macdData = computeMACD(candles);

      const closed = macdData.filter((d) => d.color !== null);
      if (closed.length < 2) return;

      const latest = closed[closed.length - 2]; // last fully closed candle

      const latestCandle = candles[candles.length - 2];

      const last5Macd = closed.slice(-5);

      const { diP, diM, adx } = computeADX(candles); // ← add this

      const lastAdx = adx[candles.length - 1];

      const last5Adx = adx.slice(-5);

      const r = calcMacdAgain(candles.map((c) => c.close));
      const sig = getSignal(r);

      const pctBar = buildBar(r.percentile);

      let isTrueSignal = false;

      if (
        sig.signal === "up" &&
        coin.lastPrice > lastBand.lowerBand &&
        latestCandle.open <= lastBand.smoothed
      ) {
        isTrueSignal = true;
      } else if (
        sig.signal === "down" &&
        coin.lastPrice < lastBand.upperBand &&
        latestCandle.open >= lastBand.smoothed
      ) {
        isTrueSignal = true;
      }

      if (sig.alert && isTrueSignal) {
        const isCC = await get(`${symbol}_MACD_ADX_ALERT_REVERSAL`);

        if (!isCC) {
          await sendPushNotif(
            `${symbol} REVERSAL ZONE ALERT 4 Hour: ${sig.zone}, Note:  ${sig.note}`,
          );
          await set(`${symbol}_MACD_ADX_ALERT_REVERSAL`, true, 7200);
        }
      }
    });
  } catch (err) {
    console.error("[ERROR]", err.message);
    console.log(err);
  }
}

module.exports = checkMacdAdxReversal;
