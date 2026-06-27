require("../config/config");
const https = require("https");

const GRANULARITY = "H4";
const CANDLE_COUNT = parseInt(process.env.CANDLE_COUNT || "100", 10);
const MIN_GAP_PIPS = "50";
const POLL_MINUTES = process.env.POLL_MINUTES
  ? parseFloat(process.env.POLL_MINUTES)
  : null;

const ATR = require("technicalindicators").ATR;

const { insert, remove, find } = require("../adapters/mongo");
const { sendPushNotif } = require("../config/telegram_notify");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);
const customParseFormat = require("dayjs/plugin/customParseFormat");

dayjs.extend(customParseFormat);

const { fetchCandles } = require("../exhanges/bybit_public");

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
async function detectFVGs(candles) {
  const fvgs = [];

  for (let i = 0; i <= candles.length - 3; i++) {
    const c1 = candles[i];
    const c2 = candles[i + 1];
    const c3 = candles[i + 2];

    // ── Bullish FVG ──────────────────────────────────────
    if (c3.low > c1.high) {
      const gapLow = c1.high;
      const gapHigh = c3.low;
      const gapPips = gapHigh - gapLow;

      if (gapPips >= MIN_GAP_PIPS) {
        const filled = isFilled(candles, i + 3, gapLow, gapHigh, "BULLISH");
        fvgs.push({
          type: "BULLISH",
          gapLow,
          gapHigh,
          gapPips: gapPips.toFixed(1),
          candle1: c1.time,
          candle2: candles[i + 1].time,
          candle3: c3.time,
          candle3_unix: dayjs(c3.time).tz(BRISBANE_TZ).unix(),
          candle2_high: c2.high,
          candle2_low: c2.low,
          candle3_high: c3.high,
          candle3_low: c3.low,
          filled,
          status: filled ? "FILLED" : "ACTIVE",
        });
      }
    }

    // ── Bearish FVG ──────────────────────────────────────
    if (c3.high < c1.low) {
      const gapLow = c3.high;
      const gapHigh = c1.low;
      const gapPips = gapHigh - gapLow;

      if (gapPips >= MIN_GAP_PIPS) {
        const filled = isFilled(candles, i + 3, gapLow, gapHigh, "BEARISH");
        fvgs.push({
          type: "BEARISH",
          gapLow,
          gapHigh,
          gapPips: gapPips.toFixed(1),
          candle1: c1.time,
          candle2: candles[i + 1].time,
          candle2_high: c2.high,
          candle2_low: c2.low,
          candle3_high: c3.high,
          candle3_low: c3.low,
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
async function fvgDetectorBTC(theTimeFrame = "H4") {
  const now = new Date().toUTCString();

  const candles = await fetchCandles("BTCUSDT", "1", 200);

  console.log(
    `\n${now} ── FVG DETECTOR ──────────────────────────────────────────────`,
  );

  const allFVGs = await detectFVGs(candles);
  const activeFVGs = allFVGs.filter((f) => f.status === "ACTIVE");
  const filledFVGs = allFVGs.filter((f) => f.status === "FILLED");

  if (allFVGs.length === 0) {
    return;
  }

  const latestFVG = allFVGs[allFVGs.length - 1];

  let lookbackCandles = 20;
  let startToLook = false;
  let isBOS = true;

  const reversedCandles = candles.reverse();

  const candle2Distance = latestFVG.candle2_high - latestFVG.candle2_low;

  const candle3Distance = latestFVG.candle3_high - latestFVG.candle3_low;

  let theLow;

  let theHigh;

  if (candle2Distance > candle3Distance) {
    theHigh = latestFVG.candle2_high;
  } else {
    theHigh = latestFVG.candle3_high;
  }

  if (candle2Distance > candle3Distance) {
    theLow = latestFVG.candle2_low;
  } else {
    theLow = latestFVG.candle3_low;
  }

  for (const cc of reversedCandles) {
    const d1 = dayjs(cc.openTime, "YYYY-MM-DD HH:mm:ss");
    const d2 = dayjs(latestFVG.candle2, "DD/MM/YYYY, hh:mm:ss a");

    if (d1.diff(d2, "minute") <= lookbackCandles) {
      startToLook = true;
    }

    if (startToLook) {
      if (latestFVG.type === "BULLISH" && cc.low >= theLow) {
        isBOS = false;
      } else if (latestFVG.type === "BEARISH" && cc.high < theHigh) {
        isBOS = false;
      }
      lookbackCandles--;
      if (lookbackCandles === 0) {
        break;
      }
    }
  }

  console.log(`Latest FVG at ${latestFVG.candle2} is: ${latestFVG.type}`);
  console.log(`Latest BOS is :  ${isBOS}`);

  if (isBOS) {
    const isCC = await get("btc_fvg_bos_deceted");

    if (!isCC) {
      await sendPushNotif(
        `BTC FVG  with BOS is detected. Price: ${latestFVG.candle2_high.toFixed(1)} `,
      );
      await set("btc_fvg_bos_deceted", "11", 300);
      console.log(
        `BTC FVG  with BOS is detected. Price: ${latestFVG.candle2_high.toFixed(1)} `,
      );
    }
  }
}

module.exports = fvgDetectorBTC;
