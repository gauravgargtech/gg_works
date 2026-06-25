require("../config/config");

const { get, set } = require("../adapters/redis");

const { fetchCandles } = require("../exhanges/bybit_public");

const SYMBOL = "BTCUSDT";
const CATEGORY = "linear"; // linear perpetual = the ".P" contract
const INTERVAL = "D"; // 1 day
const LOOKBACK = 3; // classic ICT 3-candle fractal; raise for fewer/major swings
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

async function findSwingPointsBTC() {
  const candles = await fetchCandles(SYMBOL, INTERVAL, LIMIT);
  const { swingHighs, swingLows } = findSwingPoints(candles, LOOKBACK);

  await set(`swing_high_${SYMBOL}`, JSON.stringify(swingHighs));
  await set(`swing_low_${SYMBOL}`, JSON.stringify(swingLows));
  return;
}

module.exports = findSwingPointsBTC;
