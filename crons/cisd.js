require("../config/config");
const https = require("https");

const vortexIndicator = require("../indicators/vortex");

const { set, get, del } = require("../adapters/redis");
const { EMA } = require("technicalindicators");
const calculatePKAMA = require("../indicators/kama");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const { fetchCandles } = require("../exhanges/oanda");

const INSTRUMENT = "USD_CAD";

const OANDA_API_KEY = process.env.OANDA_API_KEY;
const PRACTICE = process?.env?.OANDA_IS_SANDBOX === "true" ? true : false;
const OANDA_BASE_URL = PRACTICE
  ? "https://api-fxpractice.oanda.com"
  : "https://api-fxtrade.oanda.com";

const HTF_GRANULARITY = "H4";
const HTF_COUNT = 4000; // ~ years of 4H data; OANDA hard-caps a single request at 5000
const LTF_GRANULARITY = "M15";
const LTF_COUNT = 1500; // recent 15M window used only for the live entry check

const DISPLACEMENT_MULTIPLIER = 1.5; // trigger candle body > 1.5x trailing avg body
const AVG_BODY_WINDOW = 30; // trailing candles used to compute "average body" (no lookahead)
const MAX_FORWARD_SCAN = 300; // how many candles forward of a leg to search for a CISD trigger
const MIN_LEG_CANDLES = 5; // a leg must span at least this many candles to count as a real run
// (a single candle isn't a delivery leg, it's just candle-to-candle chop —
// without this filter, near-every candle on a choppy 4H pair gets flagged)

// ---------------------------------------------------------------------
// OANDA fetch (with pagination for windows > 5000 candles)
// ---------------------------------------------------------------------

async function fetchOandaBatch(instrument, granularity, count, to) {
  if (!OANDA_API_KEY) {
    throw new Error("Missing OANDA_API_KEY environment variable.");
  }
  const params = new URLSearchParams({
    granularity,
    count: String(count),
    price: "M", // mid price
  });
  if (to) params.set("to", to);

  const url = `${OANDA_BASE_URL}/v3/instruments/${instrument}/candles?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${OANDA_API_KEY}` },
  });

  if (!res.ok) {
    throw new Error(`OANDA API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.candles || [];
}

/**
 * Fetch up to `totalCount` most recent COMPLETE candles, paginating
 * backward in batches of <=5000 since that's OANDA's per-request cap.
 */
async function fetchOandaCandles(instrument, granularity, totalCount) {
  const collected = [];
  let to = undefined; // undefined => most recent candles first batch

  while (collected.length < totalCount) {
    const remaining = totalCount - collected.length;
    const batchCount = Math.min(remaining, 5000);

    const batch = await fetchOandaBatch(
      instrument,
      granularity,
      batchCount,
      to,
    );
    if (batch.length === 0) break; // no more data available

    // prepend this batch (it's older than what we already have)
    collected.unshift(...batch);

    // next batch should end right before the earliest candle we just got
    const earliestTime = batch[0].time;
    to = earliestTime;

    // safety: if OANDA returns the same batch again (no older data left), stop
    if (batch.length < batchCount) break;
  }

  // Trim to requested size (keep the most recent `totalCount`) and normalize
  const trimmed = collected.slice(-totalCount);
  return trimmed
    .filter((c) => c.complete) // drop the currently-forming candle
    .map((c) => ({
      time: c.time, // ISO string, e.g. "2023-05-01T00:00:00.000000000Z"
      open: parseFloat(c.mid.o),
      high: parseFloat(c.mid.h),
      low: parseFloat(c.mid.l),
      close: parseFloat(c.mid.c),
    }));
}

// ---------------------------------------------------------------------
// CISD detection
// ---------------------------------------------------------------------

function body(c) {
  return Math.abs(c.close - c.open);
}
function isBullish(c) {
  return c.close > c.open;
}
function isBearish(c) {
  return c.close < c.open;
}

/** Group candles into runs ("streaks") of consecutive same-direction candles. */
function getStreaks(candles) {
  const streaks = [];
  let dir = null;
  let start = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.close === c.open) continue; // doji: ignore, extends current streak implicitly

    const d = isBullish(c) ? "bullish" : "bearish";
    if (dir === null) {
      dir = d;
      start = i;
      continue;
    }
    if (d !== dir) {
      streaks.push({ direction: dir, start, end: i - 1 });
      dir = d;
      start = i;
    }
  }
  if (dir !== null)
    streaks.push({ direction: dir, start, end: candles.length - 1 });
  return streaks;
}

/** Trailing average body size ending just before `idx` (no lookahead bias). */
function averageBodyBefore(candles, idx, window) {
  const start = Math.max(0, idx - window);
  const slice = candles.slice(start, idx);
  if (slice.length === 0) return 0;
  return slice.reduce((acc, c) => acc + body(c), 0) / slice.length;
}

/**
 * Scan the FULL candle array and return every CISD event found.
 * A CISD event = the first candle, following a directional leg, whose
 * CLOSE breaches the open of the last opposite-colored candle before
 * that leg began. `displacement` flags whether that trigger candle's
 * body was > DISPLACEMENT_MULTIPLIER x the trailing average body.
 */
function findAllCISDs(candles) {
  const streaks = getStreaks(candles);
  const events = [];

  for (let k = 1; k < streaks.length; k++) {
    const leg = streaks[k];
    const legLength = leg.end - leg.start + 1;
    if (legLength < MIN_LEG_CANDLES) continue; // skip chop, not a real leg

    const refStreak = streaks[k - 1];
    const level = candles[refStreak.end].open;
    const cisdDirection = leg.direction === "bearish" ? "bullish" : "bearish";

    const forwardEnd = Math.min(candles.length, leg.end + 1 + MAX_FORWARD_SCAN);

    for (let j = leg.end + 1; j < forwardEnd; j++) {
      const trigger = candles[j];
      const breached =
        cisdDirection === "bullish"
          ? trigger.close > level
          : trigger.close < level;
      if (!breached) continue;

      const avgBody = averageBodyBefore(candles, j, AVG_BODY_WINDOW);
      const displaced =
        avgBody > 0 && body(trigger) > avgBody * DISPLACEMENT_MULTIPLIER;

      events.push({
        direction: cisdDirection,
        level: Number(level.toFixed(5)),
        legDirection: leg.direction,
        legLength,
        legStart: dayjs(candles[leg.start].time)
          .tz("Australia/Brisbane")
          .format(),
        legEnd: dayjs(candles[leg.end].time).tz("Australia/Brisbane").format(),
        triggerIndex: j,
        triggerTime: dayjs(trigger.time).tz("Australia/Brisbane").format(),
        triggerClose: Number(trigger.close.toFixed(5)),
        displacement: displaced,
      });
      break; // first breach = the CISD; move on to the next leg
    }
  }

  return events;
}

// ---------------------------------------------------------------------

async function main() {
  console.log(
    `\n=== ${INSTRUMENT} CISD Historical Scan (${HTF_GRANULARITY}, ${HTF_COUNT} candles) ===\n`,
  );

  const htfCandles = await fetchCandles(INSTRUMENT, HTF_GRANULARITY, HTF_COUNT);
  console.log(
    `Fetched ${htfCandles.length} complete ${HTF_GRANULARITY} candles.`,
  );
  console.log(
    `Range: ${htfCandles[0]?.time} -> ${htfCandles[htfCandles.length - 1]?.time}\n`,
  );

  const allEvents = findAllCISDs(htfCandles);
  const displacedEvents = allEvents.filter((e) => e.displacement);

  console.log(`Total CISD events found: ${allEvents.length}`);
  console.log(`Of which had displacement: ${displacedEvents.length}\n`);

  // Print a readable table for manual cross-checking against your chart
  console.table(
    allEvents.map((e) => ({
      time: e.triggerTime,
      direction: e.direction,
      level: e.level,
      close: e.triggerClose,
      displacement: e.displacement,
    })),
  );

  // Save full results to disk so you can diff against your own chart review
  const fs = await import("fs");
  const outFile = `cisd_events_${INSTRUMENT}_${HTF_GRANULARITY}.json`;
  fs.writeFileSync(outFile, JSON.stringify(allEvents, null, 2));
  console.log(`\nFull event list written to ./${outFile}`);

  // ---- Live entry check: does the most recent HTF CISD align with a fresh LTF CISD? ----
  const latestHtfCISD = allEvents[allEvents.length - 1];
  if (!latestHtfCISD || !latestHtfCISD.displacement) {
    console.log(
      `\n[LTF check] No confirmed (displaced) HTF CISD to build an entry bias from.`,
    );
    return;
  }

  console.log(
    `\n[HTF bias] Most recent confirmed CISD -> ${latestHtfCISD.direction.toUpperCase()} ` +
      `at ${latestHtfCISD.triggerTime} (level ${latestHtfCISD.level})`,
  );

  const ltfCandles = await fetchOandaCandles(
    INSTRUMENT,
    LTF_GRANULARITY,
    LTF_COUNT,
  );
  const ltfEvents = findAllCISDs(ltfCandles);
  const latestLtfCISD = ltfEvents[ltfEvents.length - 1];

  if (!latestLtfCISD) {
    console.log(
      `[LTF check] No CISD yet on ${LTF_GRANULARITY}. Waiting for entry confirmation.`,
    );
    return;
  }

  if (
    latestLtfCISD.direction !== latestHtfCISD.direction ||
    !latestLtfCISD.displacement
  ) {
    console.log(
      `[LTF check] Latest ${LTF_GRANULARITY} CISD (${latestLtfCISD.direction}, ` +
        `displacement: ${latestLtfCISD.displacement}) does not align with HTF bias. No entry yet.`,
    );
    return;
  }

  console.log(`\n>>> ENTRY PLAN CAN BE CONSIDERED <<<`);
  console.log(
    JSON.stringify(
      {
        instrument: INSTRUMENT,
        bias: latestHtfCISD.direction,
        htf_level: latestHtfCISD.level,
        htf_confirmed_at: latestHtfCISD.triggerTime,
        ltf_level: latestLtfCISD.level,
        ltf_confirmed_at: latestLtfCISD.triggerTime,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("Error running CISD scan:", err.message);
  process.exit(1);
});
