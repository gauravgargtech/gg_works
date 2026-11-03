require("../config/config");

const { sendPushNotif } = require("../config/telegram_notify");

const { fetchCandles } = require("../exhanges/bybit_public");

function analyzeCandle(c, history = [], opts = {}) {
  const {
    maxBodyRatio = 0.15,
    minWickRatio = 0.6,
    minRangePct = 0.5,
    dominantWick = 0.55,
    doubleWickMin = 0.25,
    lookback = 20, // how many previous candles define "prior high/low"
    volMult = 1.2, // volume must be 1.2x average to count as strong
  } = opts;

  const { open, high, low, close, volume } = c;
  const range = high - low;
  if (range <= 0) return null;

  const body = Math.abs(close - open);
  const upper = high - Math.max(open, close);
  const lower = Math.min(open, close) - low;

  const bodyRatio = body / range;
  const upperRatio = upper / range;
  const lowerRatio = lower / range;
  const rangePct = (range / open) * 100;
  const closePos = (close - low) / range; // 0 = closed at low, 1 = closed at high

  const isMatch =
    bodyRatio <= maxBodyRatio &&
    rangePct >= minRangePct &&
    upperRatio + lowerRatio >= minWickRatio;

  if (!isMatch) {
    return {
      match: false,
      bias: "NONE",
      bodyRatio,
      upperRatio,
      lowerRatio,
      rangePct,
    };
  }

  // Shape type
  let type = "OTHER";
  if (upperRatio >= dominantWick) type = "LONG_UPPER_WICK";
  else if (lowerRatio >= dominantWick) type = "LONG_LOWER_WICK";
  else if (upperRatio >= doubleWickMin && lowerRatio >= doubleWickMin) {
    type = "BOTH_WICKS";
  }

  // Sweep detection against previous candles
  const prev = history.slice(-lookback);
  const prevHigh = prev.length ? Math.max(...prev.map((x) => x.high)) : null;
  const prevLow = prev.length ? Math.min(...prev.map((x) => x.low)) : null;
  const avgVol = prev.length
    ? prev.reduce((s, x) => s + x.volume, 0) / prev.length
    : null;

  const sweptHigh = prevHigh !== null && high > prevHigh && close < prevHigh;
  const sweptLow = prevLow !== null && low < prevLow && close > prevLow;
  const highVolume = avgVol !== null && volume >= avgVol * volMult;

  // Bias + confidence score
  let bias = "NEUTRAL";
  let score = 0;
  let invalidation = null;

  if (type === "LONG_UPPER_WICK") {
    bias = "BEARISH";
    invalidation = high; // close above this = idea invalid
    if (sweptHigh) score += 2;
    if (closePos <= 0.35) score += 1; // closed near the low
    if (highVolume) score += 1;
  } else if (type === "LONG_LOWER_WICK") {
    bias = "BULLISH";
    invalidation = low; // close below this = idea invalid
    if (sweptLow) score += 2;
    if (closePos >= 0.65) score += 1; // closed near the high
    if (highVolume) score += 1;
  }
  // BOTH_WICKS / OTHER stay NEUTRAL (indecision)

  const confidence =
    bias === "NEUTRAL"
      ? "NONE"
      : score >= 3
        ? "HIGH"
        : score === 2
          ? "MEDIUM"
          : "LOW";

  return {
    match: true,
    type,
    bias,
    confidence,
    invalidation,
    sweptHigh,
    sweptLow,
    highVolume,
    bodyRatio,
    upperRatio,
    lowerRatio,
    rangePct,
    closePos,
  };
}

async function btcWigs() {
  const symbol = "BTCUSDT";

  const candles = await fetchCandles(symbol, 60, 2);

  const analysis = analyzeCandle(candles[0]);

  if (analysis?.match) {
    await sendPushNotif(
      `BTC WIG detected: ${analysis.bias} with confidence (${analysis.confidence})`,
    );
  }
}

module.exports = btcWigs;
