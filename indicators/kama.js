/**
 * Core P-KAMA calculation.
 *
 * Mirrors the Pine logic:
 *   er  = abs(change(close,length)) / sum(abs(change(close)), length)
 *   pow = selfPowered ? 1/er : factor
 *   per = er ^ pow
 *   a  := per*src + (1-per)*a[1]   (a[0] seeded with src on first valid bar)
 *
 * @param {number[]} closes - close prices, oldest -> newest
 * @param {number} length - lookback period (Pine default: 50)
 * @param {number} factor - fixed exponent used when selfPowered = false (Pine default: 3)
 * @param {boolean} selfPowered - toggles the 1/er exponent vs fixed factor (Pine default: true)
 * @returns {(number|null)[]} P-KAMA values aligned with `closes` (null where insufficient history)
 */
function calculatePKAMA(closes, length = 50, factor = 3, selfPowered = true) {
  const n = closes.length;
  const result = new Array(n).fill(null);
  let a = null;

  for (let i = 0; i < n; i++) {
    // Need `length` prior bars to compute both change(close,length)
    // and sum(abs(change(close)), length), same as Pine's na handling.
    if (i < length) {
      continue;
    }

    // change(close, length) = close[i] - close[i-length]
    const change = closes[i] - closes[i - length];

    // sum(abs(change(close)), length) = sum of |close[k]-close[k-1]|
    // over the most recent `length` bars ending at i
    let sumAbsChange = 0;
    for (let k = i - length + 1; k <= i; k++) {
      sumAbsChange += Math.abs(closes[k] - closes[k - 1]);
    }

    const er = sumAbsChange === 0 ? 0 : Math.abs(change) / sumAbsChange;

    // Guard against 1/0 when er is 0 (flat/no-movement window) — falls
    // back to per = 0, i.e. the filter holds its previous value, which
    // is the sane limiting behavior of er^(1/er) as er -> 0.
    const pow = selfPowered ? (er === 0 ? 0 : 1 / er) : factor;
    const per = er === 0 ? 0 : Math.pow(er, pow);

    const prevA = a === null ? closes[i] : a;
    a = per * closes[i] + (1 - per) * prevA;
    result[i] = a;
  }

  return result;
}

module.exports = calculatePKAMA;
