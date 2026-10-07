/**
 * OANDA Demo API - 4H EMA 200 Scanner
 *
 * Fetches all tradeable instruments, computes the 4-hour EMA(200) for each,
 * then ranks them by how close the current mid-price is to that EMA.
 *
 * Usage:
 *   OANDA_API_KEY=your_demo_api_key OANDA_ACCOUNT_ID=your_account_id node oanda_ema200.js
 *
 * Optional env vars:
 *   OANDA_BASE_URL  (default: https://api-fxpractice.oanda.com)
 */
require("../config/config");
const BASE_URL =
  process.env.OANDA_BASE_URL || "https://api-fxpractice.oanda.com";
const API_KEY = process.env.OANDA_API_KEY;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const { getInstruments } = require("../exhanges/oanda");

const EMA_PERIOD = 200;
const GRANULARITY = "H4"; // 4-hour candles
const CANDLE_COUNT = 300; // fetch extra so EMA has enough history to warm up
const { set } = require("../adapters/redis");

// ─── Validation ──────────────────────────────────────────────────────────────

if (!API_KEY || !ACCOUNT_ID) {
  console.error(
    "❌  Missing env vars.\n" +
      "    Set OANDA_API_KEY and OANDA_ACCOUNT_ID before running.\n" +
      "    Example:\n" +
      "      OANDA_API_KEY=xxx OANDA_ACCOUNT_ID=yyy node oanda_ema200.js",
  );
  process.exit(1);
}

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));
// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function oandaGet(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OANDA ${res.status} on ${path}: ${body}`);
  }

  return res.json();
}

// ─── EMA calculation ─────────────────────────────────────────────────────────

/**
 * Calculate EMA for a series of closing prices.
 * Returns the final (most recent) EMA value.
 */
function calcEMA(closes, period) {
  if (closes.length < period) return null;

  const k = 2 / (period + 1);

  // Seed with SMA of first `period` values
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }

  return ema;
}

// ─── Fetch candles ───────────────────────────────────────────────────────────

async function fetchCandles(instrument) {
  const path =
    `/v3/instruments/${instrument}/candles` +
    `?granularity=${GRANULARITY}&count=${CANDLE_COUNT}&price=M`; // M = mid prices

  const data = await oandaGet(path);
  return data.candles; // array of { mid: { o,h,l,c }, complete, time }
}

// ─── Concurrency-limited mapper ───────────────────────────────────────────────

async function mapWithConcurrency(items, fn, concurrency = 10) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function checkEmaCloseness() {
  console.log(
    `\n🔍  Fetching instruments from OANDA demo (account ${ACCOUNT_ID})…\n`,
  );
  await sleep(20);

  const instruments = await getInstruments();
  console.log(
    `📋  Found ${instruments.length} instruments. Fetching ${GRANULARITY} candles…\n`,
  );

  const rows = [];
  let done = 0;

  await mapWithConcurrency(
    instruments,
    async (inst) => {
      const name = inst.name;
      try {
        const candles = await fetchCandles(name);

        // Only use completed candles (exclude the in-progress one)
        const completed = candles.filter((c) => c.complete);

        if (completed.length < EMA_PERIOD) {
          // Not enough history
          done++;
          return;
        }

        const closes = completed.map((c) => parseFloat(c.mid.c));
        const ema200 = calcEMA(closes, EMA_PERIOD);

        // Current price = close of the most-recent completed candle
        const currentPrice = closes[closes.length - 1];

        // Percentage difference: (current - ema) / ema * 100
        const pctDiff = ((currentPrice - ema200) / ema200) * 100;

        rows.push({
          instrument: name,
          displayName: inst.displayName || name,
          type: inst.type,
          currentPrice,
          ema200,
          pctDiff,
          absPctDiff: Math.abs(pctDiff),
        });
      } catch (err) {
        // Some instruments may not support candles (e.g. CFD-only)
        // Silently skip them
      }

      done++;
      if (done % 20 === 0 || done === instruments.length) {
        process.stdout.write(
          `\r   ⏳  Processed ${done} / ${instruments.length}`,
        );
      }
    },
    10, // max 10 concurrent requests
  );

  console.log("\n");

  if (rows.length === 0) {
    console.error("❌  No valid results. Check your API key and account ID.");
    process.exit(1);
  }

  // Sort ascending by absolute percentage difference (closest to EMA first)
  rows.sort((a, b) => a.absPctDiff - b.absPctDiff);

  // ─── Output ───────────────────────────────────────────────────────────────

  const RANK_W = 5;
  const INST_W = 22;
  const PRICE_W = 14;
  const EMA_W = 14;
  const PCT_W = 12;

  const header =
    "Rank".padEnd(RANK_W) +
    "Instrument".padEnd(INST_W) +
    "Current Price".padStart(PRICE_W) +
    "4H EMA(200)".padStart(EMA_W) +
    "% Diff".padStart(PCT_W) +
    "  Direction";

  const sep = "─".repeat(header.length);

  console.log(
    `\n📊  4H EMA(200) Distance Ranking  (${rows.length} instruments, ascending % diff)\n`,
  );
  console.log(sep);
  console.log(header);
  console.log(sep);

  rows.forEach(async (r, i) => {
    const direction = r.pctDiff >= 0 ? "▲ Above" : "▼ Below";
    const pctStr = (r.pctDiff >= 0 ? "+" : "") + r.pctDiff.toFixed(4) + "%";

    if (r.pctDiff >= 0) {
      await set(`${r.instrument}_ema_direction`, "BUY");
    } else {
      await set(`${r.instrument}_ema_direction`, "SELL");
    }

    console.log(
      `${String(i + 1).padEnd(RANK_W)}` +
        `${r.instrument.padEnd(INST_W)}` +
        `${r.currentPrice.toPrecision(7).padStart(PRICE_W)}` +
        `${r.ema200.toPrecision(7).padStart(EMA_W)}` +
        `${pctStr.padStart(PCT_W)}  ${direction}`,
    );
  });

  console.log(sep);
  console.log(`\n✅  Done. Top 5 closest to their 4H EMA(200):\n`);
  rows.slice(0, 5).forEach((r, i) => {
    console.log(
      `  ${i + 1}. ${r.instrument}  →  ${Math.abs(r.pctDiff).toFixed(4)}% ${r.pctDiff >= 0 ? "above" : "below"} EMA`,
    );
  });
  console.log();
}

module.exports = checkEmaCloseness;
