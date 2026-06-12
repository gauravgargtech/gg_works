require("../config/config");
const https = require("https");

// ─── Config ────────────────────────────────────────────────
const API_KEY = process.env.OANDA_API_KEY || "YOUR_OANDA_API_KEY_HERE";
const BASE_HOST = "api-fxpractice.oanda.com"; // Demo endpoint
const INSTRUMENT = "AUD_USD";
const GRANULARITY = "H4";
const CANDLE_COUNT = parseInt(process.env.CANDLE_COUNT || "100", 10);
const MIN_GAP_PIPS = parseFloat(process.env.MIN_GAP_PIPS || "3");
const POLL_MINUTES = process.env.POLL_MINUTES
  ? parseFloat(process.env.POLL_MINUTES)
  : null;

const { insert, remove } = require("../adapters/mongo");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

// AUD_USD pip = 0.0001
const PIP_SIZE = 0.0001;

const { fetchCandles } = require("../exhanges/oanda");

// ─── HTTP helper ────────────────────────────────────────────
function get(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_HOST,
      path,
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(
            new Error(
              `HTTP ${res.statusCode} — ${res.statusMessage}\nBody: ${raw}`,
            ),
          );
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("JSON parse failed: " + raw.slice(0, 300)));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

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
function detectFVGs(candles, instrument) {
  const fvgs = [];

  for (let i = 0; i <= candles.length - 3; i++) {
    const c1 = candles[i];
    const c3 = candles[i + 2];

    // ── Bullish FVG ──────────────────────────────────────
    if (c3.low > c1.high) {
      const gapLow = c1.high;
      const gapHigh = c3.low;
      const gapPips = (gapHigh - gapLow) / PIP_SIZE;

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
          filled,
          status: filled ? "FILLED" : "ACTIVE",
        });
      }
    }

    // ── Bearish FVG ──────────────────────────────────────
    if (c3.high < c1.low) {
      const gapLow = c3.high;
      const gapHigh = c1.low;
      const gapPips = (gapHigh - gapLow) / PIP_SIZE;

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
async function fvgDetector() {
  const now = new Date().toUTCString();

  for (const instrument of FOREX_PAIRS) {
    console.log(`SYmbol is : ${instrument}`);
    await sleep(1000);
    let candles;
    try {
      candles = await fetchCandles(instrument, "H4");
    } catch (err) {
      console.error("❌ Failed to fetch candles:", err.message);
      return;
    }

    console.log(`  ✔  Fetched ${candles.length} completed H4 candles`);
    console.log(`  ✔  Min gap filter: ${MIN_GAP_PIPS} pips\n`);

    const allFVGs = detectFVGs(candles, instrument);
    const activeFVGs = allFVGs.filter((f) => f.status === "ACTIVE");
    const filledFVGs = allFVGs.filter((f) => f.status === "FILLED");
    await remove("fvg_forex", { instrument: instrument });

    if (activeFVGs.length > 0) {
      await insert("fvg_forex", activeFVGs[activeFVGs.length - 1]);
    }
  }
  return;
}

module.exports = fvgDetector;
