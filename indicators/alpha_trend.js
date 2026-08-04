/**
 * AlphaTrend indicator (port of KivancOzbilgic's Pine Script v5 "AlphaTrend")
 * Data source: OANDA v20 REST API
 *
 * NOTE: OANDA is a forex/CFD broker. It does not list "AUD_USDT" (a crypto
 * pair). This script uses OANDA's actual instrument "AUD_USD". If you need
 * a USDT-quoted pair you'll need a crypto exchange API instead.
 *
 * Usage:
 *   1. npm install axios
 *   2. export OANDA_API_KEY="your-api-token"
 *   3. node alphatrend-oanda.js
 *
 * Config below controls instrument, granularity, and indicator params.
 */

const axios = require("axios");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG = {
  // --- Pine script inputs ---
  coeff: 1, // Multiplier
  AP: 14, // Common Period
  novolumedata: false, // true => use RSI instead of MFI
  showSignals: true,
};

const OANDA_HOSTS = {
  practice: "https://api-fxpractice.oanda.com",
  live: "https://api-fxtrade.oanda.com",
};

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------
function sma(values, period, i) {
  if (i < period - 1) return null;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) sum += values[k];
  return sum / period;
}

function trueRange(candles, i) {
  const h = candles[i].high;
  const l = candles[i].low;
  if (i === 0) return h - l;
  const prevClose = candles[i - 1].close;
  return Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
}

// Wilder's RSI (matches Pine's ta.rsi)
function computeRSI(candles, period) {
  const rsi = new Array(candles.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return rsi;
}

// MFI using hlc3, matches Pine's ta.mfi (rolling-sum based, not smoothed)
function computeMFI(candles, period) {
  const typicalPrice = candles.map((c) => (c.high + c.low + c.close) / 3);
  const rawMoneyFlow = candles.map((c, i) => typicalPrice[i] * c.volume);

  const mfi = new Array(candles.length).fill(null);

  for (let i = 1; i < candles.length; i++) {
    if (i < period) continue;

    let posSum = 0;
    let negSum = 0;
    for (let k = i - period + 1; k <= i; k++) {
      if (k === 0) continue;
      if (typicalPrice[k] > typicalPrice[k - 1]) posSum += rawMoneyFlow[k];
      else if (typicalPrice[k] < typicalPrice[k - 1]) negSum += rawMoneyFlow[k];
      // unchanged typical price contributes to neither sum
    }

    if (negSum === 0) {
      mfi[i] = 100;
    } else {
      const moneyRatio = posSum / negSum;
      mfi[i] = 100 - 100 / (1 + moneyRatio);
    }
  }
  return mfi;
}

// barssince: number of bars since `cond` was last true, ending at index i
// (0 if true at i itself). Returns null if condition never true up to i.
function barsSinceSeries(cond) {
  const out = new Array(cond.length).fill(null);
  let lastTrueIdx = null;
  for (let i = 0; i < cond.length; i++) {
    if (cond[i]) lastTrueIdx = i;
    out[i] = lastTrueIdx === null ? null : i - lastTrueIdx;
  }
  return out;
}

// shift a series by `n` bars (series[i - n]); null if out of range
function shift(series, n) {
  return series.map((_, i) => (i - n >= 0 ? series[i - n] : null));
}

// ---------------------------------------------------------------------------
// AlphaTrend computation
// ---------------------------------------------------------------------------
function computeAlphaTrend(candles, { coeff, AP, novolumedata }) {
  const n = candles.length;
  const tr = candles.map((_, i) => trueRange(candles, i));
  const atr = tr.map((_, i) => sma(tr, AP, i) ?? 0);

  const rsi = novolumedata ? computeRSI(candles, AP) : null;
  const mfi = !novolumedata ? computeMFI(candles, AP) : null;

  const upT = candles.map((c, i) => c.low - atr[i] * coeff);
  const downT = candles.map((c, i) => c.high + atr[i] * coeff);

  const alphaTrend = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const prev = i > 0 ? alphaTrend[i - 1] : 0; // nz(AlphaTrend[1])
    const indicatorVal = novolumedata ? rsi[i] : mfi[i];
    const trendUp = indicatorVal !== null && indicatorVal >= 50;

    if (trendUp) {
      alphaTrend[i] = upT[i] < prev ? prev : upT[i];
    } else {
      alphaTrend[i] = downT[i] > prev ? prev : downT[i];
    }
  }

  return alphaTrend;
}

// crossover(a, b): a[1] <= b[1] and a[0] > b[0]
function crossoverSeries(a, b) {
  const out = new Array(a.length).fill(false);
  for (let i = 1; i < a.length; i++) {
    if (a[i - 1] == null || b[i - 1] == null) continue;
    out[i] = a[i - 1] <= b[i - 1] && a[i] > b[i];
  }
  return out;
}

// crossunder(a, b): a[1] >= b[1] and a[0] < b[0]
function crossunderSeries(a, b) {
  const out = new Array(a.length).fill(false);
  for (let i = 1; i < a.length; i++) {
    if (a[i - 1] == null || b[i - 1] == null) continue;
    out[i] = a[i - 1] >= b[i - 1] && a[i] < b[i];
  }
  return out;
}

// Reproduces Pine's:
// color1 = AlphaTrend > AlphaTrend[2] ? green
//        : AlphaTrend < AlphaTrend[2] ? red
//        : AlphaTrend[1] > AlphaTrend[3] ? green : red
// This is the color of the fill() between k1 (AlphaTrend) and k2 (AlphaTrend[2]).
// 'positive' = #00E60F (green, uptrend), 'negative' = #80000B (dark red, downtrend)
function computeFillColor(alphaTrend) {
  const n = alphaTrend.length;
  const color = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    const at = alphaTrend[i];
    const at2 = i >= 2 ? alphaTrend[i - 2] : null;
    const at1 = i >= 1 ? alphaTrend[i - 1] : null;
    const at3 = i >= 3 ? alphaTrend[i - 3] : null;

    if (at2 !== null && at > at2) {
      color[i] = "positive";
    } else if (at2 !== null && at < at2) {
      color[i] = "negative";
    } else if (at1 !== null && at3 !== null && at1 > at3) {
      color[i] = "positive";
    } else {
      color[i] = "negative";
    }
  }
  return color;
}

function computeSignals(candles, config) {
  const alphaTrend = computeAlphaTrend(candles, config);
  const alphaTrendShift2 = shift(alphaTrend, 2);

  // Plots
  const k1 = alphaTrend; // plot 1: AlphaTrend
  const k2 = alphaTrendShift2; // plot 2: AlphaTrend[2]
  const fillColor = computeFillColor(alphaTrend); // 'positive' | 'negative'

  const buySignalk = crossoverSeries(alphaTrend, alphaTrendShift2);
  const sellSignalk = crossunderSeries(alphaTrend, alphaTrendShift2);

  const K1 = barsSinceSeries(buySignalk);
  const K2 = barsSinceSeries(sellSignalk);
  const O1 = shift(barsSinceSeries(shift(buySignalk, 1).map(Boolean)), 0); // barssince(buySignalk[1])
  const O2 = shift(barsSinceSeries(shift(sellSignalk, 1).map(Boolean)), 0); // barssince(sellSignalk[1])

  const finalBuy = candles.map(
    (_, i) =>
      buySignalk[i] &&
      config.showSignals &&
      O1[i] !== null &&
      K2[i] !== null &&
      O1[i] > K2[i],
  );
  const finalSell = candles.map(
    (_, i) =>
      sellSignalk[i] &&
      config.showSignals &&
      O2[i] !== null &&
      K1[i] !== null &&
      O2[i] > K1[i],
  );

  return {
    alphaTrend,
    k1,
    k2,
    fillColor,
    buySignalk,
    sellSignalk,
    finalBuy,
    finalSell,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function alphaTrendIndicator(candles) {
  const { alphaTrend, k1, k2, fillColor, finalBuy, finalSell } = computeSignals(
    candles,
    CONFIG,
  );

  return {
    alpha: alphaTrend[alphaTrend.length - 1],
    k1: k1[k1.length - 1],
    k2: k2[k2.length - 1],
    fillColor: fillColor[fillColor.length - 1],
    finalBuy: finalBuy[finalBuy.length - 1],
    finalSell: finalSell[finalSell.length - 1],
  };
}

module.exports = alphaTrendIndicator;
