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

const cron = require("node-cron");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

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

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

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

async function getInstruments() {
  const data = await apiFetch(`/v3/accounts/${ACCOUNT_ID}/instruments`);
  // filter to currency pairs only (type === 'CURRENCY')
  return data.instruments
    .filter((i) => i.type === "CURRENCY")
    .map((i) => i.name);
}

async function getLastCandle(instrument) {
  // count=2 → get last 2 completed candles; we use index [0] (second-to-last)
  // so we always have a *closed* candle, not the currently forming one.
  const encoded = encodeURIComponent(instrument);
  const data = await apiFetch(
    `/v3/instruments/${encoded}/candles?granularity=M30&count=2&price=M`,
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

async function main() {
  console.log(`\n🔍  OANDA Currency Scanner  [${OANDA_ENV.toUpperCase()}]`);
  console.log(
    `📊  Timeframe: 30 Minute  |  Metric: (High − Low) / Low × 100\n`,
  );

  // 1. fetch instrument list
  process.stdout.write("⏳  Fetching instruments… ");
  const instruments = await getInstruments();
  console.log(`${instruments.length} currency pairs found.\n`);

  // 2. fetch last candle for each instrument (throttled to avoid 429s)
  const results = [];
  const BATCH = 10; // parallel requests per batch

  for (let i = 0; i < instruments.length; i += BATCH) {
    const batch = instruments.slice(i, i + BATCH);
    process.stdout.write(
      `\r⏳  Fetching candles… ${Math.min(i + BATCH, instruments.length)}/${instruments.length}`,
    );

    const settled = await Promise.allSettled(batch.map(getLastCandle));
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value) {
        const { instrument, high, low, open, close, time } = r.value;
        const change = pct(low, high);
        // direction based on candle colour (close vs open)
        const direction = close >= open ? 1 : -1;
        results.push({
          instrument,
          change,
          direction,
          high,
          low,
          open,
          close,
          time,
        });
      }
    }

    // small delay between batches
    if (i + BATCH < instruments.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  console.log("\n");

  // 3. sort descending by absolute % range
  results.sort((a, b) => b.change - a.change);

  const maxChange = results[0]?.change ?? 1;

  // 4. print table
  const colW = 12;
  console.log(
    "Rank".padEnd(5) +
      "Instrument".padEnd(colW) +
      "Range %".padStart(9) +
      "  " +
      "Bar".padEnd(22) +
      "Candle    " +
      "Candle Time (UTC)",
  );
  console.log("─".repeat(85));

  results.forEach(async (r, idx) => {
    const rank = String(idx + 1).padEnd(5);
    const symbol = r.instrument.padEnd(colW);
    const rangePct = `${r.change.toFixed(4)}%`.padStart(9);
    const barStr = bar(r.change, maxChange);
    const candle = r.direction >= 0 ? "🟢 Bull" : "🔴 Bear";
    const timeStr = new Date(r.time)
      .toISOString()
      .replace("T", " ")
      .slice(0, 16);

    if (idx < 10) {
      await sendSignalAlert(
        r.direction >= 0 ? "BUY" : "SELL",
        r.instrument,
        r.change,
        {
          time: dayjs(r.time)
            .tz("Australia/Brisbane")
            .format("YYYY-MM-DD HH:mm:ss"),
          momentum: "high_momentum",
        },
      );
      sleep(1);
    }
    console.log(
      rank +
        colorize(symbol, r.direction) +
        colorize(rangePct, r.direction) +
        "  " +
        colorize(barStr, r.direction) +
        "  " +
        candle +
        "  " +
        timeStr,
    );
  });

  console.log("\n" + "─".repeat(85));
  console.log(
    `✅  Scanned ${results.length} pairs. Top mover: ${results[0]?.instrument} (${results[0]?.change.toFixed(4)}%)`,
  );
  console.log();
}

cron.schedule("*/30 * * * *", async () => {
  await main();
});
