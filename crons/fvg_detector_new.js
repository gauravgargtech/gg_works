require("../config/config");

const { ATR } = require("technicalindicators");
const { fetchCandles } = require("../exhanges/oanda");
const { insert, remove, find } = require("../adapters/mongo");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { sendPushNotif } = require("../config/telegram_notify");

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

const CANDLE_COUNT = 800; // primary (H4) lookback
const HTF_CANDLE_COUNT = 200; // HTF zones only need recent history, not years of them
const GRANULARITY = "H4"; // primary scan timeframe — was M15/H1, now matches the H4 BOS bias
const HTF_GRANULARITIES = ["D", "W"]; // confluence timeframes — one and two steps above H4
const ATR_PERIOD = 14;

// Candles-per-trading-day, keyed by granularity, so prevDaySweep()'s
// lookback window is correct regardless of which timeframe this is run on.
const CANDLES_PER_DAY_MAP = {
  M5: 288,
  M15: 96,
  M30: 48,
  H1: 24,
  H4: 6,
  D: 1,
  W: 1, // weekly bars: "previous day" window collapses to "previous bar"
};

const BOS_FRACTAL_LOOKBACK = 20; // candles scanned back for the last fractal swing (primary TF)

// Score gating: only persist signals that clear a minimum quality bar,
// and only keep the best N per pair instead of whatever happened to be
// chronologically last.
const MIN_SCORE_TO_STORE = 40; // grade C and above
const MAX_SIGNALS_PER_PAIR = 3;

// ================= LTF RETRACEMENT / CHOCH CONFIRMATION =================
// Recommendation: M15. With the primary scan now on H4, the H4:M15 ratio
// (16:1) is roughly the same scale as a typical H1:M5 setup — fine enough
// to react same-day, coarse enough that swings still mean something.
// M5 under an H4 zone is a 48:1 ratio and throws a lot of false CHoCH
// flags from pure intrabar noise. Swap the constant below if you want to
// experiment with M5 anyway.
const LTF_GRANULARITY = "M5";
const LTF_FRACTAL_LOOKBACK = 10; // smaller swing lookback, appropriate for M15
const LTF_CANDLE_COUNT = 400;

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

// ================= LTF STRUCTURE BREAKS (BOS/CHoCH) =================
// Stateful fractal-swing tracker for the LTF confirmation pass: walks
// forward through candles, tracks the last fractal high/low, and labels
// each break as BOS (continuation of the prevailing break direction) or
// CHoCH (the break direction flipped) — same concept as detectBOS() above,
// but accumulated across a series instead of evaluated at a single index.
function detectStructureBreaks(candles, lookback) {
  const breaks = [];
  let lastFractalHigh = null;
  let lastFractalLow = null;
  let prevBreakoutDir = 0; // 1 = last break bullish, -1 = bearish

  for (let i = lookback; i < candles.length - 2; i++) {
    if (isFractalHigh(candles, i)) lastFractalHigh = candles[i].high;
    if (isFractalLow(candles, i)) lastFractalLow = candles[i].low;

    const close = candles[i].close;

    if (lastFractalHigh && close > lastFractalHigh) {
      const isChoch = prevBreakoutDir === -1;
      breaks.push({
        type: isChoch ? "CHoCH" : "BOS",
        direction: "bullish",
        price: lastFractalHigh,
        time: dayjs(candles[i].time)
          .tz("Australia/Brisbane")
          .format("YYYY-MM-DD HH:mm:ss"),
      });
      prevBreakoutDir = 1;
      lastFractalHigh = null; // require a fresh fractal before the next break counts
    }

    if (lastFractalLow && close < lastFractalLow) {
      const isChoch = prevBreakoutDir === 1;
      breaks.push({
        type: isChoch ? "CHoCH" : "BOS",
        direction: "bearish",
        price: lastFractalLow,
        time: dayjs(candles[i].time)
          .tz("Australia/Brisbane")
          .format("YYYY-MM-DD HH:mm:ss"),
      });
      prevBreakoutDir = -1;
      lastFractalLow = null;
    }
  }

  return breaks;
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
// Window size is derived from granularity instead of a hardcoded value.
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

// ================= HTF CONFLUENCE =================
// Checks whether a primary-TF FVG zone overlaps a currently-unfilled HTF
// FVG zone. Same-direction overlap scores higher than opposite-direction
// overlap. Weekly is weighted above Daily since it's now the larger of
// the two confluence timeframes (primary scan is H4).
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
  if (timeframes.includes("W")) {
    points += sameDirection.some((m) => m.timeframe === "W") ? 25 : 10;
  }
  if (timeframes.includes("D")) {
    points += sameDirection.some((m) => m.timeframe === "D") ? 15 : 5;
  }

  return {
    aligned: true,
    timeframes,
    sameDirection: sameDirection.length > 0,
    points: Math.min(points, 30), // cap so HTF confluence stays one component, not the whole score
  };
}

// ================= SCORING ENGINE =================
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

  // D / W FVG overlap.
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

// ================= HTF ZONE FETCH =================
// Pulls currently-unfilled FVG zones from Daily and Weekly so the H4 scan
// can score confluence against them. Uses detectFVG purely as a zone-finder
// here (htfZones param omitted -> no recursive HTF scoring needed).
//
// NOTE on cost: this triples API calls per pair (H4 + D + W) on every run.
// Daily zones don't meaningfully change more than once a day, and Weekly
// changes once a week — if this runs frequently, the better long-term
// setup is a separate cron that scans D/W into their own Mongo collection
// (e.g. `fvg_htf_zones`) on their own cadence, and have this function read
// from there instead of re-fetching candles every time.
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
      sig.confirmed = false; // flips true once LTF retracement + CHoCH fires

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

// ================= MAIN: PRIMARY (H4) SCAN =================

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

// ================= STEP 2: LTF RETRACEMENT + CHOCH CONFIRMATION =================
// Run this on a tighter schedule than scanAllPairs (e.g. every 15 min via
// cron). For every stored H4 FVG that hasn't been confirmed yet, pulls
// LTF (M15 by default) candles, checks whether price has retraced into
// the FVG zone, and if so watches LTF structure for a CHoCH matching the
// FVG's direction — the signal that the pullback is over and the H4 move
// is resuming.
async function checkRetracementAndCHoCH(ltfGranularity = LTF_GRANULARITY) {
  const pending = await find("fvg_forex_deep", { confirmed: false });

  for (const sig of pending) {
    const {
      instrument: pair,
      timeframe,
      type,
      fvgLow,
      fvgHigh,
      unix,
      time: bosTime,
    } = sig;

    let candles;
    try {
      candles = await fetchCandles(pair, ltfGranularity, LTF_CANDLE_COUNT);
    } catch (err) {
      console.error(`  ⚠ LTF fetch failed for ${pair}: ${err.message}`);
      continue;
    }

    // only look at LTF candles that happened after the FVG itself formed
    const postFvg = candles.filter((c) => dayjs(c.time).unix() > unix);
    if (postFvg.length < LTF_FRACTAL_LOOKBACK + 5) continue;

    // has price retraced into the FVG zone yet, on the LTF feed?
    const tagIdx = postFvg.findIndex(
      (c) => c.low <= fvgHigh && c.high >= fvgLow,
    );
    if (tagIdx === -1) continue; // hasn't come back into the zone yet

    const sinceTag = postFvg.slice(tagIdx);
    if (sinceTag.length < LTF_FRACTAL_LOOKBACK + 5) continue; // give it bars to form structure

    const breaks = detectStructureBreaks(sinceTag, LTF_FRACTAL_LOOKBACK);
    const choch = breaks.find(
      (b) => b.type === "CHoCH" && b.direction === type,
    );
    if (!choch) continue;

    const timeDiff = dayjs(candles[candles.length - 1].time).diff(
      bosTime,
      "hours",
    );

    if (timeDiff > 150) {
      continue;
    }

    const record = {
      pair,
      direction: type,
      htfTimeframe: timeframe,
      ltfGranularity,
      fvgLow,
      fvgHigh,
      fvgUnix: unix,
      tagTime: sinceTag[0].time,
      chochTime: choch.time,
      chochPrice: choch.price,
      score: sig.score,
      grade: sig.grade,
      loggedAt: dayjs().tz("Australia/Brisbane").format("YYYY-MM-DD HH:mm:ss"),
    };

    await remove("fvg_choch_signals", { pair, fvgUnix: unix });
    await insert("fvg_choch_signals", record);

    await sendPushNotif(
      `FVG at Level:  ${pair}: ${type.toUpperCase()} H4 FVG retraced + ${ltfGranularity} CHoCH confirmed ` +
        `@ ${choch.price} grade ${sig.grade}`,
    );

    await remove("fvg_forex_deep", { instrument: pair, timeframe, unix });
    await insert("fvg_forex_deep", {
      ...sig,
      confirmed: true,
      confirmedAt: record.loggedAt,
    });

    console.log(
      `🚀 ${pair}: ${type.toUpperCase()} H4 FVG retraced + ${ltfGranularity} CHoCH confirmed ` +
        `@ ${choch.price} (${choch.time}) | grade ${sig.grade}`,
    );

    await new Promise((r) => setTimeout(r, 300));
  }
}

module.exports = { scanAllPairs, checkRetracementAndCHoCH };
