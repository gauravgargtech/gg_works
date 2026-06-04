/**
 * Moving Averages Proximity Oscillator (MAPO) - LuxAlgo
 * Replicates Pine Script logic in JavaScript
 * Fetches 15-min candles from Bybit V5 public API (no API key needed)
 *
 * Settings (matching your spec):
 *   min       = 5
 *   max       = 100
 *   smooth    = 3
 *   normalized = true
 *   src       = close
 *   Timeframe : 15-minute candles
 *   Threshold : Proximity Index >= 78
 *
 * Usage:
 *   node mapo-proximity.js BTCUSDT        ← linear perpetual (default)
 *   node mapo-proximity.js BTCUSDT spot   ← spot market
 *   node mapo-proximity.js BTCUSD inverse ← inverse contract
 */

require("../config/config");
const https = require("https");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const { set, get } = require("../adapters/redis");

const { sendPushNotif } = require("../config/telegram_notify");

// ─── Config ──────────────────────────────────────────────────────────────────
const MIN_LEN = 5;
const MAX_LEN = 100;
const SMOOTH = 3;
const THRESHOLD = 78;
const LIMIT = 950; // candles to fetch (200 is plenty for warm-up)

// Bybit V5 public REST base
const BYBIT_BASE = "https://api.bybit.com";

// ─── Bybit fetch helpers ──────────────────────────────────────────────────────

/**
 * Tiny promise wrapper around https.get so we don't need axios/node-fetch.
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

/**
 * Fetch 15-min klines from Bybit V5 /v5/market/kline
 *
 * Response list item: [startTime, open, high, low, close, volume, turnover]
 * Bybit returns newest-first; we reverse to get oldest-first.
 *
 * @param {string} symbol   e.g. "BTCUSDT"
 * @param {string} category "linear" | "inverse" | "spot"  (default: "linear")
 * @param {number} limit    number of candles (max 1000)
 * @returns {Promise<Array<{time: Date, open, high, low, close, volume}>>}
 */
async function fetchBybitKlines(
  symbol = "BTCUSDT",
  category = "linear",
  limit = LIMIT,
  interval = 240,
) {
  const url =
    `${BYBIT_BASE}/v5/market/kline` +
    `?category=${encodeURIComponent(category)}` +
    `&symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}` +
    `&limit=${limit}`;

  console.log(
    `\n[Bybit] Fetching ${limit} × 15-min candles for ${symbol} (${category})…`,
  );
  console.log(`[Bybit] URL: ${url}\n`);

  const json = await httpsGet(url);

  if (json.retCode !== 0) {
    throw new Error(`Bybit API error ${json.retCode}: ${json.retMsg}`);
  }

  const rawList = json.result?.list;
  if (!rawList || rawList.length === 0) {
    throw new Error("Bybit returned an empty kline list.");
  }

  // rawList is newest-first; reverse to chronological order
  const candles = rawList
    .slice()
    .reverse()
    .map(([startTimeMs, open, high, low, close, volume, turnover]) => ({
      time: new Date(Number(startTimeMs)),
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
    }));

  console.log(
    `[Bybit] Received ${candles.length} candles` +
      ` | ${candles[0].time.toISOString()} → ${candles.at(-1).time.toISOString()}`,
  );

  return candles;
}

// ─── MAPO core logic (matches Pine Script exactly) ───────────────────────────

/** Build cumulative-sum array (length = prices.length + 1, cumSum[0] = 0) */
function buildCumSum(prices) {
  const cum = new Array(prices.length + 1).fill(0);
  for (let i = 0; i < prices.length; i++) cum[i + 1] = cum[i] + prices[i];
  return cum;
}

/** SMA of last `period` values ending at bar index i (0-based) */
function smaAt(cumSum, i, period) {
  const end = i + 1;
  const start = end - period;
  if (start < 0) return NaN;
  return (cumSum[end] - cumSum[start]) / period;
}

/** Trailing SMA over an array; first (period-1) entries are NaN */
function smaArray(arr, period) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0,
    count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (!isNaN(arr[i])) {
      sum += arr[i];
      count++;
    }
    if (i >= period && !isNaN(arr[i - period])) {
      sum -= arr[i - period];
      count--;
    }
    if (count >= period) out[i] = sum / count;
  }
  return out;
}

/**
 * Calculate Proximity Index for every bar.
 * Replicates Pine's `len` variable with normalized=true.
 *
 * @param {number[]} closes
 * @returns {number[]} proximityIndex values (0–100 scale)
 */
function calcProximityIndex(closes) {
  const n = closes.length;
  const cumSum = buildCumSum(closes);
  const rawLen = new Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    const price = closes[i];
    let minDist = Infinity;
    let bestPer = NaN;

    for (let per = MIN_LEN; per <= MAX_LEN; per++) {
      const ma = smaAt(cumSum, i, per);
      if (isNaN(ma)) continue;
      const dist = Math.abs(price - ma);
      if (dist < minDist) {
        minDist = dist;
        bestPer = per;
      }
    }
    rawLen[i] = bestPer;
  }

  // Smooth with SMA(SMOOTH), then normalize
  const smoothed = smaArray(rawLen, SMOOTH);
  const denom = MAX_LEN - MIN_LEN + 1; // 96
  return smoothed.map((v) => (isNaN(v) ? NaN : ((v - MIN_LEN) / denom) * 100));
}

// ─── Alert / history logic ────────────────────────────────────────────────────

/**
 * Check current bar and collect the last 5 historical threshold touches.
 *
 * @param {number[]} proximityIndex
 * @param {Date[]}   timestamps
 * @returns {{ currentTriggered, current, history }}
 */
function checkAlerts(proximityIndex, timestamps) {
  const last = proximityIndex.length - 1;
  const curVal = proximityIndex[last];
  const currentTriggered = !isNaN(curVal) && curVal >= THRESHOLD;

  if (currentTriggered) {
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log(
      "║  🚨  MAPO ALERT — Proximity Index >= " + THRESHOLD + "          ║",
    );
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log(`║  Time  : ${timestamps[last].toISOString().padEnd(42)}║`);
    console.log(`║  Value : ${curVal.toFixed(2).padEnd(42)}║`);
    console.log("╚══════════════════════════════════════════════════════╝");
  }

  // Scan backwards (skip current bar) for up to 5 past triggers
  const history = [];
  for (let i = last - 1; i >= 0 && history.length < 10; i--) {
    const v = proximityIndex[i];
    history.push({
      barIndex: i,
      time: dayjs(timestamps[i])
        .tz("Australia/Brisbane")
        .format("YYYY-MM-DD HH:mm:ss"),
      value: parseFloat(v.toFixed(2)),
    });
  }

  return {
    currentTriggered,
    current: {
      barIndex: last,
      time: dayjs(timestamps[last])
        .tz("Australia/Brisbane")
        .format("YYYY-MM-DD HH:mm:ss"),
      value: isNaN(curVal) ? null : parseFloat(curVal.toFixed(2)),
    },
    history, // most-recent first
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function mapoBtcTop200(symbol = "BTCUSDT", interval = 5) {
  // Accept symbol & category from CLI args, e.g.:
  //   node mapo-proximity.js ETHUSDT linear
  //   node mapo-proximity.js BTCUSDT spot
  const category = "linear";

  let candles;
  try {
    candles = await fetchBybitKlines(symbol, category, LIMIT, interval);
  } catch (err) {
    console.error("[ERROR] Failed to fetch candles:", err.message);
    return;
  }

  const closes = candles.map((c) => c.close);
  const timestamps = candles.map((c) => c.time);

  const proximityIndex = calcProximityIndex(closes);
  const result = checkAlerts(proximityIndex, timestamps);

  const last8Indexes = result.history;

  const latestCandle = result.current.value;

  let isZero = false;
  let theZeroIndex = 0;

  let isSignalReady = false;

  if (latestCandle < 5) {
    for (const [idx, gg] of Object.entries(last8Indexes)) {
      if (parseInt(idx) >= 0 && parseInt(idx) < 5 && gg.value < 10) {
        isZero = true;
        theZeroIndex = parseInt(idx);
      }
    }
    if (isZero) {
      for (const [idx, gg] of Object.entries(last8Indexes)) {
        if (parseInt(idx) > theZeroIndex && gg.value > 75) {
          isSignalReady = true;
        }
      }
    }
  }
  if (isSignalReady) {
    await sendPushNotif(
      `ALERT ${symbol}: ${interval} minutes is Ready to Buy or Sell : ${result.current.value}`,
    );
  }

  /*
  if (result.currentTriggered || result.current.value >= THRESHOLD) {
    await set(`MAPO_START_${symbol}`, result.current.value);
    await sendPushNotif(
      `${symbol} MAPO Proximity ${interval} minutes coming to level : ${result.current.value}`,
    );
  } else if (result.current.value > 20 && result.current.value < 45) {
    const isSet = await get(`MAPO_START_${symbol}`);

    let didItTouched0 = false;

    for (const ff of last5Indexes) {
      if (ff < 4) didItTouched0 = true;
    }

    if (isSet && didItTouched0) {
      await sendPushNotif(
        `ALERT ${symbol}: ${interval} minutes is Ready to Buy or Sell : ${result.current.value}`,
      );
    }
  }
*/
  // ── Report ──────────────────────────────────────────────────────────────

  return result;
}

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const theRunnerTop200 = async () => {
  const coins = [
    "BTCUSDT",
    "ETHUSDT",
    "BNBUSDT",
    "SOLUSDT",
    "XRPUSDT",
    "ADAUSDT",
    "DOGEUSDT",
    "TRXUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "DOTUSDT",
    "SUIUSDT",
    "TONUSDT",
    "SHIBUSDT",
    "HBARUSDT",
    "BCHUSDT",
    "LTCUSDT",
    "UNIUSDT",
    "APTUSDT",
    "NEARUSDT",
    "PEPEUSDT",
    "ICPUSDT",
    "ETCUSDT",
    "AAVEUSDT",
    "ATOMUSDT",
    "VETUSDT",
    "ALGOUSDT",
    "FILUSDT",
    "MKRUSDT",
    "OPUSDT",
    "ARBUSDT",
    "INJUSDT",
    "SEIUSDT",
    "RUNEUSDT",
    "GRTUSDT",
    "THETAUSDT",
    "FLOWUSDT",
    "EGLDUSDT",
    "XTZUSDT",
    "MANAUSDT",
    "SANDUSDT",
    "AXSUSDT",
    "CHZUSDT",
    "CRVUSDT",
    "COMPUSDT",
    "SNXUSDT",
    "1INCHUSDT",
    "DYDXUSDT",
    "LDOUSDT",
    "KAVAUSDT",
    "ZECUSDT",
    "DASHUSDT",
    "ZILUSDT",
    "KSMUSDT",
    "ENJUSDT",
    "BATUSDT",
    "ZRXUSDT",
    "YFIUSDT",
    "ANKRUSDT",
    "HOTUSDT",
    "RSRUSDT",
    "OCEANUSDT",
    "SKLUSDT",
    "CELOUSDT",
    "ICXUSDT",
    "ONTUSDT",
    "QTUMUSDT",
    "IOTAUSDT",
    "NEOUSDT",
    "WAVESUSDT",
    "RVNUSDT",
    "SCUSDT",
    "DGBUSDT",
    "STORJUSDT",
    "COTIUSDT",
    "ARUSDT",
    "GMXUSDT",
    "MAGICUSDT",
    "BLURUSDT",
    "PENDLEUSDT",
    "JASMYUSDT",
    "ROSEUSDT",
    "CKBUSDT",
    "WOOUSDT",
    "LRCUSDT",
    "BANDUSDT",
    "MASKUSDT",
    "STXUSDT",
    "SUSHIUSDT",
    "HOOKUSDT",
    "PHBUSDT",
    "ACHUSDT",
    "FETUSDT",
    "AGIXUSDT",
    "OXTUSDT",
    "AUDIOUSDT",
    "STGUSDT",
    "API3USDT",
    "SSVUSDT",
    "ILVUSDT",
    "GALUSDT",
    "IDUSDT",
    "EDUUSDT",
    "XVSUSDT",
    "BALUSDT",
    "TWTUSDT",
    "TRBUSDT",
    "LPTUSDT",
    "FLUXUSDT",
    "HFTUSDT",
    "HIGHUSDT",
    "PEOPLEUSDT",
    "SPELLUSDT",
    "DUSKUSDT",
    "MTLUSDT",
    "SFPUSDT",
    "RENUSDT",
    "CELRUSDT",
    "NKNUSDT",
    "CHRUSDT",
    "CTSIUSDT",
    "ARPAUSDT",
    "ALPHAUSDT",
    "RLCUSDT",
    "KNCUSDT",
    "XEMUSDT",
    "TFUELUSDT",
    "IOSTUSDT",
    "ZENUSDT",
    "OMGUSDT",
    "BICOUSDT",
    "DARUSDT",
    "DENTUSDT",
    "KEYUSDT",
    "ATAUSDT",
    "FORTHUSDT",
    "C98USDT",
    "TLMUSDT",
    "POLYXUSDT",
    "RADUSDT",
    "MDTUSDT",
    "NMRUSDT",
    "PYRUSDT",
    "PORTALUSDT",
    "STRAXUSDT",
    "SXPUSDT",
    "AMPUSDT",
    "GALAUSDT",
    "LOKAUSDT",
    "MINAUSDT",
    "KDAUSDT",
    "ASTRUSDT",
    "DYMUSDT",
    "ALTUSDT",
    "PIXELUSDT",
    "MANTAUSDT",
    "AEVOUSDT",
    "JTOUSDT",
    "JUPUSDT",
    "WIFUSDT",
    "BONKUSDT",
    "MEMEUSDT",
    "NOTUSDT",
    "ENAUSDT",
    "OMUSDT",
    "TAOUSDT",
    "RENDERUSDT",
    "AKTUSDT",
    "TIAUSDT",
    "PYTHUSDT",
    "ZETAUSDT",
    "ALTUSDT",
    "STRKUSDT",
    "ACEUSDT",
    "XAIUSDT",
    "RONINUSDT",
    "TURBOUSDT",
    "MYROUSDT",
    "MOGUSDT",
    "POPCATUSDT",
    "MEWUSDT",
    "BOMEUSDT",
    "LISTAUSDT",
    "SAFEUSDT",
    "BBUSDT",
    "NEIROUSDT",
    "HMSTRUSDT",
    "CATIUSDT",
    "EIGENUSDT",
    "SCRUSDT",
    "LUMIAUSDT",
    "BANANAUSDT",
    "ARKMUSDT",
    "ORDIUSDT",
    "SATSUSDT",
    "1000PEPEUSDT",
    "1000BONKUSDT",
    "1000FLOKIUSDT",
    "FLOKIUSDT",
    "CFXUSDT",
    "CTKUSDT",
    "TRUUSDT",
    "BELUSDT",
    "REIUSDT",
    "XVGUSDT",
    "PHAUSDT",
    "PROMUSDT",
    "USTCUSDT",
    "SNTUSDT",
    "STEEMUSDT",
    "PERPUSDT",
    "SYNUSDT",
    "NTRNUSDT",
    "JOEUSDT",
    "CYBERUSDT",
  ];

  for (const symbol of coins) {
    try {
      await mapoBtcTop200(symbol, 5);
    } catch (err) {
      console.error("Error in mapo_btc_top200: ", err);
    }
    await sleep(1);
  }
};

module.exports = theRunnerTop200;
