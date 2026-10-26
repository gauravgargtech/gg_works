/**
 * Adaptive Trend Finder (log) — native Node.js implementation.
 *
 * Derived from "Adaptive Trend Finder (log)" by Julien_Eche.
 * Original copyright: Julien Eche, 2023-present.
 * Original Pine Script is distributed under GPL-3.0 terms.
 *
 * Calculates regression channels numerically. TradingView-only visual
 * features (lines, fills, and table) are returned as data instead.
 *
 * Candles must be ordered oldest to newest.
 * Supported candle formats:
 *   { close: 123.45, time: ... }
 *   { c: 123.45, timestamp: ... }
 *   [time, open, high, low, close, volume]
 *   A numeric close price.
 */

"use strict";

const LONG_PERIODS = Array.from({ length: 19 }, (_, i) => 300 + i * 50);

const SHORT_PERIODS = Array.from({ length: 19 }, (_, i) => 20 + i * 10);

function getClose(candle, index) {
  let value;

  if (typeof candle === "number") {
    value = candle;
  } else if (Array.isArray(candle)) {
    // OHLCV: [time, open, high, low, close, volume]
    value = candle.length >= 5 ? candle[4] : candle[1];
  } else if (candle && typeof candle === "object") {
    value = candle.close ?? candle.c ?? candle.Close;
  }

  const close = Number(value);

  if (!Number.isFinite(close) || close <= 0) {
    throw new TypeError(
      `Invalid or missing positive close price at candle index ${index}`,
    );
  }

  return close;
}

/**
 * Calculate logarithmic regression statistics for a given period.
 * This mirrors the calculation in the original Pine Script.
 */
function calcDev(closesChronological, length) {
  if (closesChronological.length < length || length < 2) {
    return null;
  }

  // Pine's [0] means the latest bar.
  const logPrices = closesChronological
    .slice(closesChronological.length - length)
    .reverse()
    .map(Math.log);

  let sumX = 0;
  let sumXX = 0;
  let sumYX = 0;
  let sumY = 0;

  for (let i = 1; i <= length; i += 1) {
    const logPrice = logPrices[i - 1];

    sumX += i;
    sumXX += i * i;
    sumYX += i * logPrice;
    sumY += logPrice;
  }

  const denominator = length * sumXX - sumX * sumX;

  const slope =
    denominator === 0 ? 0 : (length * sumYX - sumX * sumY) / denominator;

  const average = sumY / length;

  const intercept = average - (slope * sumX) / length + slope;

  let sumDev = 0;
  let sumDxx = 0;
  let sumDyy = 0;
  let sumDyx = 0;

  let sumSlp = intercept;

  const regres = intercept + slope * (length - 1) * 0.5;

  for (let i = 0; i <= length - 1; i += 1) {
    const logPrice = logPrices[i];

    const dxt = logPrice - average;
    const dyt = sumSlp - regres;
    const residual = logPrice - sumSlp;

    sumSlp += slope;

    sumDxx += dxt * dxt;
    sumDyy += dyt * dyt;
    sumDyx += dxt * dyt;
    sumDev += residual * residual;
  }

  const stdDev = Math.sqrt(sumDev / (length - 1));

  const pearsonDenominator = Math.sqrt(sumDxx * sumDyy);

  const pearsonR = pearsonDenominator === 0 ? 0 : sumDyx / pearsonDenominator;

  return {
    length,
    stdDev,
    pearsonR: Number.isFinite(pearsonR) ? pearsonR : 0,
    slope: Number.isFinite(slope) ? slope : 0,
    intercept: Number.isFinite(intercept) ? intercept : 0,
  };
}

/**
 * Convert Pearson R into the original indicator's trend-strength label.
 */
function confidence(pearsonR) {
  if (pearsonR < 0.2) return "Extremely Weak";
  if (pearsonR < 0.3) return "Very Weak";
  if (pearsonR < 0.4) return "Weak";
  if (pearsonR < 0.5) return "Mostly Weak";
  if (pearsonR < 0.6) return "Somewhat Weak";
  if (pearsonR < 0.7) return "Moderately Weak";
  if (pearsonR < 0.8) return "Moderate";
  if (pearsonR < 0.9) return "Moderately Strong";
  if (pearsonR < 0.92) return "Mostly Strong";
  if (pearsonR < 0.94) return "Strong";
  if (pearsonR < 0.96) return "Very Strong";
  if (pearsonR < 0.98) return "Exceptionally Strong";

  return "Ultra Strong";
}

/**
 * Return annualization multiplier for daily/weekly candles.
 * CAGR is not calculated for intraday timeframes.
 */
function getAnnualizationMultiplier(timeframe, symbolType) {
  const tf = String(timeframe ?? "")
    .trim()
    .toLowerCase();

  const isDaily = ["d", "1d", "1day", "daily"].includes(tf);

  const isWeekly = ["w", "1w", "1week", "weekly"].includes(tf);

  if (isWeekly) return 52;
  if (!isDaily) return null;

  return String(symbolType ?? "crypto").toLowerCase() === "crypto" ? 365 : 252;
}

/**
 * Calculate the Adaptive Trend Finder channel for the latest candle.
 *
 * @param {Array} candles Candles, oldest first.
 * @param {Object} options
 * @param {boolean} options.periodMode
 *   true  = long-term periods (300 to 1200)
 *   false = short-term periods (20 to 200)
 * @param {number} options.devMultiplier Channel deviation multiplier.
 * @param {string} options.timeframe Examples: '1d', '1w', '4h'.
 * @param {string} options.symbolType 'crypto' or another asset type.
 *
 * @returns {Object} Trend statistics and channel prices.
 */
function calculateAdaptiveTrendline(candles, options = {}) {
  if (!Array.isArray(candles)) {
    throw new TypeError("candles must be an array ordered oldest to newest");
  }

  const {
    periodMode = true,
    devMultiplier = 2,
    timeframe,
    symbolType = "crypto",
  } = options;

  if (!Number.isFinite(devMultiplier) || devMultiplier < 0) {
    throw new TypeError("devMultiplier must be a finite non-negative number");
  }

  if (candles.length === 0) {
    throw new RangeError("No candles supplied");
  }

  const closes = candles.map(getClose);

  const periods = periodMode ? LONG_PERIODS : SHORT_PERIODS;

  const candidates = periods
    .filter((period) => period <= closes.length)
    .map((period) => calcDev(closes, period))
    .filter(Boolean);

  if (candidates.length === 0) {
    const minRequired = Math.min(...periods);

    throw new RangeError(
      `Not enough candles: ${closes.length} supplied; ` +
        `at least ${minRequired} required for ` +
        `${periodMode ? "long-term" : "short-term"} mode`,
    );
  }

  // Select the period with the highest Pearson R.
  // In a tie, retain the first candidate.
  let selected = candidates[0];

  for (let i = 1; i < candidates.length; i += 1) {
    if (candidates[i].pearsonR > selected.pearsonR) {
      selected = candidates[i];
    }
  }

  const { length, stdDev, pearsonR, slope, intercept } = selected;

  // Prices at the beginning and end of the regression line.
  const startPrice = Math.exp(intercept + slope * (length - 1));

  const endPrice = Math.exp(intercept);

  const channelFactor = Math.exp(devMultiplier * stdDev);

  const startIndex = closes.length - length;
  const endIndex = closes.length - 1;

  const latestClose = closes[endIndex];
  const startClose = closes[startIndex];

  let cagr = null;

  const annualizationMultiplier = getAnnualizationMultiplier(
    timeframe,
    symbolType,
  );

  if (annualizationMultiplier !== null && startClose > 0) {
    cagr =
      Math.pow(latestClose / startClose, annualizationMultiplier / length) - 1;
  }

  return {
    periodMode: Boolean(periodMode),

    // Selected regression
    selectedPeriod: length,
    pearsonR,
    trendStrength: confidence(pearsonR),
    slope,
    intercept,
    stdDev,

    // Candle indexes
    startIndex,
    endIndex,

    startTime:
      candles[startIndex]?.time ?? candles[startIndex]?.timestamp ?? null,

    endTime: candles[endIndex]?.time ?? candles[endIndex]?.timestamp ?? null,

    // Regression channel
    startPrice,
    endPrice,

    upperStartPrice: startPrice * channelFactor,

    upperEndPrice: endPrice * channelFactor,

    lowerStartPrice: startPrice / channelFactor,

    lowerEndPrice: endPrice / channelFactor,

    latestClose,

    // Annualized return, available for daily/weekly timeframes
    cagr,
    cagrPercent: cagr === null ? null : cagr * 100,

    // Candidate-period statistics, useful for debugging
    candidates: candidates.map(({ length: period, pearsonR: r }) => ({
      period,
      pearsonR: r,
      trendStrength: confidence(r),
    })),
  };
}

module.exports = calculateAdaptiveTrendline;
module.exports.calcDev = calcDev;
module.exports.confidence = confidence;
