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

const { ADX } = require("technicalindicators");

const CATEGORY = "linear"; // BTCUSDT.P = linear perpetual on Bybit
const INTERVAL = "15"; // 15-minute candles
const FAST_LENGTH = 12;
const SLOW_LENGTH = 26;
const SIGNAL_LENGTH = 9;
const HISTORY_CANDLES = 500; // enough for EMA warm-up

const { set, get } = require("../adapters/redis");

const { sendPushNotif } = require("../config/telegram_notify");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function getTop100ByVolume() {
  const url = `${BASE_URL}/v5/market/tickers?category=linear`;
  const data = await fetchJSON(url);

  const MIN_VOLUME_USDT = 20_000_000; // $50M daily turnover
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
    .filter((t) => parseFloat(t.lastPrice) >= MIN_PRICE_USDT)
    .slice(0, 300)
    .map((t) => ({
      symbol: t.symbol,
      lastPrice: parseFloat(t.lastPrice),
      volume24h: parseFloat(t.turnover24h),
    }));

  return tickers;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
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
}

/**
 * Fetch closed 15m klines from Bybit V5 public API.
 * Returns array of { openTime, close } sorted oldest → newest.
 */
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

async function checkMacdAdx() {
  try {
    const coins = await getTop100ByVolume();

    for (let i = 0; i < coins.length; i++) {
      const { symbol, lastPrice, volume24h } = coins[i];
      await sleep(200);

      console.log(`Scanning MACD + ADX for ${symbol}...`);

      const candles = await fetchKlines(symbol, HISTORY_CANDLES);
      const macdData = computeMACD(candles);

      const closed = macdData.filter((d) => d.color !== null);
      if (closed.length < 2) return;

      const latest = closed[closed.length - 2]; // last fully closed candle

      const last5Macd = closed.slice(-5);

      const { diP, diM, adx } = computeADX(candles); // ← add this

      const lastAdx = adx[candles.length - 1];

      const last5Adx = adx.slice(-5);

      let isMacdChangeDetected = false;
      for (const i in last5Macd) {
        if (latest.color === "RED" && last5Macd[i].color === "GREEN") {
          isMacdChangeDetected = true;
        }
        if (latest.color === "GREEN" && last5Macd[i].color === "RED") {
          isMacdChangeDetected = true;
        }
      }

      let isMacdChangeDetectedAsBelow = true;

      if (isMacdChangeDetected) {
        const latestAdx = last5Adx[last5Adx.length - 1];
        if (
          latestAdx.adx > 20 &&
          latestAdx.adx < 35 &&
          (latestAdx.adx > last5Adx[last5Adx.length - 2].adx ||
            latestAdx.adx > last5Adx[last5Adx.length - 3].adx ||
            latestAdx.adx > last5Adx[last5Adx.length - 4].adx)
        ) {
          for (const gg of last5Adx) {
            if (gg.adx < 19) {
              isMacdChangeDetectedAsBelow = true;
            }
          }

          const isCC = await get(`${symbol}_MACD_ADX_ALERT`);
          if (!isCC && isMacdChangeDetectedAsBelow) {
            await set(`${symbol}_MACD_ADX_ALERT`, "oks", 3600);
            await sendPushNotif(
              `${symbol} MACD ADX Alert: ${latestAdx.adx}, Going ${latest.color === "RED" ? "Down" : "Up"}`,
            );
          }
        }
      }
    }
  } catch (err) {
    console.error("[ERROR]", err.message);
  }
}

module.exports = checkMacdAdx;
