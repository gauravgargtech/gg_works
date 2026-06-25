require("../config/config");

const { get, set } = require("../adapters/redis");

const { fetchCandles } = require("../exhanges/oanda");

const INTERVAL = "D"; // 1 day
const LOOKBACK = 20; // classic ICT 3-candle fractal; raise for fewer/major swings
const LIMIT = 500; // number of daily candles to pull (max 1000/call on Bybit)

function isSwingHigh(candles, i, lookback) {
  if (i - lookback < 0 || i + lookback >= candles.length) return false;
  const val = candles[i].high;
  for (let k = i - lookback; k <= i + lookback; k++) {
    if (k === i) continue;
    if (candles[k].high >= val) return false;
  }
  return true;
}

function isSwingLow(candles, i, lookback) {
  if (i - lookback < 0 || i + lookback >= candles.length) return false;
  const val = candles[i].low;
  for (let k = i - lookback; k <= i + lookback; k++) {
    if (k === i) continue;
    if (candles[k].low <= val) return false;
  }
  return true;
}

function findSwingPoints(candles, lookback) {
  const swingHighs = [];
  const swingLows = [];

  for (let i = 0; i < candles.length; i++) {
    if (isSwingHigh(candles, i, lookback)) {
      swingHighs.push({
        time: candles[i].time,
        price: candles[i].high,
        index: i,
      });
    }
    if (isSwingLow(candles, i, lookback)) {
      swingLows.push({
        time: candles[i].time,
        price: candles[i].low,
        index: i,
      });
    }
  }

  return { swingHighs, swingLows };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findSwingPointsForex() {
  for (const pair of FOREX_PAIRS) {
    const candles = await fetchCandles(pair, INTERVAL, LIMIT);
    const { swingHighs, swingLows } = findSwingPoints(candles, LOOKBACK);

    const sortedSwingLows = swingLows.sort((a, b) => b.price - a.price);
    const sortedSwingHighs = swingHighs.sort((a, b) => a.price - b.price);

    console.log(`swing_high_${pair}`);
    console.log(`swing_low_${pair}`);

    await set(`swing_high_${pair}`, JSON.stringify(sortedSwingHighs));
    await set(`swing_low_${pair}`, JSON.stringify(sortedSwingLows));

    await sleep(2000);
  }

  return;
}

module.exports = findSwingPointsForex;
