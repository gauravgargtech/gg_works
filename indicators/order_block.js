#!/usr/bin/env node
/**
 * Volumized Order Blocks — Node.js port of the "Volumized Order Blocks |
 * Flux Charts" Pine Script indicator, fed with EUR_USD Daily candles from
 * the OANDA v20 REST API.
 *
 * No dependencies — uses Node's built-in fetch (Node 18+).
 *
 * CONFIG: set via environment variables, or just edit the CONFIG block
 * below directly.
 *
 *   OANDA_API_KEY        your OANDA v20 personal access token (required)
 *   OANDA_ENVIRONMENT    "practice" (default) or "live"
 *   INSTRUMENT           default "EUR_USD"
 *   GRANULARITY          default "D" (Daily)
 *   CANDLE_COUNT         default 500
 *   ZONE_COUNT           "One" | "Low" | "Medium" | "High" -> 1/3/5/10 zones/side
 *
 * USAGE:
 *   OANDA_API_KEY=xxxx node order-blocks.js
 *   node order-blocks.js --mock          # run with synthetic data, no API call/key needed
 */

"use strict";

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG = {
  apiKey: process.env.OANDA_API_KEY || "",
  environment: process.env.OANDA_ENVIRONMENT || "practice", // "practice" | "live"
  instrument: process.env.INSTRUMENT || "EUR_USD",
  granularity: process.env.GRANULARITY || "D", // Daily, matches the original request
  candleCount: parseInt(process.env.CANDLE_COUNT || "500", 10),
  zoneCount: process.env.ZONE_COUNT || "Low", // One | Low | Medium | High

  // Indicator constants (mirror the Pine Script's inputs/hardcoded values)
  swingLength: 10,
  maxATRMult: 3.5,
  maxOrderBlocks: 30,
  obEndMethod: "Wick", // "Wick" | "Close"
  atrLength: 10,
  showInvalidated: false,
};

const ZONE_COUNT_MAP = { One: 1, Low: 3, Medium: 5, High: 10 };

// ============================================================================
// OANDA CLIENT
// ============================================================================

async function fetchCandles({
  apiKey,
  environment,
  instrument,
  granularity,
  count,
}) {
  if (!apiKey) {
    throw new Error(
      "Missing OANDA API key. Set OANDA_API_KEY, or run with --mock to test offline.",
    );
  }

  const base =
    environment === "live"
      ? "https://api-fxtrade.oanda.com"
      : "https://api-fxpractice.oanda.com";

  const url = `${base}/v3/instruments/${instrument}/candles?count=${count}&granularity=${granularity}&price=M`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OANDA API error ${res.status}: ${body}`);
  }

  const data = await res.json();

  return data.candles
    .filter((c) => c.complete) // drop the currently-forming candle
    .map((c) => ({
      time: new Date(c.time).getTime(), // ms since epoch, mirrors Pine's `time`
      open: parseFloat(c.mid.o),
      high: parseFloat(c.mid.h),
      low: parseFloat(c.mid.l),
      close: parseFloat(c.mid.c),
      volume: c.volume, // OANDA volume = tick count, same proxy TradingView uses for FX
    }));
}

// ============================================================================
// MOCK DATA (for offline testing, no API key needed)
// ============================================================================

function generateMockCandles(
  count = 500,
  { startPrice = 1.085, dayMs = 86400000, seed = 42 } = {},
) {
  let rngState = seed;
  const rand = () => {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff;
  };

  const candles = [];
  let price = startPrice;
  const startTime = Date.now() - count * dayMs;

  for (let i = 0; i < count; i++) {
    const drift = (rand() - 0.5) * 0.006;
    const open = price;
    const close = open + drift;
    const high = Math.max(open, close) + rand() * 0.002;
    const low = Math.min(open, close) - rand() * 0.002;
    const volume = Math.floor(5000 + rand() * 15000);

    candles.push({
      time: startTime + i * dayMs,
      open: +open.toFixed(5),
      high: +high.toFixed(5),
      low: +low.toFixed(5),
      close: +close.toFixed(5),
      volume,
    });

    price = close;
  }

  return candles;
}

// ============================================================================
// ATR (Wilder / RMA) — matches Pine's ta.atr(length)
// ============================================================================

function computeATR(candles, length = 10) {
  const n = candles.length;
  const tr = new Array(n).fill(null);
  const atr = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    const { high, low, close } = candles[i];
    if (i === 0) {
      tr[i] = high - low;
    } else {
      const prevClose = candles[i - 1].close;
      tr[i] = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose),
      );
    }
  }

  if (n < length) return atr;

  let seed = 0;
  for (let i = 0; i < length; i++) seed += tr[i];
  seed /= length;
  atr[length - 1] = seed;

  for (let i = length; i < n; i++) {
    atr[i] = (atr[i - 1] * (length - 1) + tr[i]) / length;
  }

  return atr;
}

// ============================================================================
// ORDER BLOCK DETECTION — port of findOBSwings + findOrderBlocks
// ============================================================================

function computeOrderBlocks(candles, options) {
  const { swingLength, maxATRMult, maxOrderBlocks, obEndMethod, atrLength } =
    options;

  const n = candles.length;
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const open = candles.map((c) => c.open);
  const close = candles.map((c) => c.close);
  const volume = candles.map((c) => c.volume);
  const time = candles.map((c) => c.time);

  const atr = computeATR(candles, atrLength);

  let swingType = 0;
  let top = null; // { x, y, vol, crossed }
  let bottom = null;

  const bullishOBs = []; // newest-first (mirrors Pine's array.unshift)
  const bearishOBs = [];

  for (let i = swingLength; i < n; i++) {
    // ---- findOBSwings(swingLength) ----
    let upper = -Infinity;
    let lower = Infinity;
    for (let k = i - swingLength + 1; k <= i; k++) {
      if (high[k] > upper) upper = high[k];
      if (low[k] < lower) lower = low[k];
    }

    const oldSwingType = swingType;
    const idxLen = i - swingLength; // Pine's "[len]" offset

    if (high[idxLen] > upper) swingType = 0;
    else if (low[idxLen] < lower) swingType = 1;
    // else: unchanged (persisted, like Pine's `var`)

    if (swingType === 0 && oldSwingType !== 0) {
      top = { x: idxLen, y: high[idxLen], vol: volume[idxLen], crossed: false };
    }
    if (swingType === 1 && oldSwingType !== 1) {
      bottom = {
        x: idxLen,
        y: low[idxLen],
        vol: volume[idxLen],
        crossed: false,
      };
    }

    // ================= BULLISH SIDE =================
    for (let j = bullishOBs.length - 1; j >= 0; j--) {
      const ob = bullishOBs[j];
      if (!ob.breaker) {
        const testVal =
          obEndMethod === "Wick" ? low[i] : Math.min(open[i], close[i]);
        if (testVal < ob.bottom) {
          ob.breaker = true;
          ob.breakTime = time[i];
          ob.bbVolume = volume[i];
        }
      } else if (high[i] > ob.top) {
        bullishOBs.splice(j, 1); // fully invalidated
      }
    }

    if (top && close[i] > top.y && !top.crossed) {
      top.crossed = true;

      let boxBtm = high[i - 1];
      let boxTop = low[i - 1];
      let boxLoc = time[i - 1];

      for (let k = 1; k <= i - top.x - 1; k++) {
        const idx = i - k;
        if (low[idx] < boxBtm) {
          boxBtm = low[idx];
          boxTop = high[idx];
          boxLoc = time[idx];
        }
      }

      const newOB = {
        top: boxTop,
        bottom: boxBtm,
        obVolume: volume[i] + volume[i - 1] + volume[i - 2],
        obType: "Bull",
        startTime: boxLoc,
        obLowVolume: volume[i - 2],
        obHighVolume: volume[i] + volume[i - 1],
        breaker: false,
        breakTime: null,
        bbVolume: null,
      };

      const obSize = Math.abs(newOB.top - newOB.bottom);
      if (atr[i] != null && obSize <= atr[i] * maxATRMult) {
        bullishOBs.unshift(newOB);
        if (bullishOBs.length > maxOrderBlocks) bullishOBs.pop();
      }
    }

    // ================= BEARISH SIDE =================
    for (let j = bearishOBs.length - 1; j >= 0; j--) {
      const ob = bearishOBs[j];
      if (!ob.breaker) {
        const testVal =
          obEndMethod === "Wick" ? high[i] : Math.max(open[i], close[i]);
        if (testVal > ob.top) {
          ob.breaker = true;
          ob.breakTime = time[i];
          ob.bbVolume = volume[i];
        }
      } else if (low[i] < ob.bottom) {
        bearishOBs.splice(j, 1);
      }
    }

    if (bottom && close[i] < bottom.y && !bottom.crossed) {
      bottom.crossed = true;

      let boxBtm = low[i - 1];
      let boxTop = high[i - 1];
      let boxLoc = time[i - 1];

      for (let k = 1; k <= i - bottom.x - 1; k++) {
        const idx = i - k;
        if (high[idx] > boxTop) {
          boxTop = high[idx];
          boxBtm = low[idx];
          boxLoc = time[idx];
        }
      }

      const newOB = {
        top: boxTop,
        bottom: boxBtm,
        obVolume: volume[i] + volume[i - 1] + volume[i - 2],
        obType: "Bear",
        startTime: boxLoc,
        obLowVolume: volume[i] + volume[i - 1],
        obHighVolume: volume[i - 2],
        breaker: false,
        breakTime: null,
        bbVolume: null,
      };

      const obSize = Math.abs(newOB.top - newOB.bottom);
      if (atr[i] != null && obSize <= atr[i] * maxATRMult) {
        bearishOBs.unshift(newOB);
        if (bearishOBs.length > maxOrderBlocks) bearishOBs.pop();
      }
    }
  }

  return { bullishOBs, bearishOBs };
}

// ============================================================================
// ZONE MERGING — port of areaOfOB / doOBsTouch / combineOBsFunc
// ============================================================================

function rectArea(ob, nowTime) {
  const x1 = ob.startTime;
  const x2 = ob.breakTime != null ? ob.breakTime : nowTime + 1;
  const y1 = ob.top;
  const y2 = ob.bottom;
  return Math.abs(x2 - x1) * Math.abs(y1 - y2);
}

function doOBsTouch(a, b, nowTime, overlapThresholdPercentage = 0) {
  const XA1 = a.startTime;
  const XA2 = a.breakTime != null ? a.breakTime : nowTime + 1;
  const YA1 = a.top;
  const YA2 = a.bottom;

  const XB1 = b.startTime;
  const XB2 = b.breakTime != null ? b.breakTime : nowTime + 1;
  const YB1 = b.top;
  const YB2 = b.bottom;

  const interX = Math.max(0, Math.min(XA2, XB2) - Math.max(XA1, XB1));
  const interY = Math.max(0, Math.min(YA1, YB1) - Math.max(YA2, YB2));
  const intersection = interX * interY;
  const union = rectArea(a, nowTime) + rectArea(b, nowTime) - intersection;

  if (union <= 0) return false;
  return (intersection / union) * 100 > overlapThresholdPercentage;
}

function combineOrderBlocks(list, nowTime) {
  let items = list.map((o) => ({ ...o, disabled: false, combined: false }));

  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < items.length; i++) {
      if (items[i].disabled) continue;
      for (let j = 0; j < items.length; j++) {
        if (i === j || items[j].disabled) continue;
        if (items[i].obType !== items[j].obType) continue;
        if (!doOBsTouch(items[i], items[j], nowTime)) continue;

        const a = items[i];
        const b = items[j];
        a.disabled = true;
        b.disabled = true;

        const aBreak = a.breakTime != null ? a.breakTime : 0;
        const bBreak = b.breakTime != null ? b.breakTime : 0;
        const mergedBreak = Math.max(aBreak, bBreak);

        items.push({
          top: Math.max(a.top, b.top),
          bottom: Math.min(a.bottom, b.bottom),
          obVolume: a.obVolume + b.obVolume,
          obType: a.obType,
          startTime: Math.min(a.startTime, b.startTime),
          obLowVolume: a.obLowVolume + b.obLowVolume,
          obHighVolume: a.obHighVolume + b.obHighVolume,
          breaker: a.breaker || b.breaker,
          breakTime: mergedBreak === 0 ? null : mergedBreak,
          bbVolume: (a.bbVolume || 0) + (b.bbVolume || 0),
          disabled: false,
          combined: true,
        });

        changed = true;
        break outer;
      }
    }
  }

  return items.filter((o) => !o.disabled);
}

// ============================================================================
// OUTPUT
// ============================================================================

function fmtPrice(p) {
  return p.toFixed(5);
}
function fmtTime(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function printReport(instrument, granularity, bulls, bears) {
  const line = (ob) => {
    const range = `${fmtPrice(ob.bottom)} - ${fmtPrice(ob.top)}`;
    const status = ob.breaker ? "breaker" : "active";
    const pct = Math.round(
      (Math.min(ob.obHighVolume, ob.obLowVolume) /
        Math.max(ob.obHighVolume, ob.obLowVolume)) *
        100,
    );
    const combinedTag = ob.combined ? " [combined]" : "";
    return `  ${fmtTime(ob.startTime)}  ${range}  vol=${ob.obVolume}  imbalance=${pct}%  ${status}${combinedTag}`;
  };

  console.log(
    `\n=== ${instrument} (${granularity}) — Volumized Order Blocks ===\n`,
  );

  console.log(`Bullish zones (${bulls.length}):`);
  if (bulls.length === 0) console.log("  none");
  bulls.forEach((ob) => console.log(line(ob)));

  console.log(`\nBearish zones (${bears.length}):`);
  if (bears.length === 0) console.log("  none");
  bears.forEach((ob) => console.log(line(ob)));
  console.log("");
}

// ============================================================================
// MAIN
// ============================================================================

async function findOrberBlocks(candles) {
  const { bullishOBs, bearishOBs } = computeOrderBlocks(candles, {
    swingLength: CONFIG.swingLength,
    maxATRMult: CONFIG.maxATRMult,
    maxOrderBlocks: CONFIG.maxOrderBlocks,
    obEndMethod: CONFIG.obEndMethod,
    atrLength: CONFIG.atrLength,
  });

  const n = ZONE_COUNT_MAP[CONFIG.zoneCount] ?? 3;
  const bullsTrimmed = bullishOBs.slice(0, n);
  const bearsTrimmed = bearishOBs.slice(0, n);

  const nowTime = candles[candles.length - 1].time;
  const combined = combineOrderBlocks(
    [...bullsTrimmed, ...bearsTrimmed],
    nowTime,
  );

  const visible = CONFIG.showInvalidated
    ? combined
    : combined.filter((o) => !o.breaker);

  const finalBulls = visible
    .filter((o) => o.obType === "Bull")
    .sort((a, b) => b.startTime - a.startTime);
  const finalBears = visible
    .filter((o) => o.obType === "Bear")
    .sort((a, b) => b.startTime - a.startTime);

  return {
    bullishOBs: finalBulls,
    bearishOBs: finalBears,
  };
}

module.exports = findOrberBlocks;
