function trueRange(candles, i) {
  const cur = candles[i];
  if (i === 0) return cur.high - cur.low;
  const prevClose = candles[i - 1].close;
  return Math.max(
    cur.high - cur.low,
    Math.abs(cur.high - prevClose),
    Math.abs(cur.low - prevClose),
  );
}

/**
 * Compute CHOP for every bar where a full `length`-bar lookback is available.
 * Returns an array of { time, close, chop } aligned to `candles`.
 */
function computeChoppinessSeries(candles, length = LENGTH) {
  const tr = candles.map((_, i) => trueRange(candles, i));
  const results = [];

  for (let i = length - 1; i < candles.length; i++) {
    let sumTR = 0;
    let highest = -Infinity;
    let lowest = Infinity;

    for (let j = i - length + 1; j <= i; j++) {
      sumTR += tr[j];
      if (candles[j].high > highest) highest = candles[j].high;
      if (candles[j].low < lowest) lowest = candles[j].low;
    }

    const range = highest - lowest;
    const chop =
      range === 0
        ? null
        : (100 * Math.log10(sumTR / range)) / Math.log10(length);

    results.push({ time: candles[i].time, close: candles[i].close, chop });
  }

  return results;
}

async function getChoppinessIndex(candles, length) {
  return computeChoppinessSeries(candles, length);
}

module.exports = getChoppinessIndex;
