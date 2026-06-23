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
      confirmed: false, // has the M5 CHoCH fired yet?
    });

    await sleep(1000);
  }
  return;
};

/* ---------------------------------------------------------------------
 * Step 2: poll the 5-minute chart for every pair with a pending BOS,
 * watch for the zone tag, then watch for a same-direction CHoCH.
 * Run this on a short interval (e.g. every 1-5 minutes via cron).
 * ------------------------------------------------------------------- */

const checkRetracementEntries = async () => {
  const records = await find("bos_forex", {});

  for (const record of records) {
    if (record.confirmed) continue; // already alerted on this BOS

    const { pair, direction, zoneLow, zoneHigh, unix } = record;
    const candles = await fetchCandles(pair, "M5", 300);

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
        `${pair}: price tagged the ${direction} retracement zone (${zoneLow.toFixed(5)}-${zoneHigh.toFixed(5)}), watching M5 for CHoCH...`,
      );

      await sleep(500);
      continue;
    }

    // --- zone already tagged: watch M5 structure for a same-direction CHoCH ---
    const sinceTag = candles.filter(
      (c) => dayjs(c.time).unix() >= dayjs(record.tagTime).unix(),
    );

    if (sinceTag.length < 15) {
      await sleep(500);
      continue; // not enough bars yet for a meaningful M5 swing
    }

    const { bos: m5Bos } = computeMarketStructure(sinceTag, {
      swingSize: 5,
      bosConfirmation: "close",
      showChoch: true,
    });

    const choch = m5Bos.find(
      (b) => b.type === "CHoCH" && b.direction === direction,
    );

    if (choch) {
      console.log(
        `🚀 ${pair}: 4H ${direction} BOS retraced into zone and M5 CHoCH confirmed ${direction} continuation at ${choch.time} @ ${choch.price}`,
      );

      await sendPushNotif(
        `BOS Retest & Breakout: ${pair}: 4H ${direction} BOS retraced into zone and M5 CHoCH confirmed ${direction} continuation at ${choch.price}`,
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
