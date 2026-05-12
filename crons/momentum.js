#!/usr/bin/env node

/**
 * OANDA Currency Scanner
 * Scans all currency instruments at 1H timeframe and shows
 * % change from low to high of the last completed candle,
 * sorted descending by absolute move.
 *
 * Usage:
 *   OANDA_API_KEY=your_key OANDA_ACCOUNT_ID=your_account_id node oanda-scanner.js
 *
 * Optional env vars:
 *   OANDA_ENV=practice   (default) | live
 */
require("../config/config");

const API_KEY = process.env.OANDA_API_KEY;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const OANDA_ENV = process.env.OANDA_ENV || "practice";

const { request, getInstruments } = require("../exhanges/oanda");
const cron = require("node-cron");

const redis = require("../adapters/redis");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

const { find } = require("../adapters/mongo");

dayjs.extend(utc);
dayjs.extend(timezone);

const { sendSignalAlert } = require("../config/telegram_notify");

if (!API_KEY || !ACCOUNT_ID) {
  console.error(
    "❌  Missing env vars. Set OANDA_API_KEY and OANDA_ACCOUNT_ID.",
  );
  process.exit(1);
}

const BASE_URL =
  OANDA_ENV === "live"
    ? "https://api-fxtrade.oanda.com"
    : "https://api-fxpractice.oanda.com";

const HEADERS = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

// ── helpers ────────────────────────────────────────────────────────────────

async function apiFetch(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OANDA ${res.status} – ${path}\n${body}`);
  }
  return res.json();
}

function pct(low, high) {
  // percentage move from low to high of the candle
  return ((high - low) / low) * 100;
}

function bar(value, max, width = 20) {
  const filled = Math.round((Math.abs(value) / max) * width);
  return "█".repeat(filled).padEnd(width);
}

function colorize(str, value) {
  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const RESET = "\x1b[0m";
  return value >= 0 ? `${GREEN}${str}${RESET}` : `${RED}${str}${RESET}`;
}

// ── main ───────────────────────────────────────────────────────────────────

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function getLastCandle(instrument) {
  // count=2 → get last 2 completed candles; we use index [0] (second-to-last)
  // so we always have a *closed* candle, not the currently forming one.
  const encoded = encodeURIComponent(instrument);

  const data = await request(
    "GET",
    `/v3/instruments/${encoded}/candles?granularity=M15&count=2&price=M`,
  );

  const candles = data.candles.filter((c) => c.complete);
  if (!candles.length) return null;
  const c = candles[candles.length - 1]; // last complete candle
  return {
    instrument,
    time: c.time,
    open: parseFloat(c.mid.o),
    high: parseFloat(c.mid.h),
    low: parseFloat(c.mid.l),
    close: parseFloat(c.mid.c),
  };
}

async function checkMomentum() {
  console.log(`\n🔍  OANDA Currency Scanner  [${OANDA_ENV.toUpperCase()}]`);
  console.log(
    `📊  Timeframe: 15 Minute  |  Metric: (High − Low) / Low × 100\n`,
  );

  await sleep(60);

  // 1. fetch instrument list
  process.stdout.write("⏳  Fetching instruments… ");
  const instruments = await getInstruments();
  console.log(`${instruments.length} currency pairs found.\n`);

  // 2. fetch last candle for each instrument (throttled to avoid 429s)
  const results = [];
  const BATCH = 10; // parallel requests per batch

  const percentages = {};
  for (const inst of instruments) {
    const lastCandle = await getLastCandle(inst.name);

    const percentage = pct(lastCandle.low, lastCandle.high);
    percentages[inst.name] = {
      ...lastCandle,
      percentage,
    };
    sleep(1);
  }

  const sortedDesc = Object.fromEntries(
    Object.entries(percentages).sort(
      (a, b) => b[1].percentage - a[1].percentage,
    ),
  );

  const finalSymbols = {};

  for (const [idx, inst] of Object.entries(sortedDesc)) {
    const records = await find("signals", { symbol: idx });
    if (records.length > 0) {
      const sortedRecords = records.sort((a, b) => b.timestamp - a.timestamp);

      const diffMinutes = dayjs()
        .tz("Australia/Brisbane")
        .diff(dayjs(sortedRecords[0].time).tz("Australia/Brisbane"), "minute");

      let dir = "";
      if (inst.close > inst.open) {
        dir = "BUY";
      } else if (inst.close < inst.open) {
        dir = "SELL";
      }

      if (diffMinutes <= 1000 && sortedRecords[0].label === dir) {
        finalSymbols[idx] = inst;
        sortedDesc[idx].direction = dir;
        sortedDesc[idx].signal_price = sortedRecords[0].close;
        sortedDesc[idx].time_of_signal = sortedRecords[0].time;
      }
    }
  }

  console.log("\n" + "─".repeat(85));
  console.log(finalSymbols);

  for (const [idx, inst] of Object.entries(finalSymbols)) {
    const isRedisCache = await redis.get(`momentum_${inst.instrument}`);
    const emaDirection = await redis.get(`${inst.instrument}_ema_direction`);

    if (!FOREX_PAIRS.includes(inst.instrument)) {
      continue;
    }

    if (!isRedisCache && emaDirection === inst.direction) {
      await sendSignalAlert(
        inst.direction,
        inst.instrument,
        inst.signal_price,
        {
          percentage: inst.percentage,
          momentum: "high_momentum",
          time: inst.time_of_signal,
        },
      );
      await redis.set(`momentum_${inst.instrument}`, "oks");
    }
    sleep(1);
  }

  console.log("\n" + "─".repeat(85));
  console.log(
    `✅  Scanned ${finalSymbols.length} pairs. Top mover: ${finalSymbols[0]?.instrument} (${finalSymbols[0]?.percentage.toFixed(4)}%)`,
  );
  console.log();
}

module.exports = checkMomentum;

//checkMomentum();
