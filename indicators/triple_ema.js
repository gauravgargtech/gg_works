"use strict";
/**
 * EMA 50 / 200 / 900 pullback strategy: signals + backtest (single file).
 *
 * RULES
 *  BUY  : regime = close above EMA50, EMA200 and EMA900 (arms the setup).
 *         Pullback = price comes down to EMA50 (or deeper, to EMA200).
 *         Signal = a later candle closes back ABOVE EMA50.
 *         Exit   = first candle that CLOSES below EMA200.
 *  SELL : mirror image (below all three, price rallies up to EMA50/EMA200,
 *         then a later candle closes back BELOW EMA50; exit on close above EMA200).
 *  A setup is cancelled if price closes on the wrong side of EMA900.
 *  One position at a time per backtest. Entry/exit are at candle close.
 *  No stop loss (not in your rules) - the only exit is the EMA200 close.
 *
 * USAGE (CLI)
 *   node ema-pullback-backtest.js ./data              # files like AUDUSD_1h.json, XAUUSD_15m.csv
 *   node ema-pullback-backtest.js ./data --log        # also console.log every signal
 *   node ema-pullback-backtest.js ./data --spread=1.2 # subtract 1.2 pips per trade
 *
 * USAGE (module)
 *   const { calculateSignals, backtest } = require('./ema-pullback-backtest');
 *   const signals = calculateSignals(candles, { log: true });
 *   const rows    = annotateCandles(candles);  // every candle, signal: null | 'BUY' | 'SELL'
 *   const result  = backtest(candles, signals, { symbol: 'AUDUSD' });
 *
 * Candle format: { time, open, high, low, close } (or [time, o, h, l, c]), oldest first.
 */

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  fast: 50,
  mid: 200,
  slow: 900,
  pullbackBy: "close", // 'close' = a candle must CLOSE at/through EMA50; 'wick' = wick touch is enough
  log: false, // console.log each signal
  oneAtATime: true, // true: only signals you could actually take (flat). false: every raw signal
  spreadPips: 0, // cost deducted per trade, in pips
  candleLimit: 10000, // used by the CLI loader
};

// ---------- helpers ----------

function normalizeCandles(raw) {
  const list = raw.map((c) => {
    if (Array.isArray(c)) {
      return { time: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4] };
    }
    return {
      time: c.time ?? c.timestamp ?? c.date ?? c.datetime ?? c.t,
      open: +(c.open ?? c.o),
      high: +(c.high ?? c.h),
      low: +(c.low ?? c.l),
      close: +(c.close ?? c.c),
    };
  });
  const ts = (t) => (typeof t === "number" ? t : Date.parse(t));
  if (list.length > 1 && ts(list[0].time) > ts(list[list.length - 1].time))
    list.reverse();
  return list;
}

function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period; // seed with SMA
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function pipSize(symbol, overrides = {}, refPrice) {
  const s = (symbol || "").toUpperCase();
  if (s && overrides[s] !== undefined) return overrides[s];
  if (s.startsWith("XAU") || s.includes("GOLD")) return 0.1; // gold: 1 pip = $0.10
  if (s.startsWith("XAG") || s.includes("SILVER")) return 0.01;
  if (s.includes("JPY")) return 0.01;
  if (s) return 0.0001;
  // no symbol given: infer from price level so pips are never wildly off
  if (refPrice >= 1000) return 0.1; // gold-like
  if (refPrice >= 20) return 0.01; // JPY-like
  return 0.0001;
}

// ---------- 1) SIGNALS ----------

/**
 * Returns [{ index, time, side: 'BUY'|'SELL', price, ema50, ema200, ema900 }]
 * With oneAtATime (default) only signals taken while flat are returned (= the trades).
 * Use { oneAtATime: false } for every raw signal.
 */
function calculateSignals(rawCandles, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const candles = normalizeCandles(rawCandles);
  const closes = candles.map((c) => c.close);
  const eF = ema(closes, o.fast);
  const eM = ema(closes, o.mid);
  const eS = ema(closes, o.slow);

  const signals = [];
  let buyArmed = false,
    buyPullback = false;
  let sellArmed = false,
    sellPullback = false;
  let buyPbIdx = -1,
    sellPbIdx = -1; // candle where the current pullback was first seen
  let pos = 0; // 1 long, -1 short, 0 flat (used when oneAtATime)

  for (let i = o.slow - 1; i < candles.length; i++) {
    const { close, high, low, time } = candles[i];
    const f = eF[i],
      m = eM[i],
      s = eS[i];

    // exit open position when close crosses EMA200 against it
    let exited = false;
    if (pos === 1 && close < m) {
      pos = 0;
      exited = true;
    }
    if (pos === -1 && close > m) {
      pos = 0;
      exited = true;
    }

    // cancel setups if price closes on the wrong side of the slow EMA
    if (close <= s) {
      buyArmed = false;
      buyPullback = false;
    }
    if (close >= s) {
      sellArmed = false;
      sellPullback = false;
    }

    // arm regimes
    if (close > f && close > m && close > s) buyArmed = true;
    if (close < f && close < m && close < s) sellArmed = true;

    let signal = null;

    // triggers (use pullback seen on EARLIER candles only)
    let pbIdx = -1;
    if (buyArmed && buyPullback && close > f) {
      signal = "BUY";
      pbIdx = buyPbIdx;
      buyPullback = false;
    } else if (sellArmed && sellPullback && close < f) {
      signal = "SELL";
      pbIdx = sellPbIdx;
      sellPullback = false;
    }

    // record pullbacks on this candle
    if (!signal) {
      if (buyArmed) {
        const touched = o.pullbackBy === "wick" ? low <= f : close <= f;
        if (touched) {
          if (!buyPullback) buyPbIdx = i;
          buyPullback = true;
        }
      }
      if (sellArmed) {
        const touched = o.pullbackBy === "wick" ? high >= f : close >= f;
        if (touched) {
          if (!sellPullback) sellPbIdx = i;
          sellPullback = true;
        }
      }
    }

    if (signal) {
      const allowed = !o.oneAtATime || (pos === 0 && !exited);
      if (allowed) {
        const buy = signal === "BUY";
        const sig = {
          index: i,
          time,
          side: signal,
          price: close,
          trend: buy
            ? "UPTREND (close above EMA50/200/900)"
            : "DOWNTREND (close below EMA50/200/900)",
          pullbackTime: candles[pbIdx].time,
          reason: buy
            ? `pullback to EMA50 on ${candles[pbIdx].time}, then closed back above EMA50`
            : `rally to EMA50 on ${candles[pbIdx].time}, then closed back below EMA50`,
          exitRule: buy ? "close below EMA200" : "close above EMA200",
          ema50: f,
          ema200: m,
          ema900: s,
        };
        signals.push(sig);
        if (o.oneAtATime) pos = buy ? 1 : -1;
        if (o.log)
          console.log(`[${signal}] ${time} @ ${close} | ${sig.reason}`);
      }
    }
  }
  return signals;
}

/**
 * Pine-style output: one object per candle.
 *   signal   : null | 'BUY' | 'SELL'              (candle where an entry is generated)
 *   exit     : null | 'CLOSE_LONG' | 'CLOSE_SHORT' (candle that closes beyond EMA200 against the open trade)
 *   position : null | 'LONG' | 'SHORT'             (trade open after this candle closes)
 * Returns [{ time, open, high, low, close, ema50, ema200, ema900, signal, exit, position }]
 */
function annotateCandles(rawCandles, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const candles = normalizeCandles(rawCandles);
  const closes = candles.map((c) => c.close);
  const eF = ema(closes, o.fast),
    eM = ema(closes, o.mid),
    eS = ema(closes, o.slow);
  const bySignalIndex = new Map(
    calculateSignals(candles, o).map((sg) => [sg.index, sg.side]),
  );
  const val = (x) => (Number.isNaN(x) ? null : x);

  let pos = 0; // 1 long, -1 short
  return candles.map((c, i) => {
    let exit = null;
    if (pos === 1 && closes[i] < eM[i]) {
      exit = "CLOSE_LONG";
      pos = 0;
    } else if (pos === -1 && closes[i] > eM[i]) {
      exit = "CLOSE_SHORT";
      pos = 0;
    }

    let signal = null;
    const side = bySignalIndex.get(i);
    if (side && pos === 0 && !exit) {
      signal = side;
      pos = side === "BUY" ? 1 : -1;
    }

    return {
      ...c,
      ema50: val(eF[i]),
      ema200: val(eM[i]),
      ema900: val(eS[i]),
      signal,
      exit,
      position: pos === 1 ? "LONG" : pos === -1 ? "SHORT" : null,
    };
  });
}

// ---------- 2) BACKTEST ----------

/**
 * Runs the signals through the exit rule (close beyond EMA200).
 * Skips signals that occur while a trade is open.
 */
function backtest(rawCandles, signals, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const candles = normalizeCandles(rawCandles);
  const closes = candles.map((c) => c.close);
  const eM = ema(closes, o.mid);
  // o.pipSize (number) wins; otherwise by symbol; otherwise inferred from price
  const ps =
    o.pipSize || pipSize(o.symbol, o.pipSizes, candles[0] && candles[0].close);
  if (!o.symbol && !o.pipSize) {
    console.warn(
      `backtest: no symbol given, inferred pip size ${ps}. Pass { symbol } or { pipSize }.`,
    );
  }

  const trades = [];
  let freeFrom = 0;

  for (const sig of signals) {
    if (sig.index < freeFrom) continue;
    const dir = sig.side === "BUY" ? 1 : -1;

    let exitIdx = -1;
    for (let j = sig.index + 1; j < candles.length; j++) {
      if (dir === 1 ? closes[j] < eM[j] : closes[j] > eM[j]) {
        exitIdx = j;
        break;
      }
    }
    const stillOpen = exitIdx === -1;
    if (stillOpen) exitIdx = candles.length - 1;

    const exitPrice = closes[exitIdx];
    const pips = ((exitPrice - sig.price) * dir) / ps - o.spreadPips;

    trades.push({
      side: sig.side,
      entryTime: sig.time,
      exitTime: candles[exitIdx].time,
      entry: sig.price,
      exit: exitPrice,
      pips: +pips.toFixed(1),
      bars: exitIdx - sig.index,
      openAtEnd: stillOpen,
    });
    freeFrom = exitIdx + 1;
  }

  return { symbol: o.symbol, trades, stats: summarize(trades) };
}

function summarize(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pips > 0);
  const losses = trades.filter((t) => t.pips <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pips, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pips, 0));
  const total = trades.reduce((a, t) => a + t.pips, 0);

  let equity = 0,
    peak = 0,
    maxDD = 0;
  for (const t of trades) {
    equity += t.pips;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }

  const side = (s) =>
    trades.filter((t) => t.side === s).reduce((a, t) => a + t.pips, 0);

  return {
    trades: n,
    totalPips: +total.toFixed(1),
    buyPips: +side("BUY").toFixed(1),
    sellPips: +side("SELL").toFixed(1),
    winRate: n ? +((wins.length / n) * 100).toFixed(1) : 0,
    avgPips: n ? +(total / n).toFixed(1) : 0,
    avgWin: wins.length ? +(grossWin / wins.length).toFixed(1) : 0,
    avgLoss: losses.length ? +(-grossLoss / losses.length).toFixed(1) : 0,
    profitFactor: grossLoss
      ? +(grossWin / grossLoss).toFixed(2)
      : grossWin
        ? Infinity
        : 0,
    maxDrawdownPips: +maxDD.toFixed(1),
    avgBarsHeld: n
      ? +(trades.reduce((a, t) => a + t.bars, 0) / n).toFixed(1)
      : 0,
  };
}

// ---------- 3) LOADING + COMPARISON (CLI) ----------

function loadCandles(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (file.toLowerCase().endsWith(".json")) {
    const data = JSON.parse(text);
    return normalizeCandles(
      Array.isArray(data) ? data : data.candles || data.data,
    );
  }
  const lines = text.split(/\r?\n/);
  const sep = lines[0].includes(";")
    ? ";"
    : lines[0].includes("\t")
      ? "\t"
      : ",";
  const head = lines[0].split(sep).map((h) => h.trim().toLowerCase());
  const hasHeader = head.some((h) => /open|close|high|low/.test(h));
  const idx = (names, fallback) => {
    const i = head.findIndex((h) => names.includes(h));
    return hasHeader && i >= 0 ? i : fallback;
  };
  const col = {
    time: idx(["time", "date", "datetime", "timestamp"], 0),
    open: idx(["open", "o"], 1),
    high: idx(["high", "h"], 2),
    low: idx(["low", "l"], 3),
    close: idx(["close", "c"], 4),
  };
  const rows = lines
    .slice(hasHeader ? 1 : 0)
    .filter(Boolean)
    .map((l) => l.split(sep));
  return normalizeCandles(
    rows.map((r) => ({
      time: r[col.time],
      open: r[col.open],
      high: r[col.high],
      low: r[col.low],
      close: r[col.close],
    })),
  );
}

/** Backtest every SYMBOL_TIMEFRAME.(json|csv) file in a folder and print a comparison. */
function runComparison(dir, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(json|csv)$/i.test(f))
    .sort();
  const rows = [];

  for (const f of files) {
    const m = path
      .parse(f)
      .name.match(/^([A-Za-z0-9]+)[_\-. ]+([A-Za-z0-9]+)$/);
    if (!m) {
      console.warn(`Skipping ${f} (name must look like AUDUSD_1h.json)`);
      continue;
    }
    const [, symbol, tf] = m;

    let candles = loadCandles(path.join(dir, f));
    candles = candles.slice(-o.candleLimit);
    if (candles.length <= o.slow) {
      console.warn(`Skipping ${f}: need > ${o.slow} candles`);
      continue;
    }

    const signals = calculateSignals(candles, { ...o, log: o.log });
    const { stats } = backtest(candles, signals, {
      ...o,
      symbol: symbol.toUpperCase(),
    });
    rows.push({
      symbol: symbol.toUpperCase(),
      tf: tf.toLowerCase(),
      candles: candles.length,
      signals: signals.length,
      ...stats,
    });
  }

  rows.sort(
    (a, b) => a.symbol.localeCompare(b.symbol) || a.tf.localeCompare(b.tf),
  );
  console.table(rows);

  // timeframe totals (pip values differ per symbol, so read XAUUSD separately)
  const byTf = {};
  for (const r of rows) {
    const t = (byTf[r.tf] ||= { tf: r.tf, trades: 0, totalPips: 0 });
    t.trades += r.trades;
    t.totalPips = +(t.totalPips + r.totalPips).toFixed(1);
  }
  console.log("\nTotals by timeframe (all symbols summed):");
  console.table(Object.values(byTf));
  return rows;
}

module.exports = {
  calculateSignals,
  annotateCandles,
  backtest,
  runComparison,
  loadCandles,
  ema,
  pipSize,
  DEFAULTS,
};
