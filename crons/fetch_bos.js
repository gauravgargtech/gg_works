require("../config/config");
const { insert, remove } = require("../adapters/mongo");
const { PineTS, Provider } = require("pinets");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

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

const fetchBOS = async (theTimeFrame = "240") => {
  for (const inst of FOREX_PAIRS) {
    console.log(`Fetching for ${inst}...`);
    const granularity = "H4";
    const candles = await fetchCandles(inst, granularity, 800);

    const { swings, bos, retracements } = computeMarketStructure(candles, {
      swingSize: 20,
      bosConfirmation: "close",
      showChoch: true,
      showHalfRetracement: false,
    });

    await remove("bos_forex", { pair: inst });

    await insert("bos_forex", {
      pair: inst,
      type: bos[bos.length - 1].type,
      direction: bos[bos.length - 1].direction,
      time: bos[bos.length - 1].time,
      unix: bos[bos.length - 1].unix,
      price: bos[bos.length - 1].price,
    });

    await sleep(1000);
  }
  return;
};

module.exports = fetchBOS;
