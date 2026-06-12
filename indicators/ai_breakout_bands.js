/**
 * AI Breakout Bands — Kalman Filter + K-Neighbor Smoothing
 * Ported from Pine Script (Zeiierman) to Node.js
 *
 * Fetches BTCUSDT 15m candles from Bybit and prints
 * Upper Band & Lower Band values for the latest bars.
 *
 * Run: node breakout_bands.js
 */

const https = require("https");

const FETCH_CANDLES = 600; // enough for warm-up (bandLookback=100 + klen=10 + slope=20 + buffer)
const DISPLAY_LAST = 10; // how many recent bars to print

// ─── Default indicator params (mirror Pine Script defaults) ──────────────────
const processNoisePos = 0.02; // Kalman: position process noise
const processNoiseVel = 0.001; // Kalman: velocity process noise
const measurementNoise = 200; // Kalman: observation noise R
const klen = 10; // K-Neighbor smooth window
const slopeWindow = 20; // Linear-regression slope window
const bandLookback = 100; // MAE averaging window
const bandMultiplier = 2.1; // Band distance multiplier

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error("JSON parse error: " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

// ─── Kalman Filter (2-state: position + velocity) ─────────────────────────────
/**
 * Runs the Kalman filter over an array of close prices.
 * Returns an array of filtered position estimates (x_p).
 *
 * State transition: F = [[1,1],[0,1]]
 * Observation matrix: H = [1, 0]
 */
function runKalmanFilter(closes) {
  const n = closes.length;
  const out = new Array(n);

  let xp = closes[0]; // position estimate
  let xv = 0.0; // velocity estimate
  let p00 = 1.0; // covariance matrix
  let p01 = 0.0;
  let p10 = 0.0;
  let p11 = 1.0;

  for (let i = 0; i < n; i++) {
    const z = closes[i];

    // 1. Predict
    const pred_p = xp + xv;
    const pred_v = xv;

    // 2. Covariance predict: F·P·Fᵀ + Q
    //    F = [[1,1],[0,1]]
    //    F·P = [[p00+p10, p01+p11],[p10, p11]]
    //    (F·P)·Fᵀ = [[a00+a01, a01],[a10+a11, a11]]
    const a00 = p00 + p10;
    const a01 = p01 + p11;
    const a10 = p10;
    const a11 = p11;
    const p00_ = a00 + a01 + processNoisePos;
    const p01_ = a01;
    const p10_ = a10 + a11;
    const p11_ = a11 + processNoiseVel;

    // 3. Measurement update
    const y = z - pred_p; // innovation
    const S = p00_ + measurementNoise; // innovation covariance
    const K0 = p00_ / S; // Kalman gain for position
    const K1 = p10_ / S; // Kalman gain for velocity

    xp = pred_p + K0 * y;
    xv = pred_v + K1 * y;

    // 4. Covariance update: (I - K·H)·P_
    p00 = (1 - K0) * p00_;
    p01 = (1 - K0) * p01_;
    p10 = -K1 * p00_ + p10_;
    p11 = -K1 * p01_ + p11_;

    out[i] = xp;
  }

  return out;
}

// ─── K-Neighbor Smoothing (inverse-distance weighted, excludes self) ──────────
/**
 * For each bar, look back `len` bars and weight each by 1/distance to current.
 * Mirrors Pine Script's f_knn_smooth which starts at i=1 (excludes self).
 */
function knnSmooth(kalman, len) {
  const n = kalman.length;
  const out = new Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    const curr = kalman[i];
    let sumW = 0.0;
    let sumX = 0.0;

    const lookback = Math.min(len, i); // can't look back further than we have data
    for (let j = 1; j <= lookback; j++) {
      const xi = kalman[i - j];
      const dist = Math.abs(curr - xi) + 1e-6;
      const w = 1.0 / dist;
      sumW += w;
      sumX += xi * w;
    }

    out[i] = sumW > 0 ? sumX / sumW : curr;
  }

  return out;
}

// ─── Linear Regression helper ─────────────────────────────────────────────────
/**
 * Returns the predicted value at the END of a `length`-bar window
 * that ends at index (idx - offset).
 *
 * Mirrors Pine Script's ta.linreg(src, length, offset).
 */
function linregAtOffset(arr, idx, length, offset) {
  const endIdx = idx - offset;
  const startIdx = endIdx - length + 1;
  if (startIdx < 0) return NaN;

  const n = length;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += arr[startIdx + i];
    sumXY += i * arr[startIdx + i];
    sumX2 += i * i;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return intercept + slope * (n - 1); // value at x = n-1 (the last bar of the window)
}

// ─── Slope: difference between linreg(0) and linreg(1) ───────────────────────
function computeSlopes(smoothed, window) {
  return smoothed.map((_, i) => {
    if (i < window + 1) return NaN;
    return (
      linregAtOffset(smoothed, i, window, 0) -
      linregAtOffset(smoothed, i, window, 1)
    );
  });
}

// ─── Simple Moving Average ─────────────────────────────────────────────────────
function sma(arr, idx, period) {
  if (idx < period - 1) return NaN;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) sum += arr[i];
  return sum / period;
}

// ─── Breakout Bands ───────────────────────────────────────────────────────────
/**
 * Computes upper and lower breakout bands using Mean Absolute Error
 * between close prices and the smoothed Kalman line.
 */
function computeBands(closes, smoothed) {
  const n = closes.length;
  const absErr = closes.map((c, i) => Math.abs(c - smoothed[i]));

  const upper = new Array(n).fill(NaN);
  const lower = new Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    const mae = sma(absErr, i, bandLookback);
    if (isNaN(mae)) continue;
    upper[i] = smoothed[i] + bandMultiplier * mae;
    lower[i] = smoothed[i] - bandMultiplier * mae;
  }

  return { upper, lower };
}

// ─── Color logic (mirrors Pine Script) ───────────────────────────────────────
function getBandColor(close, upper, lower, slope) {
  if (close > upper) return "BULL (cyan)";
  if (close < lower) return "BEAR (blue)";
  return slope > 0 ? "BULL-TREND (cyan)" : "BEAR-TREND (blue)";
}

async function aiBreakBands(symbol, candles) {
  console.log(`✅ ${candles.length} candles loaded\n`);

  const closes = candles.map((c) => c.close);

  const kalman = runKalmanFilter(closes);

  const smoothed = knnSmooth(kalman, klen);

  const slopes = computeSlopes(smoothed, slopeWindow);

  const { upper, lower } = computeBands(closes, smoothed);

  const n = candles.length;
  const start = n - DISPLAY_LAST;

  for (let i = start; i < n; i++) {
    const c = candles[i];
    const dt = new Date(c.time).toISOString().slice(0, 16).replace("T", " ");
    const barN = i - n + 1; // 0 = current, -1 = 1 bar ago, etc.

    const u = upper[i];
    const l = lower[i];
    const sm = smoothed[i];
    const sl = slopes[i];

    if (isNaN(u) || isNaN(l)) continue;

    const color = getBandColor(c.close, u, l, sl);
  }

  // ── Latest bar summary ────────────────────────────────────────────────────
  const latest = n - 1;
  const latestC = candles[latest];
  const latestU = upper[latest];
  const latestL = lower[latest];
  const latestSm = smoothed[latest];

  // Full array output (all bars that have valid bands)
  const allResults = candles
    .map((c, i) => ({
      time: new Date(c.time).toISOString(),
      close: c.close,
      smoothed: isNaN(smoothed[i]) ? null : parseFloat(smoothed[i].toFixed(8)),
      upperBand: isNaN(upper[i]) ? null : parseFloat(upper[i].toFixed(8)),
      lowerBand: isNaN(lower[i]) ? null : parseFloat(lower[i].toFixed(8)),
    }))
    .filter((r) => r.upperBand !== null);

  return allResults;
}

module.exports = aiBreakBands;
