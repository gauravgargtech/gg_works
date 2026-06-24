require("../config/config");
const https = require("https");

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

// ─── Config ────────────────────────────────────────────────
const API_KEY = process.env.OANDA_API_KEY || "YOUR_OANDA_API_KEY_HERE";
const BASE_HOST = "api-fxpractice.oanda.com"; // Demo endpoint
const INSTRUMENT = "AUD_USD";
const GRANULARITY = "H4";
const CANDLE_COUNT = parseInt(process.env.CANDLE_COUNT || "100", 10);
const MIN_GAP_PIPS = "10";
const POLL_MINUTES = process.env.POLL_MINUTES
  ? parseFloat(process.env.POLL_MINUTES)
  : null;

const ATR = require("technicalindicators").ATR;

const { insert, remove, find } = require("../adapters/mongo");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const { fetchCandles } = require("../exhanges/oanda");

const { get, set } = require("../adapters/redis");
// ─── FVG Detection ──────────────────────────────────────────
/**
 * Fair Value Gap (3-candle imbalance pattern):
 *
 *   BULLISH FVG → candle[i+2].low  > candle[i].high
 *     Gap zone  = [ candle[i].high , candle[i+2].low  ]
 *     Price left an unfilled space on the way UP.
 *
 *   BEARISH FVG → candle[i+2].high < candle[i].low
 *     Gap zone  = [ candle[i+2].high, candle[i].low   ]
 *     Price left an unfilled space on the way DOWN.
 *
 * An FVG is "filled" once a later candle's body closes inside the gap.
 */
async function detectFVGs(candles, instrument) {
  const fvgs = [];

  const instrumentDetails = await get(instrument);
  const pipSize = instrumentDetails.tickSize;

  for (let i = 0; i <= candles.length - 3; i++) {
    const c1 = candles[i];
    const c2 = candles[i + 1];
    const c3 = candles[i + 2];

    // ── Bullish FVG ──────────────────────────────────────
    if (c3.low > c1.high) {
      const gapLow = c1.high;
      const gapHigh = c3.low;
      const gapPips = (gapHigh - gapLow) / pipSize;

      if (gapPips >= MIN_GAP_PIPS) {
        const filled = isFilled(candles, i + 3, gapLow, gapHigh, "BULLISH");
        fvgs.push({
          instrument: instrument,
          type: "BULLISH",
          gapLow,
          gapHigh,
          gapPips: gapPips.toFixed(1),
          candle1: dayjs(c1.time).tz(BRISBANE_TZ).format("YYYY-MM-DD HH:mm:ss"),
          candle2: dayjs(candles[i + 1].time)
            .tz(BRISBANE_TZ)
            .format("YYYY-MM-DD HH:mm:ss"),
          candle3: dayjs(c3.time).tz(BRISBANE_TZ).format("YYYY-MM-DD HH:mm:ss"),
          candle3_unix: dayjs(c3.time).tz(BRISBANE_TZ).unix(),
          candle2_high: c2.high,
          candle2_low: c2.low,
          filled,
          status: filled ? "FILLED" : "ACTIVE",
        });
      }
    }

    // ── Bearish FVG ──────────────────────────────────────
    if (c3.high < c1.low) {
      const gapLow = c3.high;
      const gapHigh = c1.low;
      const gapPips = (gapHigh - gapLow) / pipSize;

      if (gapPips >= MIN_GAP_PIPS) {
        const filled = isFilled(candles, i + 3, gapLow, gapHigh, "BEARISH");
        fvgs.push({
          instrument: instrument,
          type: "BEARISH",
          gapLow,
          gapHigh,
          gapPips: gapPips.toFixed(1),
          candle1: dayjs(c1.time).tz(BRISBANE_TZ).format("YYYY-MM-DD HH:mm:ss"),
          candle2: dayjs(candles[i + 1].time)
            .tz(BRISBANE_TZ)
            .format("YYYY-MM-DD HH:mm:ss"),
          candle2_high: c2.high,
          candle2_low: c2.low,
          candle3: dayjs(c3.time).tz(BRISBANE_TZ).format("YYYY-MM-DD HH:mm:ss"),
          candle3_unix: dayjs(c3.time).tz(BRISBANE_TZ).unix(),
          filled,
          status: filled ? "FILLED" : "ACTIVE",
        });
      }
    }
  }

  return fvgs;
}

/**
 * Check if any subsequent candle's body overlaps the gap zone.
 * A gap is considered filled when price trades back into it.
 */
function isFilled(candles, fromIndex, gapLow, gapHigh, type) {
  for (let j = fromIndex; j < candles.length; j++) {
    const c = candles[j];
    const bodyHigh = Math.max(c.open, c.close);
    const bodyLow = Math.min(c.open, c.close);

    if (type === "BULLISH" && bodyLow <= gapHigh && bodyHigh >= gapLow) {
      return true;
    }
    if (type === "BEARISH" && bodyHigh >= gapLow && bodyLow <= gapHigh) {
      return true;
    }
  }
  return false;
}

// ─── Formatting helpers ─────────────────────────────────────
const fmt = (n, d = 5) => Number(n).toFixed(d);
const ts = (iso) => new Date(iso).toUTCString();
const hr = (ch = "─", len = 55) => ch.repeat(len);
const icon = (type, status) => {
  if (status === "FILLED") return "✅";
  return type === "BULLISH" ? "🟢" : "🔴";
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Main scan logic ─────────────────────────────────────────
async function fvgDetector(theTimeFrame = "H4") {
  const now = new Date().toUTCString();

  for (const instruments of FOREX_PAIRS) {
    const instrument = instruments.pair;

    console.log(`SYmbol is : ${instrument}`);
    await sleep(1000);

    let candles;
    try {
      candles = await fetchCandles(instrument, theTimeFrame);
    } catch (err) {
      console.error("❌ Failed to fetch candles:", err.message);
      return;
    }

    console.log(`  ✔  Fetched ${candles.length} completed H4 candles`);
    console.log(`  ✔  Min gap filter: ${MIN_GAP_PIPS} pips\n`);

    const allFVGs = await detectFVGs(candles, instrument);
    const activeFVGs = allFVGs.filter((f) => f.status === "ACTIVE");
    const filledFVGs = allFVGs.filter((f) => f.status === "FILLED");

    if (activeFVGs.length === 0) {
      continue;
    }

    const latestFVG = activeFVGs[activeFVGs.length - 1];

    if (latestFVG.gapPips < instruments.baseMinGap) {
      continue;
    }

    let lookbackCandles = 20;
    let startToLook = false;
    let isBOS = true;

    const reversedCandles = candles.reverse();
    for (const cc of reversedCandles) {
      if (dayjs(cc.brisbaneTime).diff(latestFVG.candle2, "minute") === 0) {
        startToLook = true;
      }
      if (startToLook) {
        if (latestFVG.type === "BULLISH" && cc.high > latestFVG.candle2_high) {
          isBOS = false;
        } else if (
          latestFVG.type === "BEARISH" &&
          cc.low < latestFVG.candle2_low
        ) {
          isBOS = false;
        }
        lookbackCandles--;
        if (lookbackCandles === 0) {
          break;
        }
      }
    }

    latestFVG.isBOS = isBOS;
    latestFVG.direction = latestFVG.type;
    latestFVG.score = latestFVG.isBOS ? "A" : "B";
    latestFVG.timeframe = theTimeFrame;
    latestFVG.instrument = instrument;
    latestFVG.time = latestFVG.candle2;
    latestFVG.unix = latestFVG.candle3_unix;

    const allExisting = await find("fvg_forex_deep", {
      instrument: instrument,
      timeframe: theTimeFrame,
      unix: latestFVG.unix,
    });

    if (allExisting.length > 0) continue;
    await remove("fvg_forex_deep", {
      instrument: instrument,
      timeframe: theTimeFrame,
    });

    await insert("fvg_forex_deep", latestFVG);
  }
  return;
}

module.exports = fvgDetector;
