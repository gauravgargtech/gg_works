require("../config/config");
const ATR = require("technicalindicators").ATR;

const { fetchCandles } = require("../exhanges/oanda");
const { insert, remove } = require("../adapters/mongo");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const FOREX_PAIRS = [
  { pair: "EUR_USD", tier: 1, baseMinGap: 10 },
  { pair: "GBP_USD", tier: 1, baseMinGap: 10 },
  { pair: "AUD_USD", tier: 1, baseMinGap: 10 },
  { pair: "NZD_USD", tier: 1, baseMinGap: 10 },
  { pair: "USD_JPY", tier: 1, baseMinGap: 10 },
  { pair: "USD_CHF", tier: 1, baseMinGap: 10 },
  { pair: "USD_CAD", tier: 1, baseMinGap: 10 },
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

const CANDLE_COUNT = 500;
const GRANULARITY = "H4";
const ATR_PERIOD = 14;

// Helper: Convert price difference to pips
function toPips(pair, priceDiff) {
  if (pair.toLowerCase().includes("jpy")) {
    return priceDiff * 100;
  }
  return priceDiff * 10000;
}

// Helper: Format timestamp
function formatTime(time) {
  return new Date(time).toLocaleString();
}

// Calculate ATR from candles (simplified structure)
function calculateATR(candles, period) {
  if (!candles || candles.length < period + 1) return 0;

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);

  const atrValues = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period,
  });
  return atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
}

// Detect FVG - CORRECTED LOGIC
function detectFVG(candles, pair, baseMinGap) {
  const fvgSignals = [];

  if (!candles || candles.length < 3) return fvgSignals;

  // Calculate ATR for dynamic threshold
  let atrValue = baseMinGap / 0.25;
  try {
    const atr = calculateATR(candles, ATR_PERIOD);
    if (atr && !isNaN(atr) && atr > 0) atrValue = atr;
  } catch (err) {
    // Use default
  }

  const minGapPips = Math.max(baseMinGap, toPips(pair, atrValue) * 0.25);

  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];

    // ========== BULLISH FVG ==========
    // Bullish reversal: C1 bearish (close < open), C2 bullish (close > open)
    // Gap is between C1's LOW and C2's LOW
    const c1Bearish = c1.close < c1.open;
    const c2Bullish = c2.close > c2.open;

    if (c1Bearish && c2Bullish) {
      const gapLow = Math.min(c1.low, c2.low);
      const gapHigh = Math.max(c1.low, c2.low);
      const gapPips = toPips(pair, gapHigh - gapLow);

      // Untouched: C3's LOW is ABOVE gapHigh (no wick or body enters the gap)
      const isUntouched = c3.low > gapHigh;

      if (isUntouched && gapPips >= minGapPips) {
        fvgSignals.push({
          type: "bullish",
          pair: pair,
          time: dayjs(c2.time)
            .tz("Australia/Brisbane")
            .format("YYYY-MM-DD HH:mm"),
          gapPips: gapPips.toFixed(1),
          minRequired: minGapPips.toFixed(1),
          atr: toPips(pair, atrValue).toFixed(1),
          entryZone: `${gapLow.toFixed(5)} - ${gapHigh.toFixed(5)}`,
          currentPrice: c3.close.toFixed(5),
          stopLoss: (gapLow - gapPips / 10000).toFixed(5),
          takeProfit: (c3.close + (gapPips / 10000) * 1.5).toFixed(5),
        });
      }
    }

    // ========== BEARISH FVG ==========
    // Bearish reversal: C1 bullish (close > open), C2 bearish (close < open)
    // Gap is between C1's HIGH and C2's HIGH
    const c1Bullish = c1.close > c1.open;
    const c2Bearish = c2.close < c2.open;

    if (c1Bullish && c2Bearish) {
      const gapLow = Math.min(c1.high, c2.high);
      const gapHigh = Math.max(c1.high, c2.high);
      const gapPips = toPips(pair, gapHigh - gapLow);

      // Untouched: C3's HIGH is BELOW gapLow
      const isUntouched = c3.high < gapLow;

      if (isUntouched && gapPips >= minGapPips) {
        fvgSignals.push({
          type: "bearish",
          pair: pair,
          time: dayjs(c2.time)
            .tz("Australia/Brisbane")
            .format("YYYY-MM-DD HH:mm"),
          gapPips: gapPips.toFixed(1),
          minRequired: minGapPips.toFixed(1),
          atr: toPips(pair, atrValue).toFixed(1),
          entryZone: `${gapLow.toFixed(5)} - ${gapHigh.toFixed(5)}`,
          currentPrice: c3.close.toFixed(5),
          stopLoss: (gapHigh + gapPips / 10000).toFixed(5),
          takeProfit: (c3.close - (gapPips / 10000) * 1.5).toFixed(5),
        });
      }
    }
  }

  return fvgSignals;
}

// DEBUG: Print all gaps found
function debugGaps(candles, pair) {
  console.log(`\n  🔍 Debugging ${pair} - scanning for ANY gaps:`);
  let found = 0;

  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1];
    const c3 = candles[i];

    // Check bullish reversal gaps
    if (c1.close < c1.open && c2.close > c2.open) {
      const gapPips = toPips(pair, Math.abs(c1.low - c2.low));
      const untouched = c3.low > Math.max(c1.low, c2.low);
      if (gapPips > 5) {
        found++;
        console.log(
          `    [${found}] BULLISH gap: ${gapPips.toFixed(1)} pips | untouched: ${untouched} | C3 low: ${c3.low} | gap high: ${Math.max(c1.low, c2.low)}`,
        );
      }
    }

    // Check bearish reversal gaps
    if (c1.close > c1.open && c2.close < c2.open) {
      const gapPips = toPips(pair, Math.abs(c1.high - c2.high));
      const untouched = c3.high < Math.min(c1.high, c2.high);
      if (gapPips > 5) {
        found++;
        console.log(
          `    [${found}] BEARISH gap: ${gapPips.toFixed(1)} pips | untouched: ${untouched} | C3 high: ${c3.high} | gap low: ${Math.min(c1.high, c2.high)}`,
        );
      }
    }
  }

  if (found === 0) console.log(`    No gaps >5 pips found`);
}

// Scan a single pair
async function scanPair(pairConfig) {
  try {
    console.log(`\n🔍 Scanning ${pairConfig.pair}...`);

    const candles = await fetchCandles(
      pairConfig.pair,
      GRANULARITY,
      CANDLE_COUNT,
    );
    console.log(`  ✓ Fetched ${candles.length} candles`);

    const fvgSignals = detectFVG(
      candles,
      pairConfig.pair,
      pairConfig.baseMinGap,
    );

    await remove("fvg_forex_deep", { pair: pairConfig.pair });

    if (fvgSignals.length > 0) {
      const recentFVG = fvgSignals[fvgSignals.length - 1];

      recentFVG.instrument = pairConfig.pair;
      recentFVG.unix = dayjs(recentFVG.time).tz("Australia/Brisbane").unix();

      await insert("fvg_forex_deep", recentFVG);
    } else {
      console.log(`  ✓ No strong FVG detected`);
    }
    return fvgSignals;
  } catch (error) {
    console.error(`  ❌ Error scanning ${pairConfig.pair}: ${error.message}`);
    return [];
  }
}

// Scan all pairs
async function scanAllPairs() {
  console.log("═══════════════════════════════════════════════");
  console.log("  🔎 OANDA 4H FVG SCANNER");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Granularity: ${GRANULARITY}`);
  console.log(`  Candles per pair: ${CANDLE_COUNT}`);
  console.log(`  Pairs: ${FOREX_PAIRS.length}`);
  console.log("═══════════════════════════════════════════════\n");

  let allSignals = [];

  for (const pairConfig of FOREX_PAIRS) {
    const signals = await scanPair(pairConfig);
    allSignals.push(...signals);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log("\n═══════════════════════════════════════════════");
  console.log(`  📊 SCAN COMPLETE - Found ${allSignals.length} strong FVGs`);
  console.log("═══════════════════════════════════════════════\n");

  return allSignals;
}

module.exports = scanAllPairs;
