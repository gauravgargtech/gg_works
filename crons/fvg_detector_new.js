require("../config/config");

const { ATR } = require("technicalindicators");
const { fetchCandles } = require("../exhanges/oanda");
const { insert, remove } = require("../adapters/mongo");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const FOREX_PAIRS = [
  { pair: "EUR_USD", tier: 1, baseMinGap: 15 },
  { pair: "GBP_USD", tier: 1, baseMinGap: 15 },
  { pair: "AUD_USD", tier: 1, baseMinGap: 15 },
  { pair: "NZD_USD", tier: 1, baseMinGap: 15 },
  { pair: "USD_JPY", tier: 1, baseMinGap: 15 },
  { pair: "USD_CHF", tier: 1, baseMinGap: 15 },
  { pair: "USD_CAD", tier: 1, baseMinGap: 15 },
  { pair: "EUR_JPY", tier: 2, baseMinGap: 20 },
  { pair: "GBP_JPY", tier: 2, baseMinGap: 20 },
  { pair: "AUD_JPY", tier: 2, baseMinGap: 20 },
  { pair: "CHF_JPY", tier: 2, baseMinGap: 20 },
  { pair: "CAD_JPY", tier: 2, baseMinGap: 20 },
  { pair: "NZD_JPY", tier: 2, baseMinGap: 20 },
  { pair: "AUD_CAD", tier: 3, baseMinGap: 15 },
  { pair: "AUD_CHF", tier: 3, baseMinGap: 15 },
  { pair: "AUD_NZD", tier: 3, baseMinGap: 15 },
  { pair: "CAD_CHF", tier: 3, baseMinGap: 15 },
  { pair: "EUR_AUD", tier: 3, baseMinGap: 15 },
  { pair: "EUR_CAD", tier: 3, baseMinGap: 15 },
  { pair: "EUR_CHF", tier: 3, baseMinGap: 15 },
  { pair: "EUR_NZD", tier: 3, baseMinGap: 15 },
  { pair: "GBP_AUD", tier: 3, baseMinGap: 15 },
  { pair: "GBP_CAD", tier: 3, baseMinGap: 15 },
  { pair: "GBP_CHF", tier: 3, baseMinGap: 15 },
  { pair: "GBP_NZD", tier: 3, baseMinGap: 15 },
  { pair: "NZD_CAD", tier: 3, baseMinGap: 15 },
];

const CANDLE_COUNT = 800;
const GRANULARITY = "H1";
const ATR_PERIOD = 14;
const CANDLES_PER_DAY = 6; // H4 → 6 candles per trading day

// ================= HELPERS =================

function toPips(pair, priceDiff) {
  return pair.toLowerCase().includes("jpy")
    ? priceDiff * 100
    : priceDiff * 10000;
}

function calculateATR(candles) {
  if (!candles || candles.length < ATR_PERIOD + 5) return 0;

  return (
    ATR.calculate({
      high: candles.map((c) => c.high),
      low: candles.map((c) => c.low),
      close: candles.map((c) => c.close),
      period: ATR_PERIOD,
    }).slice(-1)[0] || 0
  );
}

// ================= FRACTAL BOS =================

function isFractalHigh(candles, i) {
  if (i < 2 || i > candles.length - 3) return false;

  return (
    candles[i].high > candles[i - 1].high &&
    candles[i].high > candles[i - 2].high &&
    candles[i].high > candles[i + 1].high &&
    candles[i].high > candles[i + 2].high
  );
}

function isFractalLow(candles, i) {
  if (i < 2 || i > candles.length - 3) return false;

  return (
    candles[i].low < candles[i - 1].low &&
    candles[i].low < candles[i - 2].low &&
    candles[i].low < candles[i + 1].low &&
    candles[i].low < candles[i + 2].low
  );
}

function detectBOS(candles, i) {
  let lastFractalHigh = null;
  let lastFractalLow = null;

  for (let j = i - 20; j < i; j++) {
    if (j < 2) continue;

    if (isFractalHigh(candles, j)) lastFractalHigh = candles[j].high;
    if (isFractalLow(candles, j)) lastFractalLow = candles[j].low;
  }

  const close = candles[i].close;

  return {
    bullishBOS: lastFractalHigh && close > lastFractalHigh,
    bearishBOS: lastFractalLow && close < lastFractalLow,
  };
}

// ================= DISPLACEMENT FILTER =================
// True ICT FVGs form on a "displacement" candle (c2) showing real
// directional conviction — not just any 3-candle gap. Checks body-to-range
// ratio and body size relative to ATR.
function hasDisplacement(candle, atr, pair) {
  const range = candle.high - candle.low;
  if (range === 0) return false;

  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = body / range;

  const bodyPips = toPips(pair, body);
  const atrPips = toPips(pair, atr);

  const strongBody = bodyRatio >= 0.6; // body dominates the wick
  const strongVsATR = atrPips > 0 ? bodyPips >= atrPips * 0.4 : true;

  return strongBody && strongVsATR;
}

// ================= SESSION (FIXED) =================
// Standard session opens in UTC (no-DST approximation):
//   Sydney 22:00–07:00, Tokyo 00:00–09:00, London 08:00–17:00, NY 13:00–22:00
// Converted to Australia/Brisbane (UTC+10, no DST) and partitioned into
// non-overlapping blocks so each H4 candle gets exactly one label:
//   Asia    08:00–16:00  (Tokyo core + Sydney overlap)
//   London  16:00–23:00
//   NewYork 23:00–08:00  (wraps past midnight)
function getSession(time) {
  const hour = dayjs(time).tz("Australia/Brisbane").hour();

  if (hour >= 8 && hour < 16) return "asia";
  if (hour >= 16 && hour < 23) return "london";
  return "newyork"; // covers 23:00–08:00
}

// ================= PREV-DAY-RANGE SWEEP (FIXED) =================
// Old version used a 50-candle lookback, which on H4 (6 candles/day) is
// ~8 trading days, not "previous day". This uses a fixed CANDLES_PER_DAY
// window instead. Note: this is still a rolling N-candle approximation,
// not a calendar-day boundary — for exact calendar alignment you'd need
// to anchor against daily-candle opens instead.
function prevDaySweep(candles, i) {
  if (i < CANDLES_PER_DAY + 1) return { sweepHigh: false, sweepLow: false };

  const prev = candles.slice(i - CANDLES_PER_DAY - 1, i - 1);

  const prevHigh = Math.max(...prev.map((c) => c.high));
  const prevLow = Math.min(...prev.map((c) => c.low));

  return {
    sweepHigh: candles[i].high > prevHigh,
    sweepLow: candles[i].low < prevLow,
  };
}

// ================= FILL STATUS (NEW) =================
// The original code's `isFilled` check was the logical negation of its own
// entry condition, so it could never be true — every gap was reported as
// "unfilled" regardless of what price did afterward. This walks forward
// from the candle after formation and tracks:
//   - filled: has price fully traded back through the zone
//   - fillPercent: max % of the zone retraced even if not fully filled
function checkFVGFillStatus(candles, startIdx, fvgLow, fvgHigh, type) {
  const zoneSize = fvgHigh - fvgLow;
  let maxPenetration = 0;

  for (let k = startIdx + 1; k < candles.length; k++) {
    if (type === "bullish") {
      if (candles[k].low <= fvgHigh) {
        const pen = Math.min(1, (fvgHigh - candles[k].low) / zoneSize);
        maxPenetration = Math.max(maxPenetration, pen);
      }
      if (candles[k].low <= fvgLow) {
        return { filled: true, fillPercent: 100 };
      }
    } else {
      if (candles[k].high >= fvgLow) {
        const pen = Math.min(1, (candles[k].high - fvgLow) / zoneSize);
        maxPenetration = Math.max(maxPenetration, pen);
      }
      if (candles[k].high >= fvgHigh) {
        return { filled: true, fillPercent: 100 };
      }
    }
  }

  return { filled: false, fillPercent: +(maxPenetration * 100).toFixed(1) };
}

// ================= FVG DETECTION =================

function detectFVG(candles, pair, baseMinGap) {
  const fvgSignals = [];

  const atr = calculateATR(candles);
  const atrPips = toPips(pair, atr);

  const minGapPips = Math.max(baseMinGap, atrPips * 0.15);

  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];

    const session = getSession(c3.time);
    const { bullishBOS, bearishBOS } = detectBOS(candles, i);
    const { sweepHigh, sweepLow } = prevDaySweep(candles, i);

    // ================= TRUE ICT BULLISH FVG =================
    const bullishGap = c3.low - c1.high;
    const bullishGapPips = toPips(pair, bullishGap);

    const displacement = hasDisplacement(c2, atr, pair);

    if (c1.high < c3.low && bullishGapPips >= minGapPips) {
      const { filled, fillPercent } = checkFVGFillStatus(
        candles,
        i,
        c1.high,
        c3.low,
        "bullish",
      );

      if (!filled) {
        const entry = (c1.high + c3.low) / 2; // midpoint of the gap
        const slDistance = atr > 0 ? atr * 0.5 : bullishGap * 0.2;

        fvgSignals.push({
          pair,
          type: "bullish",
          time: dayjs(c2.time)
            .tz("Australia/Brisbane")
            .format("YYYY-MM-DD HH:mm"),
          unix: dayjs(c2.time).unix(), // captured directly, no re-parse

          fvgLow: c1.high,
          fvgHigh: c3.low,

          gapPips: bullishGapPips.toFixed(1),
          atrPips: atrPips.toFixed(1),
          atrPercent:
            atrPips > 0 ? ((bullishGapPips / atrPips) * 100).toFixed(1) : "0.0",

          createdAfterBOS: bullishBOS,
          prevDaySweep: sweepLow,
          displacement,

          session,

          fillPercent,

          entry: entry.toFixed(5),
          stopLoss: (entry - slDistance).toFixed(5),
          takeProfit: (entry + slDistance * 2).toFixed(5),
        });
      }
    }

    // ================= TRUE ICT BEARISH FVG =================
    const bearishGap = c1.low - c3.high;
    const bearishGapPips = toPips(pair, bearishGap);

    if (c1.low > c3.high && bearishGapPips >= minGapPips) {
      const { filled, fillPercent } = checkFVGFillStatus(
        candles,
        i,
        c3.high,
        c1.low,
        "bearish",
      );

      if (!filled) {
        const entry = (c3.high + c1.low) / 2; // midpoint of the gap
        const slDistance = atr > 0 ? atr * 0.5 : bearishGap * 0.2;

        fvgSignals.push({
          pair,
          type: "bearish",
          time: dayjs(c2.time)
            .tz("Australia/Brisbane")
            .format("YYYY-MM-DD HH:mm"),
          unix: dayjs(c2.time).unix(), // captured directly, no re-parse

          fvgLow: c3.high,
          fvgHigh: c1.low,

          gapPips: bearishGapPips.toFixed(1),
          atrPips: atrPips.toFixed(1),
          atrPercent:
            atrPips > 0 ? ((bearishGapPips / atrPips) * 100).toFixed(1) : "0.0",

          createdAfterBOS: bearishBOS,
          prevDaySweep: sweepHigh,
          displacement,

          session,

          fillPercent,

          entry: entry.toFixed(5),
          stopLoss: (entry + slDistance).toFixed(5),
          takeProfit: (entry - slDistance * 2).toFixed(5),
        });
      }
    }
  }

  return fvgSignals;
}

// ================= SCAN =================

async function scanPair(pairConfig) {
  try {
    console.log(`\n🔍 Scanning ${pairConfig.pair}`);

    const candles = await fetchCandles(
      pairConfig.pair,
      GRANULARITY,
      CANDLE_COUNT,
    );

    const signals = detectFVG(candles, pairConfig.pair, pairConfig.baseMinGap);

    await remove("fvg_forex_deep", { pair: pairConfig.pair });

    if (signals.length > 0) {
      const latest = signals[signals.length - 1];

      latest.instrument = pairConfig.pair;
      // unix is already set correctly inside detectFVG — no re-parsing here.

      await insert("fvg_forex_deep", latest);

      console.log(
        `  ✓ Stored ${latest.type} FVG | BOS: ${latest.createdAfterBOS} | Sweep: ${latest.prevDaySweep} | Fill: ${latest.fillPercent}%`,
      );
    } else {
      console.log(`  ✓ No valid (unfilled) FVG`);
    }

    return signals;
  } catch (err) {
    console.error(`❌ ${pairConfig.pair}: ${err.message}`);
    return [];
  }
}

// ================= MAIN =================

async function scanAllPairs() {
  console.log("\n═══════════════════════════════════");
  console.log("  🔎 IMPROVED 4H FVG SCANNER (ICT)");
  console.log("═══════════════════════════════════");

  let all = [];

  for (const p of FOREX_PAIRS) {
    const s = await scanPair(p);
    all.push(...s);
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("\n═══════════════════════════════════");
  console.log(`  DONE → ${all.length} FVGs found`);
  console.log("═══════════════════════════════════\n");

  return all;
}

module.exports = scanAllPairs;
