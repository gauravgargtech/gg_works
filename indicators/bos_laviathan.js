// Node.js port of "Market Structure - By Leviathan" (Pine Script v5)
// Original: © Leviathan, MPL 2.0. Swing point generation inspired by @BacktestRookies
//
// Usage (module):
//   const { marketStructure } = require('./market-structure');
//   const result = marketStructure(candles, { swingSize: 20, choch: true, showHalf: true });
//
// Usage (CLI):
//   node market-structure.js candles.csv --swingSize=10 --bosConfType=Wicks --choch --showHalf
//   node market-structure.js candles.json --swingSize=20 --showSwing=false
//
// candles: array of { time, open, high, low, close }  (time optional)
// CSV needs a header row containing: high, low, close (time/open optional)

"use strict";

// Defaults mirror the Pine inputs
const DEFAULTS = {
  swingSize: 20, // Swing Length
  bosConfType: "Candle Close", // 'Candle Close' | 'Wicks'
  choch: false, // Show CHoCH
  showSwing: true, // Show Swing Points (HH, LH, HL, LL)

  // 0.5 Retracement Level
  showHalf: false,
  halfColor: "#2927b0", // color.rgb(41, 39, 176)
  halfStyle: "Solid", // 'Solid' | 'Dashed' | 'Dotted'
  halfWidth: 1,

  // BOS Settings
  bosColor: "#707277", // color.rgb(112, 114, 119)
  bosStyle: "Dashed",
  bosWidth: 1,
};

const dayjs = require("dayjs");

const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
dayjs.extend(utc);
dayjs.extend(timezone);

const LINE_STYLES = ["Solid", "Dashed", "Dotted"];

function validate(o) {
  if (!Number.isInteger(o.swingSize) || o.swingSize < 1) {
    throw new Error("swingSize must be an integer >= 1");
  }
  if (!["Candle Close", "Wicks"].includes(o.bosConfType)) {
    throw new Error("bosConfType must be 'Candle Close' or 'Wicks'");
  }
  if (!LINE_STYLES.includes(o.halfStyle)) {
    throw new Error("halfStyle must be Solid, Dashed or Dotted");
  }
  if (!LINE_STYLES.includes(o.bosStyle)) {
    throw new Error("bosStyle must be Solid, Dashed or Dotted");
  }
  if (!Number.isInteger(o.halfWidth) || o.halfWidth < 1) {
    throw new Error("halfWidth must be an integer >= 1");
  }
  if (!Number.isInteger(o.bosWidth) || o.bosWidth < 1) {
    throw new Error("bosWidth must be an integer >= 1");
  }
}

// ta.pivothigh(high, L, R): evaluated on bar i, returns the pivot value of bar i-R (or NaN).
// Left bars may tie the pivot; right bars must be strictly lower.
function pivotHigh(highs, i, L, R) {
  if (i < L + R) return NaN;
  const c = i - R;
  const v = highs[c];
  for (let k = 1; k <= L; k++) if (highs[c - k] > v) return NaN;
  for (let k = 1; k <= R; k++) if (highs[c + k] >= v) return NaN;
  return v;
}

// ta.pivotlow(low, L, R)
function pivotLow(lows, i, L, R) {
  if (i < L + R) return NaN;
  const c = i - R;
  const v = lows[c];
  for (let k = 1; k <= L; k++) if (lows[c - k] < v) return NaN;
  for (let k = 1; k <= R; k++) if (lows[c + k] <= v) return NaN;
  return v;
}

function marketStructure(candles, options = {}) {
  const o = { ...DEFAULTS, ...options };
  validate(o);

  const n = candles.length;
  const highs = candles.map((c) => Number(c.high));
  const lows = candles.map((c) => Number(c.low));
  const closes = candles.map((c) => Number(c.close));
  const timeOf = (i) =>
    candles[i] && candles[i].time !== undefined ? candles[i].time : i;

  const { swingSize } = o;

  // var state (persists across bars). NaN comparisons are false, same as Pine's na.
  let prevHigh = NaN,
    prevLow = NaN;
  let prevHighIndex = NaN,
    prevLowIndex = NaN;
  let highActive = false,
    lowActive = false;
  let prevSwing = 0; // HH = 2, LH = 1, HL = -1, LL = -2
  let prevBreakoutDir = 0;

  const swings = []; // labels: HH / LH / HL / LL
  const halfLines = []; // 0.5 retracement lines
  const bos = []; // BOS / CHoCH lines + labels

  for (let i = 0; i < n; i++) {
    const prevSwingPrevBar = prevSwing; // Pine's prevSwing[1]

    const pivHi = pivotHigh(highs, i, swingSize, swingSize);
    const pivLo = pivotLow(lows, i, swingSize, swingSize);

    let hh = false,
      lh = false,
      hl = false,
      ll = false;

    if (!Number.isNaN(pivHi)) {
      if (pivHi >= prevHigh) {
        hh = true;
        prevSwing = 2;
      } else {
        lh = true;
        prevSwing = 1;
      }
      prevHigh = pivHi;
      highActive = true;
      prevHighIndex = i - swingSize;
    }

    if (!Number.isNaN(pivLo)) {
      if (pivLo >= prevLow) {
        hl = true;
        prevSwing = -1;
      } else {
        ll = true;
        prevSwing = -2;
      }
      prevLow = pivLo;
      lowActive = true;
      prevLowIndex = i - swingSize;
    }

    // Breakout signals
    let highBroken = false,
      lowBroken = false;
    const highSrc = o.bosConfType === "Candle Close" ? closes[i] : highs[i];
    const lowSrc = o.bosConfType === "Candle Close" ? closes[i] : lows[i];

    if (highSrc > prevHigh && highActive) {
      highBroken = true;
      highActive = false;
    }
    if (lowSrc < prevLow && lowActive) {
      lowBroken = true;
      lowActive = false;
    }

    // ---- Output ----
    const pivIdx = i - swingSize;

    const addHalf = (fromIdx, price) =>
      halfLines.push({
        x1: fromIdx,
        x2: pivIdx,
        time1: timeOf(fromIdx),
        time2: timeOf(pivIdx),
        price,
        color: o.halfColor,
        style: o.halfStyle,
        width: o.halfWidth,
      });

    if (hh && o.showSwing) {
      swings.push({
        type: "HH",
        index: pivIdx,
        time: timeOf(pivIdx),
        price: pivHi,
        position: "above",
      });
      if (prevSwingPrevBar === -1 && o.showHalf)
        addHalf(prevLowIndex, (prevLow + pivHi) / 2);
    }
    if (lh && o.showSwing) {
      swings.push({
        type: "LH",
        index: pivIdx,
        time: timeOf(pivIdx),
        price: pivHi,
        position: "above",
      });
    }
    if (hl && o.showSwing) {
      swings.push({
        type: "HL",
        index: pivIdx,
        time: timeOf(pivIdx),
        price: pivLo,
        position: "below",
      });
    }
    if (ll && o.showSwing) {
      swings.push({
        type: "LL",
        index: pivIdx,
        time: timeOf(pivIdx),
        price: pivLo,
        position: "below",
      });
      if (prevSwingPrevBar === 1 && o.showHalf)
        addHalf(prevHighIndex, (prevHigh + pivLo) / 2);
    }

    // BOS lines
    if (highBroken) {
      const labelIdx = Math.floor(i - (i - prevHighIndex) / 2);
      bos.push({
        label: prevBreakoutDir === -1 && o.choch ? "CHoCH" : "BOS",
        direction: "bullish",
        x1: prevHighIndex,
        x2: i,
        time1: timeOf(prevHighIndex),
        time2: timeOf(i),
        price: prevHigh,
        labelIndex: labelIdx,
        labelTime: timeOf(labelIdx),
        color: o.bosColor,
        style: o.bosStyle,
        width: o.bosWidth,
      });
      prevBreakoutDir = 1;
    }
    if (lowBroken) {
      const labelIdx = Math.floor(i - (i - prevLowIndex) / 2);
      bos.push({
        label: prevBreakoutDir === 1 && o.choch ? "CHoCH" : "BOS",
        direction: "bearish",
        x1: prevLowIndex,
        x2: i,
        time1: timeOf(prevLowIndex),
        time2: timeOf(i),
        price: prevLow,
        labelIndex: labelIdx,
        labelTime: timeOf(labelIdx),
        color: o.bosColor,
        style: o.bosStyle,
        width: o.bosWidth,
      });
      prevBreakoutDir = -1;
    }
  }

  return { options: o, swings, halfLines, bos };
}

// Pass candles, get BOS (and CHoCH if options.choch) events back.
// Each event: { label, direction, price, x1, x2, time1, time2, ... }
//   x1/time1 = the swing point that was broken, x2/time2 = the candle that broke it.
function getBOS(candles, options = {}) {
  return marketStructure(candles, options).bos;
}

// Most recent BOS/CHoCH, or null. Pass { lastNBars: 3 } to only return it
// if the break happened within the last N candles (useful for live signals).
function getLatestBOS(candles, options = {}) {
  const { lastNBars, ...msOptions } = options;
  const all = getBOS(candles, msOptions);
  const last = all[all.length - 1] || null;
  if (!last) return null;
  if (lastNBars !== undefined && last.x2 < candles.length - lastNBars)
    return null;
  return last;
}

// ---------- CLI ----------
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines
    .shift()
    .split(",")
    .map((s) => s.trim().toLowerCase());
  const idx = (k) => head.indexOf(k);
  for (const k of ["high", "low", "close"])
    if (idx(k) < 0) throw new Error(`CSV missing "${k}" column`);
  return lines.map((l) => {
    const p = l.split(",");
    const get = (k) => (idx(k) >= 0 ? p[idx(k)].trim() : undefined);
    return {
      time: get("time") ?? get("date") ?? get("timestamp"),
      open: Number(get("open")),
      high: Number(get("high")),
      low: Number(get("low")),
      close: Number(get("close")),
    };
  });
}

function parseArgs(argv) {
  const opts = {};
  let file = null;
  for (const a of argv) {
    if (!a.startsWith("--")) {
      file = a;
      continue;
    }
    const [k, v] = a.slice(2).split("=");
    if (v === undefined) opts[k] = true;
    else if (v === "true") opts[k] = true;
    else if (v === "false") opts[k] = false;
    else if (v !== "" && !Number.isNaN(Number(v))) opts[k] = Number(v);
    else opts[k] = v;
  }
  return { file, opts };
}

if (require.main === module) {
  const fs = require("fs");
  const { file, opts } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error(
      'Usage: node market-structure.js <candles.csv|candles.json> [--swingSize=20] [--bosConfType="Candle Close"|Wicks] [--choch] [--showSwing=false] [--showHalf] [--halfColor=#2927b0] [--halfStyle=Solid] [--halfWidth=1] [--bosColor=#707277] [--bosStyle=Dashed] [--bosWidth=1]',
    );
    process.exit(1);
  }
  const raw = fs.readFileSync(file, "utf8");
  const candles = file.toLowerCase().endsWith(".json")
    ? JSON.parse(raw)
    : parseCsv(raw);
  console.log(JSON.stringify(marketStructure(candles, opts), null, 2));
}

module.exports = {
  marketStructure,
  getBOS,
  getLatestBOS,
  DEFAULTS,
  pivotHigh,
  pivotLow,
};
