#!/usr/bin/env node

/**
 * OANDA EMA 21/50 Crossover Scanner
 * Timeframe: H4 (4-hour candles)
 * EMA 21 = fast, EMA 50 = slow
 *
 * Usage:
 *   node oanda-ema-scanner.js
 *
 * Set your credentials via environment variables:
 *   OANDA_API_KEY=your_api_key
 *   OANDA_ACCOUNT_ID=your_account_id
 *   OANDA_ENV=practice   (or "live")
 */

require("../config/config");
const process = require("process");
const OANDA_API_KEY = process.env.OANDA_API_KEY || "YOUR_API_KEY_HERE";
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID || "YOUR_ACCOUNT_ID_HERE";
const OANDA_ENV = process.env.OANDA_ENV || "practice"; // 'practice' or 'live'
const { sendSignalAlert } = require("../config/telegram_notify");
const cron = require("node-cron");

const BASE_URL =
  OANDA_ENV === "live"
    ? "https://api-fxtrade.oanda.com"
    : "https://api-fxpractice.oanda.com";

const GRANULARITY = "H4";
const CANDLE_COUNT = 150; // needs at least 51 for EMA-50
const EMA_FAST = 21;
const EMA_SLOW = 50;

const PAIRS = FOREX_PAIRS;

// ─── EMA calculation ───────────────────────────────────────────────────────────

function calcEMASeries(closes, period) {
  const k = 2 / (period + 1);
  const ema = new Array(closes.length);
  ema[0] = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function detectCrossover(closes) {
  const ema21 = calcEMASeries(closes, EMA_FAST);
  const ema50 = calcEMASeries(closes, EMA_SLOW);
  const n = closes.length;

  const curFast = ema21[n - 1];
  const curSlow = ema50[n - 1];
  const prevFast = ema21[n - 2];
  const prevSlow = ema50[n - 2];

  let signal = "none";
  if (prevFast <= prevSlow && curFast > curSlow) signal = "bullish";
  else if (prevFast >= prevSlow && curFast < curSlow) signal = "bearish";

  return { ema21: curFast, ema50: curSlow, signal };
}

// ─── OANDA API fetch ───────────────────────────────────────────────────────────

async function fetchCandles(pair) {
  const url = `${BASE_URL}/v3/instruments/${pair}/candles?granularity=${GRANULARITY}&count=${CANDLE_COUNT}&price=M`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${OANDA_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }

  const data = await res.json();
  // only use completed candles
  return data.candles.filter((c) => c.complete).map((c) => parseFloat(c.mid.c));
}

// ─── Output helpers ────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";

function pad(str, len) {
  return String(str).padEnd(len);
}

function fmt(num, decimals = 5) {
  return num != null ? num.toFixed(decimals) : "N/A";
}

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

function signalLabel(signal) {
  if (signal === "bullish") return `${GREEN}${BOLD}↑ BULLISH CROSS${RESET}`;
  if (signal === "bearish") return `${RED}${BOLD}↓ BEARISH CROSS${RESET}`;
  return `${DIM}  no crossover ${RESET}`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function ema4Hours() {
  console.log(
    `\n${BOLD}${CYAN}OANDA EMA ${EMA_FAST}/${EMA_SLOW} Crossover Scanner${RESET}`,
  );
  console.log(
    `${DIM}Timeframe: ${GRANULARITY} · Candles: ${CANDLE_COUNT} · Env: ${OANDA_ENV}${RESET}`,
  );
  console.log(`${DIM}Scanned at: ${new Date().toLocaleString()}${RESET}\n`);

  if (OANDA_API_KEY === "YOUR_API_KEY_HERE") {
    console.error(
      `${RED}Error: Set OANDA_API_KEY environment variable before running.${RESET}`,
    );
    console.error(
      `  Example: OANDA_API_KEY=abc123 OANDA_ACCOUNT_ID=001-001-xxx node oanda-ema-scanner.js\n`,
    );
    process.exit(1);
  }

  const results = [];
  let done = 0;

  for (const pair of PAIRS) {
    process.stdout.write(
      `\r${DIM}Scanning ${pad(pair.replace("_", "/"), 10)} (${done + 1}/${PAIRS.length})...${RESET}`,
    );

    try {
      const closes = await fetchCandles(pair);

      if (closes.length < EMA_SLOW + 1) {
        results.push({ pair, error: "insufficient data", signal: "none" });
      } else {
        const { ema21, ema50, signal } = detectCrossover(closes);
        results.push({ pair, ema21, ema50, signal });
      }
    } catch (err) {
      results.push({ pair, error: err.message, signal: "none" });
    }

    done++;
    // small delay to stay within rate limits
    await new Promise((r) => setTimeout(r, 100));
  }

  process.stdout.write("\r" + " ".repeat(60) + "\r"); // clear progress line

  // ─── Sort: crossovers first ──────────────────────────────────────────────────
  results.sort((a, b) => {
    const order = { bullish: 0, bearish: 1, none: 2 };
    return order[a.signal] - order[b.signal];
  });

  // ─── Print table ─────────────────────────────────────────────────────────────
  const col = [10, 14, 14, 20];
  const header = `${BOLD}${pad("PAIR", col[0])}${pad("EMA " + EMA_FAST, col[1])}${pad("EMA " + EMA_SLOW, col[2])}SIGNAL${RESET}`;
  const divider = "─".repeat(col[0] + col[1] + col[2] + 20);

  console.log(divider);
  console.log(header);
  console.log(divider);

  let bullCount = 0,
    bearCount = 0;

  for (const r of results) {
    if (r.error && r.signal === "none" && !r.ema21) {
      console.log(
        `${pad(r.pair.replace("_", "/"), col[0])}${DIM}${pad("—", col[1])}${pad("—", col[2])}error: ${r.error}${RESET}`,
      );
      continue;
    }

    const decimals = r.pair.includes("JPY") ? 3 : 5;
    console.log(
      `${pad(r.pair.replace("_", "/"), col[0])}` +
        `${pad(fmt(r.ema21, decimals), col[1])}` +
        `${pad(fmt(r.ema50, decimals), col[2])}` +
        `${signalLabel(r.signal)}`,
    );

    if (r.signal === "bullish") bullCount++;
    if (r.signal === "bearish") bearCount++;

    await sendSignalAlert(r.signal, r.pair, r.ema21, {
      type: "4 Hour EMA Crossover",
    });
    sleep(1);
  }

  console.log(divider);

  // ─── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}Summary${RESET}`);
  console.log(`  ${GREEN}Bullish crossovers : ${bullCount}${RESET}`);
  console.log(`  ${RED}Bearish crossovers : ${bearCount}${RESET}`);
  console.log(`  Total pairs scanned: ${results.length}\n`);
}

module.exports = ema4Hours;
