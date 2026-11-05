"use strict";
/**
 * Moving Averages Proximity Oscillator (MAPO) - Node.js port
 * Original Pine Script indicator by LuxAlgo (CC BY-NC-SA 4.0)
 *
 * Usage as a module:
 *   const { mapo } = require('./mapo');
 *   const out = mapo(closes, { min: 10, max: 100, smooth: 9, normalized: true });
 *
 * Usage from CLI (CSV with a "close" column in the header):
 *   node mapo.js candles.csv [min] [max] [smooth] [normalized=true|false]
 */

// Pine ta.sma: NaN until `length` values are available.
function sma(values, length) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= length) sum -= values[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

/**
 * @param {number[]} src  price series (oldest -> newest), e.g. closes
 * @param {object}   opts { min, max, smooth, normalized }
 * @returns {{ series:object[], latest:object, per:number[], len:number[], levels:{lvl:number, ob:number, os:number}, above:boolean[] }}
 *   series = one object per bar: { index, price, per, proximity, bias: 'bull'|'bear'|null, overbought, oversold }
 *   latest = the last item of `series`
 *   per    = "Price Above MA's" histogram value (plotted as columns from `lvl`)
 *   len    = "Proximity Index" line (same values as `proximity` in series)
 *   above  = per > lvl (teal if true, red if false in the original)
 */
function mapo(
  src,
  { min = 10, max = 100, smooth = 9, normalized = true } = {},
) {
  if (min < 1 || max < 1 || smooth < 1) {
    throw new Error("min, max and smooth must be >= 1");
  }
  const n = src.length;

  // ta.cum(src)
  const csum = new Array(n);
  let acc = 0;
  for (let t = 0; t < n; t++) csum[t] = acc += src[t];

  const rawLen = new Array(n).fill(0);
  const rawPer = new Array(n).fill(0);

  for (let t = 0; t < n; t++) {
    let len = 0;
    let per = 0;
    // Pine yields na when csum[min] doesn't exist yet (t < min)
    let maxMin =
      t >= min ? Math.abs(src[t] - (csum[t] - csum[t - min]) / min) : NaN;

    for (let i = min; i <= max; i++) {
      // Not enough history: ma is na, so nothing further can count or update
      if (t - i < 0) break;

      const ma = (csum[t] - csum[t - i]) / i;
      if (src[t] > ma) per += 1;

      const ae = Math.abs(src[t] - ma);
      maxMin = Math.min(ae, maxMin);
      if (ae === maxMin) len = i;
    }
    rawLen[t] = len;
    rawPer[t] = per;
  }

  let lenS = sma(rawLen, smooth);
  let perS = sma(rawPer, smooth);

  const range = max - min + 1;
  if (normalized) {
    lenS = lenS.map((v) => ((v - min) / range) * 100);
    perS = perS.map((v) => (v / range) * 100);
  } else {
    perS = perS.map((v) => v + min);
  }

  const lvl = normalized ? 50 : (max + min + 1) / 2;
  const ob = normalized ? 80 : 0.8 * max + 0.2 * min;
  const os = normalized ? 20 : 0.8 * min + 0.2 * max;

  const above = perS.map((v) => v > lvl);

  // One object per bar: histogram value, proximity index and bull/bear bias together
  const series = perS.map((p, t) => {
    const ready = !Number.isNaN(p);
    return {
      index: t,
      price: src[t],
      per: p, // "Price Above MA's" value
      proximity: lenS[t], // "Proximity Index" value
      bias: !ready ? null : p > lvl ? "bull" : "bear", // bull = price above most MAs (teal), bear = red
      overbought: ready && p >= ob,
      oversold: ready && p <= os,
    };
  });

  return {
    series,
    latest: series[n - 1] || null,
    per: perS,
    len: lenS,
    levels: { lvl, ob, os },
    above,
  };
}

module.exports = { mapo, sma };
