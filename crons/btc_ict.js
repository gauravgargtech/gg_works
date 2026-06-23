require("../config/config");

const { sendPushNotif } = require("../config/telegram_notify");
const cron = require("node-cron");

/**
 * BTCUSDT — ICT Confluence Scanner
 * Liquidity Sweep -> FVG -> CHoCH -> Retracement
 *
 * Polls Bybit's public market-data REST API on a fixed interval and checks
 * whether all four conditions are currently aligned. No API key needed —
 * these are public endpoints. Requires Node 18+ (uses global fetch).
 *
 * Run: node btcSweepFvgChochScanner.js
 */

// ================= CONFIG =================

const SYMBOL = "BTCUSDT";
const CATEGORY = "linear"; // "linear" = USDT perpetual, "spot" = spot market
const INTERVAL = "3"; // candle timeframe analyzed (Bybit interval string: 1,3,5,15,30,60,...)
const CANDLE_LIMIT = 400; // candles pulled per poll
const POLL_INTERVAL_MS = 1 * 60 * 1000; // how often this script checks — every 2 minutes

const FRACTAL_WING = 2; // candles each side required for a swing pivot (5-candle fractal)
const SWING_LOOKBACK = 100; // candles scanned back to find the swing point that gets swept
const MAX_SWEEP_TO_FVG = 10; // candles allowed between the sweep and the FVG that should follow it
const MAX_FVG_TO_CHOCH = 15; // candles allowed between the FVG and the CHoCH break

const BYBIT_BASE = "https://api.bybit.com";

if (typeof fetch !== "function") {
  console.error(
    "This script needs Node 18+ for global fetch. Install node-fetch or upgrade Node.",
  );
  process.exit(1);
}

let lastAlertedSweepTime = null; // dedup: don't re-fire the same setup every poll

// ================= BYBIT FETCHERS =================

function intervalToMs(interval) {
  const minuteIntervals = [
    "1",
    "2",
    "3",
    "5",
    "15",
    "30",
    "60",
    "120",
    "240",
    "360",
    "720",
  ];
  if (minuteIntervals.includes(interval)) return Number(interval) * 60 * 1000;
  if (interval === "D") return 24 * 60 * 60 * 1000;
  if (interval === "W") return 7 * 24 * 60 * 60 * 1000;
  return 5 * 60 * 1000;
}

async function fetchKlines() {
  const url = `${BYBIT_BASE}/v5/market/kline?category=${CATEGORY}&symbol=${SYMBOL}&interval=${INTERVAL}&limit=${CANDLE_LIMIT}`;
  const res = await fetch(url);
  const json = await res.json();

  if (json.retCode !== 0) {
    throw new Error(`Bybit kline error: ${json.retMsg}`);
  }

  // Bybit returns newest-first: [startTime, open, high, low, close, volume, turnover]
  const candles = json.result.list
    .map((c) => ({
      time: Number(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }))
    .reverse(); // oldest -> newest

  // Drop the most recent candle if it hasn't closed yet — don't make
  // structure decisions on a still-forming bar.
  const last = candles[candles.length - 1];
  const isClosed = Date.now() >= last.time + intervalToMs(INTERVAL);

  return isClosed ? candles : candles.slice(0, -1);
}

async function fetchLastPrice() {
  const url = `${BYBIT_BASE}/v5/market/tickers?category=${CATEGORY}&symbol=${SYMBOL}`;
  const res = await fetch(url);
  const json = await res.json();

  if (json.retCode !== 0) {
    throw new Error(`Bybit ticker error: ${json.retMsg}`);
  }

  return parseFloat(json.result.list[0].lastPrice);
}

// ================= FRACTAL SWING POINTS =================

function isFractalHigh(candles, i) {
  if (i < FRACTAL_WING || i > candles.length - 1 - FRACTAL_WING) return false;
  for (let w = 1; w <= FRACTAL_WING; w++) {
    if (candles[i].high <= candles[i - w].high) return false;
    if (candles[i].high <= candles[i + w].high) return false;
  }
  return true;
}

function isFractalLow(candles, i) {
  if (i < FRACTAL_WING || i > candles.length - 1 - FRACTAL_WING) return false;
  for (let w = 1; w <= FRACTAL_WING; w++) {
    if (candles[i].low >= candles[i - w].low) return false;
    if (candles[i].low >= candles[i + w].low) return false;
  }
  return true;
}

// ================= 1. LIQUIDITY SWEEP =================
// A sweep = price wicks beyond a recent swing point (taking out resting
// stops/orders) then closes back on the other side of it — the rejection
// that signals the raid is done and a reversal may follow.
function detectSweepAt(candles, idx) {
  const start = Math.max(2, idx - SWING_LOOKBACK);

  let swingHigh = null,
    swingHighIdx = null;
  let swingLow = null,
    swingLowIdx = null;

  for (let j = start; j < idx; j++) {
    if (
      isFractalHigh(candles, j) &&
      (swingHigh === null || candles[j].high > swingHigh)
    ) {
      swingHigh = candles[j].high;
      swingHighIdx = j;
    }
    if (
      isFractalLow(candles, j) &&
      (swingLow === null || candles[j].low < swingLow)
    ) {
      swingLow = candles[j].low;
      swingLowIdx = j;
    }
  }

  const candle = candles[idx];

  // Bearish sweep: wick takes the recent swing high, closes back below it.
  if (
    swingHigh !== null &&
    candle.high > swingHigh &&
    candle.close < swingHigh
  ) {
    return {
      direction: "bearish",
      index: idx,
      time: candle.time,
      sweptLevel: swingHigh,
      sweptLevelIdx: swingHighIdx,
      priorSwingPoint: swingLow, // the minor low CHoCH needs to break for this setup
    };
  }

  // Bullish sweep: wick takes the recent swing low, closes back above it.
  if (swingLow !== null && candle.low < swingLow && candle.close > swingLow) {
    return {
      direction: "bullish",
      index: idx,
      time: candle.time,
      sweptLevel: swingLow,
      sweptLevelIdx: swingLowIdx,
      priorSwingPoint: swingHigh, // the minor high CHoCH needs to break for this setup
    };
  }

  return null;
}

// ================= 2. FVG (displacement after the sweep) =================
function findFvgAfter(candles, sweepIdx, direction) {
  const end = Math.min(candles.length - 1, sweepIdx + MAX_SWEEP_TO_FVG);

  for (let k = sweepIdx + 2; k <= end; k++) {
    const c1 = candles[k - 2];
    const c3 = candles[k];

    if (direction === "bullish" && c1.high < c3.low) {
      return { index: k, low: c1.high, high: c3.low };
    }
    if (direction === "bearish" && c1.low > c3.high) {
      return { index: k, low: c3.high, high: c1.low };
    }
  }
  return null;
}

// ================= 3. CHoCH (first minor structure break) =================
// Distinct from a full BOS: this is the *first* close beyond the minor
// swing point that existed just before the sweep — the earliest signal
// that character has changed, not full confirmation of a new trend.
function findChochAfter(candles, fvgIdx, direction, priorSwingPoint) {
  if (priorSwingPoint === null) return null;

  const end = Math.min(candles.length - 1, fvgIdx + MAX_FVG_TO_CHOCH);

  for (let k = fvgIdx; k <= end; k++) {
    if (direction === "bullish" && candles[k].close > priorSwingPoint) {
      return { index: k, time: candles[k].time, level: priorSwingPoint };
    }
    if (direction === "bearish" && candles[k].close < priorSwingPoint) {
      return { index: k, time: candles[k].time, level: priorSwingPoint };
    }
  }
  return null;
}

// ================= 4. RETRACEMENT into the FVG =================
// inZone: price has traded back into the gap since CHoCH.
// invalidated: price closed back through the original swept level —
// the reversal thesis failed, this setup is dead.
function checkRetracement(candles, chochIdx, fvg, direction, sweep, livePrice) {
  const after = candles.slice(chochIdx + 1);
  const lows = after.map((c) => c.low);
  const highs = after.map((c) => c.high);
  const closes = after.map((c) => c.close);

  if (direction === "bullish") {
    const invalidated =
      closes.some((c) => c < sweep.sweptLevel) || livePrice < sweep.sweptLevel;
    const minLow = Math.min(livePrice, ...(lows.length ? lows : [livePrice]));
    return { invalidated, inZone: minLow <= fvg.high, currentPrice: livePrice };
  }

  const invalidated =
    closes.some((c) => c > sweep.sweptLevel) || livePrice > sweep.sweptLevel;
  const maxHigh = Math.max(livePrice, ...(highs.length ? highs : [livePrice]));
  return { invalidated, inZone: maxHigh >= fvg.low, currentPrice: livePrice };
}

// ================= SEQUENCE SCANNER =================
// Walks backward from the most recent candle looking for the freshest
// sweep that still has a complete (and non-invalidated) sequence after it.
function findActiveSetup(candles, livePrice) {
  const n = candles.length;
  const earliestSweepIdx = SWING_LOOKBACK + 2;
  const latestSweepIdx = n - 3; // leave room for an FVG (needs 2 more candles) after it

  for (let s = latestSweepIdx; s >= earliestSweepIdx; s--) {
    const sweep = detectSweepAt(candles, s);
    if (!sweep) continue;

    const fvg = findFvgAfter(candles, s, sweep.direction);
    if (!fvg) continue;

    const choch = findChochAfter(
      candles,
      fvg.index,
      sweep.direction,
      sweep.priorSwingPoint,
    );
    if (!choch) continue;

    const retracement = checkRetracement(
      candles,
      choch.index,
      fvg,
      sweep.direction,
      sweep,
      livePrice,
    );
    if (retracement.invalidated) continue; // this sequence failed — keep looking at older sweeps

    return { sweep, fvg, choch, retracement, complete: retracement.inZone };
  }

  return null;
}

// ================= MAIN POLL LOOP =================

async function btcICT() {
  const stamp = new Date().toISOString();

  try {
    const candles = await fetchKlines();
    const livePrice = await fetchLastPrice();

    const setup = findActiveSetup(candles, livePrice);

    if (!setup) {
      console.log(
        `[${stamp}] No active sweep→FVG→CHoCH sequence. Price: ${livePrice}`,
      );
      return;
    }

    const { sweep, fvg, choch, retracement, complete } = setup;

    if (!complete) {
      console.log(
        `[${stamp}] Watching ${sweep.direction.toUpperCase()} setup (3/4) — sweep✓ FVG✓ CHoCH✓, ` +
          `waiting for retracement into [${fvg.low.toFixed(1)}, ${fvg.high.toFixed(1)}]. Price: ${livePrice}`,
      );
      return;
    }

    if (lastAlertedSweepTime === sweep.time) {
      console.log(
        `[${stamp}] ${sweep.direction.toUpperCase()} setup still in zone (already alerted). Price: ${livePrice}`,
      );
      return;
    }

    lastAlertedSweepTime = sweep.time;

    console.log("\n🚨🚨🚨 ICT CONFLUENCE ALERT — ALL 4 CONDITIONS MET 🚨🚨🚨");
    await sendPushNotif(
      `BTC ICT 2 Minute: ${sweep.direction.toUpperCase()} setup - ALL 4 CONDITIONS MET`,
    );
    console.log(
      `Symbol: ${SYMBOL} (${CATEGORY}) | Timeframe: ${INTERVAL}m | ${stamp}`,
    );
    console.log(`Bias: ${sweep.direction.toUpperCase()}`);
    console.log(
      `1) Liquidity Sweep @ ${new Date(sweep.time).toISOString()} | swept level: ${sweep.sweptLevel}`,
    );
    console.log(`2) FVG formed | zone: ${fvg.low} - ${fvg.high}`);
    console.log(
      `3) CHoCH confirmed @ ${new Date(choch.time).toISOString()} | broke: ${choch.level}`,
    );
    console.log(
      `4) Retracement into FVG | current price: ${retracement.currentPrice}`,
    );
    console.log("─────────────────────────────────────────\n");
  } catch (err) {
    console.error(`[${stamp}] Scan error: ${err.message}`);
  }
}

module.exports = btcICT;
