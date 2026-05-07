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

const { request } = require("../exhanges/oanda");
const cron = require("node-cron");

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

async function getInstruments() {
  return FOREX_PAIRS;
  const data = await apiFetch(`/v3/accounts/${ACCOUNT_ID}/instruments`);
  // filter to currency pairs only (type === 'CURRENCY')
  return data.instruments
    .filter((i) => i.type === "CURRENCY")
    .map((i) => i.name);
}

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function getLastCandle(instrument) {
  // count=2 → get last 2 completed candles; we use index [0] (second-to-last)
  // so we always have a *closed* candle, not the currently forming one.
  const encoded = encodeURIComponent(instrument);

  const data = await request(
    "GET",
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

async function checkMomentum() {
  console.log(`\n🔍  OANDA Currency Scanner  [${OANDA_ENV.toUpperCase()}]`);
  console.log(
    `📊  Timeframe: 30 Minute  |  Metric: (High − Low) / Low × 100\n`,
  );

  //await sleep(30);

  // 1. fetch instrument list
  process.stdout.write("⏳  Fetching instruments… ");
  const instruments = await getInstruments();
  console.log(`${instruments.length} currency pairs found.\n`);

  // 2. fetch last candle for each instrument (throttled to avoid 429s)
  const results = [];
  const BATCH = 10; // parallel requests per batch

  const percentages = {};
  for (const inst of instruments) {
    const lastCandle = await getLastCandle(inst);

    const percentage = pct(lastCandle.low, lastCandle.high);
    percentages[inst] = {
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
      if (diffMinutes <= 1500 && sortedRecords[0].label === dir) {
        finalSymbols[idx] = inst;
        sortedDesc[idx].direction = dir;
        sortedDesc[idx].time_of_signal = sortedRecords[0].time;
      }
    }
  }

  /*
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
*/

  console.log("\n" + "─".repeat(85));
  console.log(finalSymbols);

  for (const [idx, inst] of Object.entries(finalSymbols)) {
    console.log(inst);
    await sendSignalAlert(
      inst.direction >= 0 ? "BUY" : "SELL",
      inst.instrument,
      inst.close,
      {
        percentage: inst.percentage,
        momentum: "high_momentum",
        time_of_signal: inst.time_of_signal,
      },
    );
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
