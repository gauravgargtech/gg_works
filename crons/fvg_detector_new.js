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

const CANDLE_COUNT = 800; // primary (H1) lookback
const HTF_CANDLE_COUNT = 200; // H4/D only need recent zones, not 2 years of them
const GRANULARITY = "M15"; // now actually wired in as the default below
const HTF_GRANULARITIES = ["H4", "D"]; // confluence timeframes
const ATR_PERIOD = 14;

// Candles-per-trading-day, keyed by granularity, so prevDaySweep()'s
// lookback window is correct regardless of which timeframe this is run on.
// (Previous version hardcoded 6, which is only correct for H4.)
const CANDLES_PER_DAY_MAP = {
  M5: 288,
  M15: 96,
  M30: 48,
  H1: 24,
  H4: 6,
  D: 1,
};

const BOS_FRACTAL_LOOKBACK = 20; // candles scanned back for the last fractal swing

// Score gating: only persist signals that clear a minimum quality bar,
// and only keep the best N per pair instead of whatever happened to be
// chronologically last.
const MIN_SCORE_TO_STORE = 40; // grade C and above
const MAX_SIGNALS_PER_PAIR = 3;

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

  for (let j = i - BOS_FRACTAL_LOOKBACK; j < i; j++) {
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
// non-overlapping blocks so each candle gets exactly one label:
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
// Window size is now derived from granularity instead of a hardcoded "6",
// which only made sense for H4. On H1 this is now 24 candles (~1 day),
// not 6 (~6 hours).
function prevDaySweep(candles, i, granularity) {
  const perDay = CANDLES_PER_DAY_MAP[granularity] || 24;

  if (i < perDay + 1) return { sweepHigh: false, sweepLow: false };

  const prev = candles.slice(i - perDay - 1, i - 1);

  const prevHigh = Math.max(...prev.map((c) => c.high));
  const prevLow = Math.min(...prev.map((c) => c.low));

  return {
    sweepHigh: candles[i].high > prevHigh,
    sweepLow: candles[i].low < prevLow,
  };
}

// ================= FILL STATUS =================
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

// ================= HTF CONFLUENCE (NEW) =================
// Checks whether an H1 FVG zone overlaps a currently-unfilled H4 and/or
// Daily FVG zone. Same-direction overlap (both bullish or both bearish)
// scores higher than opposite-direction overlap, since the latter usually
// just means the H1 gap happens to sit inside a larger HTF gap rather than
// both timeframes agreeing on direction. Daily is weighted above H4.
function checkHTFAlignment(fvgLow, fvgHigh, type, htfZones) {
  const matches = htfZones.filter(
    (z) => fvgLow <= z.high && fvgHigh >= z.low, // simple range overlap test
  );

  if (matches.length === 0) {
    return { aligned: false, timeframes: [], sameDirection: false, points: 0 };
  }

  const sameDirection = matches.filter((m) => m.type === type);
  const timeframes = [...new Set(matches.map((m) => m.timeframe))];

  let points = 0;
  if (timeframes.includes("D")) {
    points += sameDirection.some((m) => m.timeframe === "D") ? 25 : 10;
  }
  if (timeframes.includes("H4")) {
    points += sameDirection.some((m) => m.timeframe === "H4") ? 15 : 5;
  }

  return {
    aligned: true,
    timeframes,
    sameDirection: sameDirection.length > 0,
    points: Math.min(points, 30), // cap so HTF confluence stays one component, not the whole score
  };
}

// ================= SCORING ENGINE (NEW) =================
// Weighted, transparent score (0-100) + letter grade. Returns the
// breakdown too, so you can see *why* a signal scored what it did instead
// of trusting a black-box number.
function scoreSignal(
  { createdAfterBOS, prevDaySweep, displacement, session, atrPercent },
  htfAlignment,
) {
  const breakdown = {};

  // Liquidity swept right before the gap formed — turns a plain FVG into
  // a "sweep then displacement" setup, which is the actual ICT thesis.
  breakdown.liquiditySweep = prevDaySweep ? 25 : 0;

  // Break of structure in the same direction as the gap.
  breakdown.bos = createdAfterBOS ? 25 : 0;

  // H4 / Daily FVG overlap.
  breakdown.htfAlignment = htfAlignment.points;

  // Quality of the displacement candle that created the gap.
  breakdown.displacement = displacement ? 10 : 0;

  // Session weighting — London/NY over Asia range.
  breakdown.session = session === "asia" ? 0 : 10;

  // Gap size relative to ATR — filters gaps that barely clear the pip floor.
  const atrPct = parseFloat(atrPercent) || 0;
  breakdown.gapStrength = atrPct >= 50 ? 5 : 0;

  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const score = Math.min(100, total);

  let grade;
  if (score >= 80) grade = "A";
  else if (score >= 60) grade = "B";
  else if (score >= 40) grade = "C";
  else grade = "D";

  return { score, grade, breakdown };
}

// ================= FVG DETECTION =================

function detectFVG(candles, pair, baseMinGap, granularity, htfZones = []) {
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
    const { sweepHigh, sweepLow } = prevDaySweep(candles, i, granularity);
    const displacement = hasDisplacement(c2, atr, pair);

    // ================= TRUE ICT BULLISH FVG =================
    const bullishGap = c3.low - c1.high;
    const bullishGapPips = toPips(pair, bullishGap);

    if (c1.high < c3.low && bullishGapPips >= minGapPips) {
      const { filled, fillPercent } = checkFVGFillStatus(
        candles,
        i,
        c1.high,
        c3.low,
        "bullish",
      );

      if (!filled) {
        const entry = (c1.high + c3.low) / 2;
        const slDistance = atr > 0 ? atr * 0.5 : bullishGap * 0.2;

        const htfAlignment = checkHTFAlignment(
          c1.high,
          c3.low,
          "bullish",
          htfZones,
        );
        const atrPercent =
          atrPips > 0 ? ((bullishGapPips / atrPips) * 100).toFixed(1) : "0.0";

        const { score, grade, breakdown } = scoreSignal(
          {
            createdAfterBOS: bullishBOS,
            prevDaySweep: sweepLow,
            displacement,
            session,
            atrPercent,
          },
          htfAlignment,
        );

        fvgSignals.push({
          pair,
          type: "bullish",
          time: dayjs(c2.time)
            .tz("Australia/Brisbane")
            .format("YYYY-MM-DD HH:mm"),
          unix: dayjs(c2.time).unix(),

          fvgLow: c1.high,
          fvgHigh: c3.low,

          gapPips: bullishGapPips.toFixed(1),
          atrPips: atrPips.toFixed(1),
          atrPercent,

          createdAfterBOS: bullishBOS,
          prevDaySweep: sweepLow,
          displacement,

          session,
          fillPercent,

          htfAlignment,
          score,
          grade,
          scoreBreakdown: breakdown,

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
        const entry = (c3.high + c1.low) / 2;
        const slDistance = atr > 0 ? atr * 0.5 : bearishGap * 0.2;

        const htfAlignment = checkHTFAlignment(
          c3.high,
          c1.low,
          "bearish",
          htfZones,
        );
        const atrPercent =
          atrPips > 0 ? ((bearishGapPips / atrPips) * 100).toFixed(1) : "0.0";

        const { score, grade, breakdown } = scoreSignal(
          {
            createdAfterBOS: bearishBOS,
            prevDaySweep: sweepHigh,
            displacement,
            session,
            atrPercent,
          },
          htfAlignment,
        );

        fvgSignals.push({
          pair,
          type: "bearish",
          time: dayjs(c2.time)
            .tz("Australia/Brisbane")
            .format("YYYY-MM-DD HH:mm"),
          unix: dayjs(c2.time).unix(),

          fvgLow: c3.high,
          fvgHigh: c1.low,

          gapPips: bearishGapPips.toFixed(1),
          atrPips: atrPips.toFixed(1),
          atrPercent,

          createdAfterBOS: bearishBOS,
          prevDaySweep: sweepHigh,
          displacement,

          session,
          fillPercent,

          htfAlignment,
          score,
          grade,
          scoreBreakdown: breakdown,

          entry: entry.toFixed(5),
          stopLoss: (entry + slDistance).toFixed(5),
          takeProfit: (entry - slDistance * 2).toFixed(5),
        });
      }
    }
  }

  return fvgSignals;
}

// ================= HTF ZONE FETCH (NEW) =================
// Pulls currently-unfilled FVG zones from H4 and Daily so the H1 scan can
// score confluence against them. Uses detectFVG purely as a zone-finder
// here (htfZones param omitted -> no recursive HTF scoring needed).
//
// NOTE on cost: this triples API calls per pair (H1 + H4 + D) on every
// run. H4 zones don't meaningfully change more than once every 4h, and
// Daily zones change once a day — if this runs frequently, the better
// long-term setup is a separate cron that scans H4/D into their own
// Mongo collection (e.g. `fvg_htf_zones`) on their own cadence, and have
// this function read from there instead of re-fetching candles every time.
async function getHTFZones(pair, baseMinGap) {
  const zones = [];

  for (const tf of HTF_GRANULARITIES) {
    try {
      const candles = await fetchCandles(pair, tf, HTF_CANDLE_COUNT);
      const signals = detectFVG(candles, pair, baseMinGap, tf);

      signals.forEach((s) =>
        zones.push({
          type: s.type,
          low: parseFloat(s.fvgLow),
          high: parseFloat(s.fvgHigh),
          timeframe: tf,
        }),
      );
    } catch (err) {
      console.error(`  ⚠ HTF fetch failed (${tf}) for ${pair}: ${err.message}`);
    }
  }

  return zones;
}

// ================= SCAN =================

async function scanPair(pairConfig, theGranularity) {
  try {
    console.log(`\n🔍 Scanning ${pairConfig.pair}`);

    const candles = await fetchCandles(
      pairConfig.pair,
      theGranularity,
      CANDLE_COUNT,
    );

    const htfZones = await getHTFZones(pairConfig.pair, pairConfig.baseMinGap);

    const signals = detectFVG(
      candles,
      pairConfig.pair,
      pairConfig.baseMinGap,
      theGranularity,
      htfZones,
    );

    await remove("fvg_forex_deep", {
      pair: pairConfig.pair,
      timeframe: theGranularity,
    });

    // Store the best-scoring unfilled signals, not just whichever one
    // happened to form last chronologically.
    const qualifying = signals
      .filter((s) => s.score >= MIN_SCORE_TO_STORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SIGNALS_PER_PAIR);

    for (const sig of qualifying) {
      sig.instrument = pairConfig.pair;
      sig.timeframe = theGranularity;

      await insert("fvg_forex_deep", sig);
    }

    if (qualifying.length > 0) {
      qualifying.forEach((s) =>
        console.log(
          `  ✓ [${s.grade} ${s.score}] ${s.type} FVG | BOS:${s.createdAfterBOS} ` +
            `Sweep:${s.prevDaySweep} HTF:${s.htfAlignment.timeframes.join("/") || "-"} ` +
            `Fill:${s.fillPercent}%`,
        ),
      );
    } else {
      console.log(
        `  ✓ No FVG cleared the score threshold (${MIN_SCORE_TO_STORE}+)`,
      );
    }

    return signals;
  } catch (err) {
    console.error(`❌ ${pairConfig.pair}: ${err.message}`);
    return [];
  }
}

// ================= MAIN =================

async function scanAllPairs(theGranularity = GRANULARITY) {
  console.log("\n═══════════════════════════════════");
  console.log(`  🔎 FVG SCANNER (ICT) — ${theGranularity} + HTF SCORING`);
  console.log("═══════════════════════════════════");

  let all = [];

  for (const p of FOREX_PAIRS) {
    const s = await scanPair(p, theGranularity);
    all.push(...s);
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("\n═══════════════════════════════════");
  console.log(`  DONE → ${all.length} FVGs found`);
  console.log("═══════════════════════════════════\n");

  return all;
}

module.exports = scanAllPairs;
