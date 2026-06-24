require("../config/config");
const { insert, remove, find } = require("../adapters/mongo");
const { PineTS, Provider } = require("pinets");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { sendPushNotif } = require("../config/telegram_notify");

const { fetchCandles } = require("../exhanges/oanda");

dayjs.extend(utc);
dayjs.extend(timezone);

let formatted;

/* ---------------------------------------------------------------------
 * LTF confirmation config
 *
 * CONFIRM_GRANULARITY:
 *   "M15" -> sweep + CHoCH only (recommended default, see notes below)
 *   "M5"  -> sweep + CHoCH (+ BOS if REQUIRE_BOS_AFTER_CHOCH = true)
 *
 * REQUIRE_BOS_AFTER_CHOCH:
 *   false -> entry triggers on the sweep + CHoCH alone
 *   true  -> entry waits for an additional same-direction BOS after
 *            the CHoCH (stacks 3 confirmations - much later entry,
 *            only really makes sense on M5 since M15 BOS-after-CHoCH
 *            would be very lagging on top of an already-HTF setup)
 *
 * Why M15 sweep+CHoCH is the recommended default:
 *  - 4H bias -> 15M structure shift is a standard SMC timeframe
 *    pairing; M5 is one extra step down and mostly adds noise here.
 *  - M15 swing points are far less prone to false/noise sweeps than
 *    M5, where spread and micro-wicks trigger spurious sweep signals.
 *  - Requiring a BOS *after* the CHoCH on top of the sweep means you
 *    enter after the new direction has already partly played out -
 *    you give up a chunk of the retracement-zone edge you set this
 *    whole pipeline up to capture.
 *  - If you want a tighter execution price, do that on M5 as a
 *    *trigger* once the M15 sweep+CHoCH has already confirmed -
 *    don't make M5's own BOS a second mandatory gate.
 * ------------------------------------------------------------------- */
const CONFIRM_GRANULARITY = "M15";
const REQUIRE_BOS_AFTER_CHOCH = false;
const LTF_SWING_SIZE = CONFIRM_GRANULARITY === "M15" ? 5 : 5; // tune independently per TF if needed

function pivotHighAt(highs, i, leftBars, rightBars) {
  const candidate = i - rightBars;
  if (candidate - leftBars < 0) return null; // not enough left-side history yet

  let maxVal = -Infinity;
  for (let j = candidate - leftBars; j <= candidate + rightBars; j++) {
    if (highs[j] > maxVal) maxVal = highs[j];
  }
  return highs[candidate] === maxVal ? maxVal : null;
}

/** Mirrors ta.pivotlow(low, leftBars, rightBars). */
function pivotLowAt(lows, i, leftBars, rightBars) {
  const candidate = i - rightBars;
  if (candidate - leftBars < 0) return null;

  let minVal = Infinity;
  for (let j = candidate - leftBars; j <= candidate + rightBars; j++) {
    if (lows[j] < minVal) minVal = lows[j];
  }
  return lows[candidate] === minVal ? minVal : null;
}

function computeMarketStructure(candles, options = {}) {
  const {
    swingSize = 20,
    bosConfirmation = "close",
    showChoch = true,
    showHalfRetracement = false,
  } = options;

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);

  let prevHigh = null;
  let prevLow = null;
  let prevHighIndex = null;
  let prevLowIndex = null;
  let highActive = false;
  let lowActive = false;
  let prevSwing = 0; // 2=HH, 1=LH, -1=HL, -2=LL (current bar's value)
  let prevBreakoutDir = 0; // 1 = last break was bullish, -1 = bearish

  const swings = [];
  const bos = [];
  const retracements = [];

  for (let i = 0; i < candles.length; i++) {
    // prevSwing[1] equivalent: the value as it stood at the END of the previous bar
    const prevSwingHist = prevSwing;

    const pivHi = pivotHighAt(highs, i, swingSize, swingSize);
    const pivLo = pivotLowAt(lows, i, swingSize, swingSize);

    let hh = false,
      lh = false,
      hl = false,
      ll = false;

    if (pivHi !== null) {
      if (prevHigh !== null && pivHi >= prevHigh) {
        hh = true;
        prevSwing = 2;
      } else {
        lh = true;
        prevSwing = 1;
      }
      prevHigh = pivHi;
      highActive = true;
      prevHighIndex = i - swingSize;
    }

    if (pivLo !== null) {
      if (prevLow !== null && pivLo >= prevLow) {
        hl = true;
        prevSwing = -1;
      } else {
        ll = true;
        prevSwing = -2;
      }
      prevLow = pivLo;
      lowActive = true;
      prevLowIndex = i - swingSize;
    }

    // --- Break-of-structure detection ---
    const highSrc = bosConfirmation === "close" ? closes[i] : highs[i];
    const lowSrc = bosConfirmation === "close" ? closes[i] : lows[i];

    let highBroken = false,
      lowBroken = false;
    if (prevHigh !== null && highActive && highSrc > prevHigh) {
      highBroken = true;
      highActive = false;
    }
    if (prevLow !== null && lowActive && lowSrc < prevLow) {
      lowBroken = true;
      lowActive = false;
    }

    // --- Record swing points ---
    if (hh) {
      swings.push({
        type: "HH",
        index: i - swingSize,
        time: candles[i - swingSize].time,
        price: pivHi,
      });
      if (
        showHalfRetracement &&
        prevSwingHist === -1 &&
        prevLowIndex !== null
      ) {
        retracements.push({
          fromIndex: prevLowIndex,
          toIndex: i - swingSize,
          price: (prevLow + pivHi) / 2,
        });
      }
    }
    if (lh) {
      swings.push({
        type: "LH",
        index: i - swingSize,
        time: candles[i - swingSize].time,
        price: pivHi,
      });
    }
    if (hl) {
      swings.push({
        type: "HL",
        index: i - swingSize,
        time: candles[i - swingSize].time,
        price: pivLo,
      });
    }
    if (ll) {
      swings.push({
        type: "LL",
        index: i - swingSize,
        time: candles[i - swingSize].time,
        price: pivLo,
      });
      if (
        showHalfRetracement &&
        prevSwingHist === 1 &&
        prevHighIndex !== null
      ) {
        retracements.push({
          fromIndex: prevHighIndex,
          toIndex: i - swingSize,
          price: (prevHigh + pivLo) / 2,
        });
      }
    }

    // --- Record BOS / CHoCH ---
    if (highBroken) {
      const isChoch = showChoch && prevBreakoutDir === -1;
      bos.push({
        type: isChoch ? "CHoCH" : "BOS",
        direction: "bullish",
        fromIndex: prevHighIndex,
        toIndex: i,
        time: dayjs(candles[i].time)
          .tz("Australia/Brisbane")
          .format("YYYY-MM-DD HH:mm:ss"),
        unix: dayjs(candles[i].time).tz("Australia/Brisbane").unix(),
        price: prevHigh,
      });
      prevBreakoutDir = 1;
    }
    if (lowBroken) {
      const isChoch = showChoch && prevBreakoutDir === 1;
      bos.push({
        type: isChoch ? "CHoCH" : "BOS",
        direction: "bearish",
        fromIndex: prevLowIndex,
        toIndex: i,
        time: dayjs(candles[i].time)
          .tz("Australia/Brisbane")
          .format("YYYY-MM-DD HH:mm:ss"),
        unix: dayjs(candles[i].time).tz("Australia/Brisbane").unix(),
        price: prevLow,
      });
      prevBreakoutDir = -1;
    }
  }

  return { swings, bos, retracements };
}

/* ---------------------------------------------------------------------
 * Liquidity sweep detection
 *
 * A "sweep" is NOT a BOS. A BOS is a close-confirmed break of a swing
 * level. A sweep is a wick that pokes through a recent swing level
 * (grabbing the stops resting beyond it) and then CLOSES back on the
 * original side - i.e. price rejects the level instead of confirming
 * through it. That rejection is what you want to see *before* the
 * CHoCH/BOS that follows, since it's the classic "stop hunt then
 * reverse" signature.
 *
 *   bullish sweep = wick below a recent swing LOW (HL/LL), close
 *                   back above it -> sell-side liquidity grabbed,
 *                   sets up a bullish reversal/continuation.
 *   bearish sweep = wick above a recent swing HIGH (HH/LH), close
 *                   back below it -> buy-side liquidity grabbed,
 *                   sets up a bearish reversal/continuation.
 * ------------------------------------------------------------------- */
function findLiquiditySweep(candles, swings, direction, sinceIndex = 0) {
  const relevantSwings = swings.filter((s) =>
    direction === "bullish"
      ? s.type === "HL" || s.type === "LL"
      : s.type === "HH" || s.type === "LH",
  );

  if (!relevantSwings.length) return null;

  for (let i = sinceIndex; i < candles.length; i++) {
    const c = candles[i];

    // most recent swing point established strictly before this candle
    const priorSwings = relevantSwings.filter((s) => s.index < i);
    if (!priorSwings.length) continue;
    const ref = priorSwings[priorSwings.length - 1];

    if (direction === "bullish") {
      const sweptLow = c.low < ref.price && c.close > ref.price;
      if (sweptLow) {
        return {
          index: i,
          time: c.time,
          price: c.low,
          sweptLevel: ref.price,
          sweptSwing: ref,
        };
      }
    } else {
      const sweptHigh = c.high > ref.price && c.close < ref.price;
      if (sweptHigh) {
        return {
          index: i,
          time: c.time,
          price: c.high,
          sweptLevel: ref.price,
          sweptSwing: ref,
        };
      }
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------------
 * Retracement-zone helpers
 * ------------------------------------------------------------------- */

/**
 * Find the impulse leg that produced the BOS, so we know what range
 * to measure the retracement against.
 *
 *  Bullish BOS: leg runs from the last swing LOW before the break,
 *               up to the highest high reached since the break
 *               (price may keep extending after the break candle).
 *  Bearish BOS: leg runs from the last swing HIGH before the break,
 *               down to the lowest low reached since the break.
 */
function getImpulseLeg(direction, bosEntry, swings, candles) {
  if (direction === "bullish") {
    const priorLow = [...swings]
      .filter(
        (s) =>
          (s.type === "HL" || s.type === "LL") && s.index <= bosEntry.fromIndex,
      )
      .pop();

    const legLow = priorLow
      ? priorLow.price
      : Math.min(...candles.slice(0, bosEntry.fromIndex + 1).map((c) => c.low));

    const extendedHigh = Math.max(
      bosEntry.price,
      ...candles.slice(bosEntry.toIndex).map((c) => c.high),
    );

    return { legLow, legHigh: extendedHigh };
  }

  const priorHigh = [...swings]
    .filter(
      (s) =>
        (s.type === "LH" || s.type === "HH") && s.index <= bosEntry.fromIndex,
    )
    .pop();

  const legHigh = priorHigh
    ? priorHigh.price
    : Math.max(...candles.slice(0, bosEntry.fromIndex + 1).map((c) => c.high));

  const extendedLow = Math.min(
    bosEntry.price,
    ...candles.slice(bosEntry.toIndex).map((c) => c.low),
  );

  return { legLow: extendedLow, legHigh };
}

/**
 * Standard "OTE" (optimal trade entry) zone: 50%-61.8% retracement of
 * the impulse leg. Change minFib/maxFib if you'd rather use a deeper
 * zone (e.g. 0.618-0.786) or treat the broken level itself as the
 * level to wait for (minFib = maxFib = 0 against the broken price).
 */
function computeRetracementZone(direction, legLow, legHigh, opts = {}) {
  const { minFib = 0.5, maxFib = 0.618 } = opts;
  const range = legHigh - legLow;

  if (direction === "bullish") {
    return {
      zoneHigh: legHigh - range * minFib, // shallow edge of the zone
      zoneLow: legHigh - range * maxFib, // deep edge of the zone
    };
  }

  return {
    zoneLow: legLow + range * minFib,
    zoneHigh: legLow + range * maxFib,
  };
}

/* ---------------------------------------------------------------------
 * Step 1: detect the 4H BOS and store it together with its
 * retracement zone (run this on your existing 4H schedule).
 * ------------------------------------------------------------------- */

const fetchBOS = async (theTimeFrame = "240") => {
  // NOTE: FOREX_PAIRS is referenced below but isn't imported/defined
  // anywhere in this file in the original script - add e.g.
  // const { FOREX_PAIRS } = require("../config/pairs"); or this loop
  // will throw at runtime.
  for (const inst of FOREX_PAIRS) {
    console.log(`Fetching for ${inst}...`);
    const granularity = "H4";
    const candles = await fetchCandles(inst, granularity, 800);

    const { swings, bos } = computeMarketStructure(candles, {
      swingSize: 20,
      bosConfirmation: "close",
      showChoch: true,
      showHalfRetracement: false,
    });

    if (!bos.length) {
      await sleep(1000);
      continue;
    }

    const last = bos[bos.length - 1];
    const { legLow, legHigh } = getImpulseLeg(
      last.direction,
      last,
      swings,
      candles,
    );
    const zone = computeRetracementZone(last.direction, legLow, legHigh);

    await remove("bos_forex", { pair: inst });

    await insert("bos_forex", {
      pair: inst,
      type: last.type,
      direction: last.direction,
      time: last.time,
      unix: last.unix,
      price: last.price,
      legLow,
      legHigh,
      zoneLow: zone.zoneLow,
      zoneHigh: zone.zoneHigh,
      tagged: false, // has price entered the retracement zone yet?
      tagTime: null,
      sweepDetected: false, // has a liquidity sweep happened inside the zone?
      sweepTime: null,
      sweepPrice: null,
      sweptLevel: null,
      confirmed: false, // has the LTF CHoCH (+ optional BOS) fired yet?
    });

    await sleep(1000);
  }
  return;
};

/* ---------------------------------------------------------------------
 * Step 2: poll the LTF chart for every pair with a pending BOS,
 * watch for the zone tag, then a liquidity sweep inside the zone,
 * then a same-direction CHoCH (and optionally a follow-up BOS).
 * Run this on a short interval (e.g. every 1-5 minutes via cron).
 *
 * Sequence enforced: zone tag -> liquidity sweep -> CHoCH -> [BOS]
 * This guarantees that whenever a CHoCH/BOS fires here, it happened
 * *after* a liquidity sweep, not on a clean unswept break.
 * ------------------------------------------------------------------- */

const checkRetracementEntries = async () => {
  const records = await find("bos_forex", {});

  for (const record of records) {
    if (record.confirmed) continue; // already alerted on this BOS

    const { pair, direction, zoneLow, zoneHigh, unix, time: bosTime } = record;

    const candles = await fetchCandles(pair, CONFIRM_GRANULARITY, 300);

    // only look at candles that happened after the 4H BOS confirmed
    const postBos = candles.filter((c) => dayjs(c.time).unix() > unix);

    // --- has price tagged the retracement zone yet? ---
    if (!record.tagged) {
      const tagged = postBos.find(
        (c) => c.low <= zoneHigh && c.high >= zoneLow,
      );

      if (!tagged) {
        await sleep(500);
        continue; // hasn't pulled back into the zone yet
      }

      await remove("bos_forex", { pair });
      await insert("bos_forex", {
        ...record,
        tagged: true,
        tagTime: tagged.time,
      });

      console.log(
        `${pair}: price tagged the ${direction} retracement zone (${zoneLow.toFixed(5)}-${zoneHigh.toFixed(5)}), watching ${CONFIRM_GRANULARITY} for a liquidity sweep...`,
      );

      await sleep(500);
      continue;
    }

    // candles since the zone was tagged, used for both sweep + structure checks
    const sinceTag = candles.filter(
      (c) => dayjs(c.time).unix() >= dayjs(record.tagTime).unix(),
    );

    if (sinceTag.length < LTF_SWING_SIZE * 3) {
      await sleep(500);
      continue; // not enough bars yet for meaningful LTF swings
    }

    const { swings: ltfSwings, bos: ltfBos } = computeMarketStructure(
      sinceTag,
      {
        swingSize: LTF_SWING_SIZE,
        bosConfirmation: "close",
        showChoch: true,
      },
    );

    // --- has price swept liquidity inside/around the zone yet? ---
    if (!record.sweepDetected) {
      const sweep = findLiquiditySweep(sinceTag, ltfSwings, direction);

      if (!sweep) {
        await sleep(500);
        continue; // no stop-hunt yet, keep waiting
      }

      await remove("bos_forex", { pair });
      await insert("bos_forex", {
        ...record,
        sweepDetected: true,
        sweepTime: sweep.time,
        sweepPrice: sweep.price,
        sweptLevel: sweep.sweptLevel,
      });

      console.log(
        `${pair}: liquidity sweep detected @ ${sweep.price.toFixed(5)} (swept ${sweep.sweptLevel.toFixed(5)}), watching ${CONFIRM_GRANULARITY} for CHoCH...`,
      );

      await sleep(500);
      continue;
    }

    // --- sweep already confirmed: watch for the same-direction CHoCH after it ---
    const sweepIndex = sinceTag.findIndex((c) => c.time === record.sweepTime);

    const choch = ltfBos.find(
      (b) =>
        b.type === "CHoCH" &&
        b.direction === direction &&
        b.toIndex > sweepIndex,
    );

    if (!choch) {
      await sleep(500);
      continue;
    }

    // --- optional extra gate: require a follow-up BOS after the CHoCH ---
    if (REQUIRE_BOS_AFTER_CHOCH) {
      const bosAfterChoch = ltfBos.find(
        (b) =>
          b.type === "BOS" &&
          b.direction === direction &&
          b.toIndex > choch.toIndex,
      );

      if (!bosAfterChoch) {
        await sleep(500);
        continue; // CHoCH fired but structure hasn't followed through with a BOS yet
      }
    }

    const timeDiff = dayjs(candles[candles.length - 1].time).diff(
      bosTime,
      "hours",
    );

    if (timeDiff < 150) {
      console.log(
        `🚀 ${pair}: 4H ${direction} BOS -> retraced into zone -> liquidity sweep @ ${record.sweepPrice.toFixed(5)} -> ${CONFIRM_GRANULARITY} CHoCH confirmed ${direction} continuation at ${choch.time} @ ${choch.price}`,
      );

      await sendPushNotif(
        `BOS Retest & Breakout: ${pair}: 4H ${direction} BOS, liquidity sweep @ ${record.sweepPrice.toFixed(5)}, ${CONFIRM_GRANULARITY} CHoCH confirmed ${direction} continuation at ${choch.price}`,
      );

      await remove("bos_forex", { pair });
      await insert("bos_forex", {
        ...record,
        confirmed: true,
        confirmTime: choch.time,
        confirmPrice: choch.price,
      });
    }

    await sleep(500);
  }
};

module.exports = { fetchBOS, checkRetracementEntries };
