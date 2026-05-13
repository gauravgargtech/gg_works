/**
 * SVMKR_UT_HMA_ORB — Node.js + Oanda v20 API
 *
 * Fetches real OHLCV candles from Oanda and runs:
 *   • UT Bot  (Key=23, ATR Period=10)
 *   • Hull Moving Average (Period=31)
 *   • Open Range Breakout (configurable session)
 *
 * Usage:
 *   OANDA_API_KEY=your_token OANDA_ACCOUNT_ID=xxx-xxx-xxx-xxx node svmkr_ut_hma_oanda.js
 *
 * Or edit CONFIG below directly.
 */

// ─────────────────────────────────────────────
// CONFIG — edit here or use env vars
// ─────────────────────────────────────────────
require("../config/config");
const process = require("process");

const { set } = require("../adapters/redis");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { getInstruments } = require("../exhanges/oanda");
const { insert, find } = require("../adapters/mongo");
const cron = require("node-cron");

dayjs.extend(utc);
dayjs.extend(timezone);

const CONFIG = {
  // Oanda credentials
  apiKey: process.env.OANDA_API_KEY || "YOUR_API_TOKEN_HERE",
  accountId: process.env.OANDA_ACCOUNT_ID || "YOUR_ACCOUNT_ID_HERE",

  // true = live (api-fxtrade.oanda.com), false = demo (api-fxpractice.oanda.com)
  live: process.env.OANDA_LIVE === "true" ? true : false,

  // Instrument & timeframe
  instrument: process.env.OANDA_INSTRUMENT || "EUR_USD",
  granularity: process.env.OANDA_GRANULARITY || "M5", // M1 M5 M15 H1 H4 D etc.
  count: parseInt(process.env.OANDA_COUNT || "100000"), // candles to fetch (max 5000)

  // UT Bot parameters (your settings)
  utKeyValue: 19,
  utAtrPeriod: 1,

  // HMA
  hmaPeriod: 31,

  // ORB session (IANA timezone + HH:MM window)
  orbStart: "00:05",
  orbEnd: "23:55",
  orbTimezone: "Australia/Brisbane",
};

// ─────────────────────────────────────────────
// OANDA API CLIENT
// ─────────────────────────────────────────────

const BASE_URL = CONFIG.live
  ? "https://api-fxtrade.oanda.com"
  : "https://api-fxpractice.oanda.com";

/**
 * Fetch candles from Oanda v20 REST API.
 * Returns array of { time, open, high, low, close, volume }
 */
async function fetchOandaCandles(instrument, granularity, count) {
  const MAX = 5000;
  let all = [];
  let to = new Date().toISOString();
  const totalCandles = count;

  while (all.length < totalCandles) {
    const count = Math.min(MAX, totalCandles - all.length);

    const url = `${BASE_URL}/v3/instruments/${instrument}/candles?count=${count}&granularity=${granularity}&price=M&to=${to}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${CONFIG.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Oanda API error ${res.status}: ${err}`);
    }

    const data = await res.json();

    const candles = data.candles
      .filter((c) => c.complete)
      .map((c) => ({
        time: new Date(c.time).getTime(),
        open: parseFloat(c.mid.o),
        high: parseFloat(c.mid.h),
        low: parseFloat(c.mid.l),
        close: parseFloat(c.mid.c),
        volume: c.volume,
      }));

    if (candles.length === 0) break;

    // prepend (since we are going backward)
    all = [...candles, ...all];

    // move window backward
    to = data.candles[0].time;

    // safety break
    if (candles.length < MAX) break;

    // avoid rate limit (important for large pulls)
    await new Promise((r) => setTimeout(r, 200));
  }

  return all;
}

// ─────────────────────────────────────────────
// MATH HELPERS
// ─────────────────────────────────────────────

function trueRange(candle, prevClose) {
  if (prevClose == null) return candle.high - candle.low;
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - prevClose),
    Math.abs(candle.low - prevClose),
  );
}

/** Wilder's ATR — matches Pine's atr() */
function calcATRSeries(candles, period) {
  const tr = candles.map((c, i) =>
    trueRange(c, i > 0 ? candles[i - 1].close : null),
  );
  const atr = new Array(candles.length).fill(null);

  if (candles.length >= period) {
    atr[period - 1] = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < candles.length; i++) {
      atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }
  }
  return atr;
}

/** WMA — matches Pine's wma() */
function calcWMASeries(values, period) {
  const wma = new Array(values.length).fill(null);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let num = 0;
    for (let j = 0; j < period; j++) num += (values[i - j] ?? 0) * (period - j);
    wma[i] = num / denom;
  }
  return wma;
}

// ─────────────────────────────────────────────
// UT BOT
// ─────────────────────────────────────────────

function calcUTBot(candles, keyValue, atrPeriod) {
  const closes = candles.map((c) => c.close);
  const atrSeries = calcATRSeries(candles, atrPeriod);
  const results = [];

  let prevStop = 0,
    prevPos = 0,
    prevSrc = null;

  for (let i = 0; i < candles.length; i++) {
    const src = closes[i];
    const atr = atrSeries[i];
    const nLoss = atr != null ? keyValue * atr : null;

    if (nLoss == null) {
      results.push({
        stop: null,
        pos: 0,
        buy: false,
        sell: false,
        atr,
        nLoss,
        barBuy: false,
        barSell: false,
      });
      prevSrc = src;
      continue;
    }

    // Pine's iff chain for xATRTrailingStop
    let stop;
    if (src > prevStop && prevSrc != null && prevSrc > prevStop) {
      stop = Math.max(prevStop, src - nLoss);
    } else if (src < prevStop && prevSrc != null && prevSrc < prevStop) {
      stop = Math.min(prevStop, src + nLoss);
    } else if (src > prevStop) {
      stop = src - nLoss;
    } else {
      stop = src + nLoss;
    }

    // Position
    let pos;
    if (prevSrc != null && prevSrc < prevStop && src > prevStop) {
      pos = 1;
    } else if (prevSrc != null && prevSrc > prevStop && src < prevStop) {
      pos = -1;
    } else {
      pos = prevPos;
    }

    // ema(src,1) == src in Pine
    const above = prevSrc != null && prevSrc <= prevStop && src > stop;
    const below = prevSrc != null && prevSrc >= prevStop && src < stop;

    results.push({
      close: src,
      atr,
      nLoss,
      stop,
      pos,
      buy: src > stop && above,
      sell: src < stop && below,
      barBuy: src > stop,
      barSell: src < stop,
    });

    prevStop = stop;
    prevPos = pos;
    prevSrc = src;
  }

  return results;
}

// ─────────────────────────────────────────────
// HULL MOVING AVERAGE
// ─────────────────────────────────────────────

function calcHMA(candles, period) {
  const closes = candles.map((c) => c.close);
  const halfPeriod = Math.round(period / 2);
  const sqrtPeriod = Math.round(Math.sqrt(period));

  const wmaHalf = calcWMASeries(closes, halfPeriod);
  const wmaFull = calcWMASeries(closes, period);

  const diff = wmaHalf.map((v, i) =>
    v != null && wmaFull[i] != null ? 2 * v - wmaFull[i] : null,
  );

  const hma = calcWMASeries(diff, sqrtPeriod);

  const hmaColor = hma.map((v, i) => {
    if (v == null) return null;
    const prev = i > 0 ? hma[i - 1] : null;
    if (prev == null) return "blue";
    return v > prev ? "green" : "red";
  });

  return { hma, hmaColor };
}

// ─────────────────────────────────────────────
// OPEN RANGE BREAKOUT
// ─────────────────────────────────────────────

function calcORB(
  candles,
  sessionStart = "10:10",
  sessionEnd = "10:15",
  timezone = "Australia/Brisbane",
) {
  const [startH, startM] = sessionStart.split(":").map(Number);
  const [endH, endM] = sessionEnd.split(":").map(Number);

  const inSession = (ts) => {
    const local = new Date(
      new Date(ts).toLocaleString("en-US", { timeZone: timezone }),
    );
    const mins = local.getHours() * 60 + local.getMinutes();
    return mins >= startH * 60 + startM && mins < endH * 60 + endM;
  };

  const orbResults = [];
  let orbHigh = null,
    orbLow = null,
    prevInSess = false;

  for (const candle of candles) {
    const ts =
      typeof candle.time === "object" ? candle.time.getTime() : candle.time;
    const sess = inSession(ts);
    const isFirst = sess && !prevInSess;

    if (isFirst) {
      orbHigh = candle.high;
      orbLow = candle.low;
    } else if (sess) {
      if (orbHigh != null && candle.high > orbHigh) orbHigh = candle.high;
      if (orbLow != null && candle.low < orbLow) orbLow = candle.low;
    }

    orbResults.push({ orbHigh, orbLow, inSession: sess });
    prevInSess = sess;
  }

  return orbResults;
}

// ─────────────────────────────────────────────
// COMBINE ALL INDICATORS
// ─────────────────────────────────────────────

function runIndicators(candles, opts = {}) {
  const {
    utKeyValue = 24,
    utAtrPeriod = 10,
    hmaPeriod = 31,
    orbStart = "10:10",
    orbEnd = "10:15",
    orbTimezone = "Australia/Brisbane",
  } = opts;

  const ut = calcUTBot(candles, utKeyValue, utAtrPeriod);
  const { hma, hmaColor } = calcHMA(candles, hmaPeriod);
  const orb = calcORB(candles, orbStart, orbEnd, orbTimezone);

  return candles.map((candle, i) => ({
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,

    // UT Bot
    atr: ut[i].atr,
    nLoss: ut[i].nLoss,
    utStop: ut[i].stop,
    utPos: ut[i].pos, // 1=long, -1=short, 0=flat
    utBuy: ut[i].buy,
    utSell: ut[i].sell,
    barBuy: ut[i].barBuy,
    barSell: ut[i].barSell,

    // HMA
    hma: hma[i],
    hmaColor: hmaColor[i], // 'green' | 'red' | 'blue' | null

    // ORB
    orbHigh: orb[i].orbHigh,
    orbLow: orb[i].orbLow,
    inOrbSess: orb[i].inSession,
  }));
}

// ─────────────────────────────────────────────
// PRINT HELPERS
// ─────────────────────────────────────────────

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function pad(str, len) {
  return String(str ?? "—").padEnd(len);
}
function fmt(n, dec = 5) {
  return n != null ? n.toFixed(dec) : "—";
}

function printResults(results, instrument, granularity) {
  const signals = results.filter((r) => r.utBuy || r.utSell);
  /*
  console.log(
    `\n${BOLD}${CYAN}═══════════════════════════════════════════════════════════════════${RESET}`,
  );
  console.log(
    `${BOLD}  SVMKR UT Bot + HMA + ORB  │  ${instrument}  │  ${granularity}${RESET}`,
  );
  console.log(
    `${BOLD}${CYAN}═══════════════════════════════════════════════════════════════════${RESET}`,
  );
  console.log(
    `${DIM}  UT Key=${CONFIG.utKeyValue}  ATR Period=${CONFIG.utAtrPeriod}  HMA Period=${CONFIG.hmaPeriod}${RESET}`,
  );
  console.log(
    `${DIM}  ${results.length} candles fetched  │  ${signals.length} signals found${RESET}`,
  );
  console.log(
    `${BOLD}${CYAN}───────────────────────────────────────────────────────────────────${RESET}`,
  );

  // Header
  console.log(
    BOLD +
      pad("Time (UTC)", 22) +
      pad("Close", 12) +
      pad("UT Stop", 12) +
      pad("ATR", 10) +
      pad("Pos", 6) +
      pad("Signal", 10) +
      pad("HMA", 12) +
      pad("HMA Dir", 9) +
      RESET,
  );
  console.log("─".repeat(95));
*/
  // Only print last 50 rows (full data available in returned array)
  const display = results.slice(-50);
  for (const r of display) {
    const time = new Date(r.time).toISOString().replace("T", " ").slice(0, 19);
    const sig = r.utBuy
      ? `${GREEN}▲ BUY${RESET}  `
      : r.utSell
        ? `${RED}▼ SELL${RESET} `
        : `${DIM}—${RESET}      `;
    const posStr =
      r.utPos === 1
        ? `${GREEN}LONG${RESET} `
        : r.utPos === -1
          ? `${RED}SHORT${RESET}`
          : `${DIM}FLAT${RESET} `;
    const hmaCol =
      r.hmaColor === "green" ? GREEN : r.hmaColor === "red" ? RED : DIM;

    /*
    console.log(
      pad(time, 22) +
        pad(fmt(r.close), 12) +
        pad(fmt(r.utStop), 12) +
        pad(fmt(r.atr, 6), 10) +
        posStr +
        "  " +
        sig +
        pad(fmt(r.hma), 12) +
        hmaCol +
        pad(r.hmaColor ?? "—", 9) +
        RESET,
    );
    */
  }

  const theSignals = [];

  // Signal summary
  if (signals.length > 0) {
    for (const r of signals) {
      const time = dayjs(r.time)
        .tz("Australia/Brisbane")
        .format("YYYY-MM-DD HH:mm:ss");
      //const brisbane_time = now.format("YYYY-MM-DD HH:mm:ss");

      const timestamp = dayjs(r.time).tz("Australia/Brisbane").unix();

      const label = r.utBuy ? `BUY` : `SELL`;
      const hmaCtx =
        r.hmaColor === "green"
          ? `HMA UP`
          : r.hmaColor === "red"
            ? `HMA DOWN`
            : "HMA—";
      /*
      console.log(
        `  ${time}  ${label}  close=${fmt(r.close)}  stop=${fmt(r.utStop)}  ${hmaCtx}`,
      );
      */
      theSignals.push({
        time,
        label,
        close: fmt(r.close),
        stop: fmt(r.utStop),
        hmaCtx,
        timestamp,
      });
    }
  } else {
    console.log(
      `\n${YELLOW}  No signals in this window. Try a larger count or different instrument.${RESET}`,
    );
  }

  return theSignals;
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main() {
  const { instrument, granularity, count } = CONFIG;

  // Basic config check
  if (CONFIG.apiKey === "YOUR_API_TOKEN_HERE") {
    console.error(
      `\n${RED}${BOLD}ERROR:${RESET} Set your Oanda API key via env var or CONFIG.`,
    );
    console.error(
      `  ${YELLOW}OANDA_API_KEY=<token> OANDA_ACCOUNT_ID=<id> node svmkr_ut_hma_oanda.js${RESET}\n`,
    );
    process.exit(1);
  }
  /*
  console.log(
    `\n${CYAN}Fetching ${count} × ${granularity} candles for ${instrument} from Oanda...${RESET}`,
  );
*/
  const candles = await fetchOandaCandles(instrument, granularity, count);
  /*
  console.log(
    `${GREEN}✓ ${candles.length} completed candles received.${RESET}`,
  );
*/
  const results = runIndicators(candles, {
    utKeyValue: CONFIG.utKeyValue,
    utAtrPeriod: CONFIG.utAtrPeriod,
    hmaPeriod: CONFIG.hmaPeriod,
    orbStart: CONFIG.orbStart,
    orbEnd: CONFIG.orbEnd,
    orbTimezone: CONFIG.orbTimezone,
  });

  const theSignals = printResults(results, instrument, granularity);

  // Return full results for programmatic use
  return theSignals;
}

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

const logSignalsInMongo = async () => {
  //const instruments = await getInstruments();

  //CURRENCY, CFD, METAL
  //const allSymbols = instruments.map((i) => i.name);

  const completeData = [];
  const lastSignals = {};

  const instruments = Object.keys(FOREX_PAIRS_CONFIG);

  for (const inst of instruments) {
    CONFIG.instrument = inst;
    CONFIG.utKeyValue = FOREX_PAIRS_CONFIG[inst].utKeyValue;
    CONFIG.utAtrPeriod = FOREX_PAIRS_CONFIG[inst].utAtrPeriod;

    CONFIG.count = 2000;
    console.log("Starting to fetch signals for", inst);
    const data = await main();
    if (data.length > 0) {
      lastSignals[inst] = data[data.length - 1];
    }
    //completeData.push({ symbol: inst, signals: data });
    await sleep(1);
    //await set(`${inst}_signals`, JSON.stringify(data));
  }

  for (const [key, value] of Object.entries(lastSignals)) {
    const date1 = dayjs().tz("Australia/Brisbane");
    const date2 = dayjs.unix(value.timestamp);

    console.log(date1);
    console.log(date2);
    console.log(date1.diff(date2, "minute"));
    if (date1.diff(date2, "minute") >= 4 && date1.diff(date2, "minute") <= 20) {
      value.symbol = key;
      await insert("signals", value);
    }
  }

  return allSymbols;
};

module.exports = logSignalsInMongo;
