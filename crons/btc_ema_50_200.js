require("../config/config");
const https = require("https");

const { sendPushNotif } = require("../config/telegram_notify");

const CFG = {
  symbol: "BTCUSDT",
  category: "linear", // Bybit USDT perpetual
  interval: "15", // 15-minute candles
  emaFast: 50,
  emaSlow: 200,

  // How close counts as "almost touching" EMA 200.
  // 0.003 = 0.3%.  At $100k BTC that's ~$300.
  touchThreshold: 0.002,

  // How many candles back to look for the EMA 200 touch (from the confirmation candle).
  maxLookback: 3,

  // Must be > emaSlow + maxLookback + small buffer for accurate EMA seeding.
  fetchLimit: 260,

  // Re-scan interval in milliseconds.
  pollMs: 30_000, // 30 seconds
};

// ─────────────────────────────────────────────────────────────
//  ANSI COLORS
// ─────────────────────────────────────────────────────────────
const K = {
  rst: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  grn: "\x1b[32m",
  yel: "\x1b[33m",
  blu: "\x1b[34m",
  mag: "\x1b[35m",
  cyn: "\x1b[36m",
  wht: "\x1b[97m",
};
const col = (str, ...codes) => codes.join("") + str + K.rst;
const $ = (n) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n) => (n >= 0 ? "+" : "") + (n * 100).toFixed(3) + "%";
const sep = (ch = "═", n = 66) => ch.repeat(n);
const bar = (ratio, width = 12) => {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
};

// ─────────────────────────────────────────────────────────────
//  HTTP HELPER
// ─────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`JSON parse error: ${raw.slice(0, 80)}`));
          }
        });
      })
      .on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────
//  BYBIT  v5/market/kline
// ─────────────────────────────────────────────────────────────
async function fetchCandles(symbol) {
  const { category, interval, fetchLimit } = CFG;
  const url =
    `https://api.bybit.com/v5/market/kline` +
    `?category=${category}&symbol=${symbol}&interval=${interval}&limit=${fetchLimit}`;

  const json = await httpGet(url);
  if (json.retCode !== 0)
    throw new Error(`Bybit [${json.retCode}]: ${json.retMsg}`);

  // Bybit returns newest-first → reverse to chronological order
  // Candle format: [startTime, open, high, low, close, volume, turnover]
  return json.result.list.reverse().map((r) => ({
    t: Number(r[0]), // open-time unix ms
    o: parseFloat(r[1]),
    h: parseFloat(r[2]),
    l: parseFloat(r[3]),
    c: parseFloat(r[4]),
    v: parseFloat(r[5]),
  }));
}

// ─────────────────────────────────────────────────────────────
//  INDICATOR — Exponential Moving Average
// ─────────────────────────────────────────────────────────────
function calcEMA(candles, period) {
  const k = 2 / (period + 1);
  const out = new Array(candles.length).fill(null);

  // Seed: simple average of the first `period` closes
  let seed = 0;
  for (let i = 0; i < period; i++) seed += candles[i].c;
  out[period - 1] = seed / period;

  for (let i = period; i < candles.length; i++) {
    out[i] = candles[i].c * k + out[i - 1] * (1 - k);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
//  STRATEGY HELPERS
// ─────────────────────────────────────────────────────────────

/** Determine overall trend from EMA positions at a given index. */
function getTrend(ema50, ema200, idx) {
  const e50 = ema50[idx];
  const e200 = ema200[idx];
  if (e50 === null || e200 === null) return "NEUTRAL";
  if (e50 > e200) return "UPTREND";
  if (e50 < e200) return "DOWNTREND";
  return "NEUTRAL";
}

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));
/**
 * Did this candle's extreme touch (or nearly touch) EMA 200?
 *   UPTREND   → look at the LOW  (price pulling back down toward EMA 200)
 *   DOWNTREND → look at the HIGH (price rallying up toward EMA 200)
 * Also allows the CLOSE to qualify if it is within the threshold band.
 */
function touchedEMA200(candle, ema200val, trend) {
  const band = ema200val * CFG.touchThreshold;
  if (trend === "UPTREND") {
    // Low is at/below EMA 200 or within `band` above it
    const lowTouched = candle.l <= ema200val + band;
    const closeTouched = Math.abs(candle.c - ema200val) <= band;
    return lowTouched || closeTouched;
  } else {
    // High is at/above EMA 200 or within `band` below it
    const highTouched = candle.h >= ema200val - band;
    const closeTouched = Math.abs(candle.c - ema200val) <= band;
    return highTouched || closeTouched;
  }
}

/**
 * Is the candle's close between EMA 200 and EMA 50 — the "zone"?
 *   UPTREND   :  EMA200 < close < EMA50   (bounced but not yet reached EMA50)
 *   DOWNTREND :  EMA50  < close < EMA200  (rejected but not yet dropped to EMA50)
 */
function inZone(candle, e50, e200, trend) {
  if (trend === "UPTREND") return candle.c > e200 && candle.c < e50;
  if (trend === "DOWNTREND") return candle.c > e50 && candle.c < e200;
  return false;
}

/**
 * Is the confirmation candle moving in the right direction?
 *   UPTREND  → bullish (close > open)
 *   DOWNTREND → bearish (close < open)
 */
function validDirection(candle, trend) {
  if (trend === "UPTREND") return candle.c > candle.o;
  if (trend === "DOWNTREND") return candle.c < candle.o;
  return false;
}

// ─────────────────────────────────────────────────────────────
//  MAIN DETECTION ENGINE
// ─────────────────────────────────────────────────────────────
function detect(candles, ema50, ema200) {
  const n = candles.length;

  // candles[n-1] = currently forming candle  → skip (incomplete)
  // candles[n-2] = last CLOSED candle        → confirmation candidate
  const ci = n - 2;
  const conf = candles[ci];
  const e50c = ema50[ci];
  const e200c = ema200[ci];

  if (e50c === null || e200c === null) return null;

  const trend = getTrend(ema50, ema200, ci);
  if (trend === "NEUTRAL") return null;

  // ① Confirmation candle must be directionally valid (bullish/bearish)
  if (!validDirection(conf, trend)) return null;

  // ② Confirmation candle must close INSIDE the EMA 200 ↔ EMA 50 zone
  if (!inZone(conf, e50c, e200c, trend)) return null;

  // ③ Search backwards for a candle that touched EMA 200
  for (let lb = 1; lb <= CFG.maxLookback; lb++) {
    const ti = ci - lb;
    if (ti < 0) break;

    const touch = candles[ti];
    const te200 = ema200[ti];
    const te50 = ema50[ti];
    if (te200 === null) continue;

    // Must have actually touched EMA 200
    if (!touchedEMA200(touch, te200, trend)) continue;

    // ④ All candles BETWEEN the touch and confirmation must also stay
    //    in the zone — confirming price never ran through EMA 50 and reversed.
    let cleanPath = true;
    for (let mi = ti + 1; mi < ci; mi++) {
      const me50 = ema50[mi];
      const me200 = ema200[mi];
      if (me50 === null || me200 === null) continue;
      if (!inZone(candles[mi], me50, me200, trend)) {
        cleanPath = false;
        break;
      }
    }
    if (!cleanPath) continue;

    // ── SETUP CONFIRMED ──────────────────────────────────────────
    // zonePct: 0 = touching EMA 200, 1 = reaching EMA 50
    const zoneSize = Math.abs(e50c - e200c);
    const zonePct =
      trend === "UPTREND"
        ? (conf.c - e200c) / zoneSize
        : (e200c - conf.c) / zoneSize;

    return {
      signal: trend === "UPTREND" ? "LONG" : "SHORT",
      trend,
      touch,
      touchIdx: ti,
      touchE200: te200,
      touchE50: te50,
      conf,
      confIdx: ci,
      confE50: e50c,
      confE200: e200c,
      zonePct: Math.max(0, Math.min(1, zonePct)),
      lookbackUsed: lb,
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
//  DISPLAY
// ─────────────────────────────────────────────────────────────
function fmtTime(ms) {
  return new Date(ms).toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function printMarket(candles, ema50, ema200) {
  const n = candles.length;
  const last = candles[n - 2]; // last closed candle
  const e50 = ema50[n - 2];
  const e200 = ema200[n - 2];
  const trend = getTrend(ema50, ema200, n - 2);

  const tc =
    trend === "UPTREND" ? K.grn : trend === "DOWNTREND" ? K.red : K.yel;
  const icon = trend === "UPTREND" ? "▲" : trend === "DOWNTREND" ? "▼" : "─";
  const dir =
    last.c >= last.o ? col("▲ Bullish", K.grn) : col("▼ Bearish", K.red);

  console.log(
    `  Last Candle : ${col($(last.c), K.bold, K.wht)}  ${dir}    ` +
      col(`O:${$(last.o)}  H:${$(last.h)}  L:${$(last.l)}`, K.dim),
  );
  console.log(
    `  EMA 50      : ${col($(e50), K.bold, K.yel)}   (${pct((last.c - e50) / e50)} from close)`,
  );
  console.log(
    `  EMA 200     : ${col($(e200), K.bold, K.mag)}   (${pct((last.c - e200) / e200)} from close)`,
  );
  console.log(`  Trend       : ${col(`${icon}  ${trend}`, K.bold, tc)}`);
}

async function printSignal(setup, isNew, symbol) {
  const isLong = setup.signal === "LONG";
  const sc = isLong ? K.grn : K.red;
  const arrow = isLong ? "▲" : "▼";
  const zoneStr =
    col(`[${bar(setup.zonePct)}]`, sc) +
    col(` ${(setup.zonePct * 100).toFixed(0)}% toward EMA 50`, K.dim);

  // Distance: how close was the touch?
  const touchDist = isLong
    ? (setup.touch.l - setup.touchE200) / setup.touchE200 // negative = pierced
    : (setup.touchE200 - setup.touch.h) / setup.touchE200; // negative = pierced

  console.log(sep("─"));
  if (isNew) {
    console.log(
      col(
        `\n  ${arrow}  NEW SIGNAL — READY TO ENTER ${setup.signal}  ${arrow}\n`,
        K.bold,
        sc,
      ),
    );
  } else {
    console.log(
      col(
        `\n  ${arrow}  SIGNAL ACTIVE — READY TO ENTER ${setup.signal}  ${arrow}  (persisting)\n`,
        sc,
      ),
    );
  }

  // ── Touch Candle ──────────────────────────────────────────────
  console.log(
    col(`  ① Touch Candle`, K.bold) +
      col(
        `  [${fmtTime(setup.touch.t)}]  (${setup.lookbackUsed} candle(s) before confirmation)`,
        K.dim,
      ),
  );
  console.log(
    `     O:${$(setup.touch.o)}  H:${$(setup.touch.h)}  ` +
      `L:${col($(setup.touch.l), isLong ? K.mag : K.dim)}  ` +
      `C:${col($(setup.touch.c), K.wht)}`,
  );
  console.log(
    `     EMA 200 at touch : ${col($(setup.touchE200), K.mag)}   ` +
      `Distance : ${col(pct(touchDist), touchDist < 0 ? K.grn : K.yel)}` +
      (touchDist < 0 ? col(" (pierced)", K.dim) : col(" (above)", K.dim)),
  );

  console.log("");

  // ── Confirmation Candle ───────────────────────────────────────
  console.log(
    col(`  ② Confirmation Candle`, K.bold) +
      col(`  [${fmtTime(setup.conf.t)}]`, K.dim),
  );
  console.log(
    `     O:${$(setup.conf.o)}  H:${$(setup.conf.h)}  ` +
      `L:${$(setup.conf.l)}  C:${col($(setup.conf.c), K.bold, sc)}`,
  );
  console.log(
    `     EMA 200 : ${col($(setup.confE200), K.mag)}  ←── zone ──→  EMA 50 : ${col($(setup.confE50), K.yel)}`,
  );
  console.log(`     Zone position : ${zoneStr}`);

  console.log("");

  // ── Setup Description ─────────────────────────────────────────
  if (isLong) {
    await sendPushNotif(
      `${symbol} - EMA 20-500 Long Signal: ${setup.signal} at ${fmtTime(setup.touch.t)}`,
    );
    console.log(
      col(
        `  📌 Uptrend pullback: Low tagged EMA 200 → bullish candle → close still below EMA 50`,
        K.dim,
      ),
    );
    console.log(
      col(
        `     Anticipating: EMA 50 breakout continuation to the upside`,
        K.dim,
      ),
    );
  } else {
    await sendPushNotif(
      `${symbol} - EMA 20-500 Short Signal: ${setup.signal} at ${fmtTime(setup.touch.t)}`,
    );
    console.log(
      col(
        `  📌 Downtrend rally: High tagged EMA 200 → bearish candle → close still above EMA 50`,
        K.dim,
      ),
    );
    console.log(
      col(
        `     Anticipating: EMA 50 breakdown continuation to the downside`,
        K.dim,
      ),
    );
  }
  console.log("");
}

function printNoSignal(candles, ema50, ema200) {
  const n = candles.length;
  const last = candles[n - 2];
  const e200 = ema200[n - 2];
  const trend = getTrend(ema50, ema200, n - 2);

  const distToE200 = Math.abs(last.c - e200) / e200;
  const tc =
    trend === "UPTREND" ? K.grn : trend === "DOWNTREND" ? K.red : K.yel;

  console.log(sep("─"));
  console.log(col(`  ⏳ No setup — monitoring...`, K.yel));
  console.log(
    col(
      `     Waiting for price to ${trend === "UPTREND" ? "pull back to" : "rally to"} EMA 200`,
      K.dim,
    ),
  );
  console.log(
    col(
      `     Current distance from EMA 200 : ${pct(distToE200 * (last.c > e200 ? 1 : -1))}`,
      K.dim,
    ),
  );
}

// ─────────────────────────────────────────────────────────────
//  SCAN LOOP
// ─────────────────────────────────────────────────────────────
let lastSignaledCandleTime = 0;

async function btcEmaTrending() {
  try {
    const theCoins = [
      "BTCUSDT",
      "ETHUSDT",
      "SOLUSDT",
      "BNBUSDT",
      "XRPUSDT",
      "LINKUSDT",
    ];

    for (const coin of theCoins) {
      await sleep(2);
      const candles = await fetchCandles(coin);

      if (candles.length < CFG.emaSlow + CFG.maxLookback + 10) {
        console.log(
          col(
            "  ⚠  Insufficient candle data from API — retrying next poll.",
            K.yel,
          ),
        );
        console.log(sep() + "\n");
        return;
      }

      const ema50 = calcEMA(candles, CFG.emaFast);
      const ema200 = calcEMA(candles, CFG.emaSlow);

      const setup = detect(candles, ema50, ema200);

      if (setup) {
        const isNew = setup.conf.t !== lastSignaledCandleTime;
        if (isNew) lastSignaledCandleTime = setup.conf.t;
        await printSignal(setup, isNew, coin);
      } else {
        printNoSignal(candles, ema50, ema200);
      }
    }
  } catch (err) {
    console.log(sep("─"));
    console.error(col(`  ❌ Error: ${err.message}`, K.red));
    if (process.env.DEBUG) console.error(err.stack);
  }
}

module.exports = btcEmaTrending;
