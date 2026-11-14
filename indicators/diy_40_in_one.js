"use strict";

const CONFIG = {
  timeframe: "15m",
  intervalMs: 15 * 60 * 1000,

  timestampUnit: "milliseconds",
  timezone: "Australia/Brisbane",

  rangePeriod: 100,
  rangeMultiplier: 3.0,

  emaPeriod: 900,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  signalExpiry: 3,
  alternateSignals: true,
};

function validateCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error("candles must be a non-empty array");
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    if (
      !Number.isFinite(c.timestamp) ||
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close) ||
      !Number.isFinite(c.volume)
    ) {
      throw new Error(`Invalid candle at index ${i}`);
    }

    if (c.timestamp < 1e12) {
      throw new Error(`Candle ${i}: expected Unix timestamp in milliseconds`);
    }

    if (i > 0 && c.timestamp <= candles[i - 1].timestamp) {
      throw new Error("Candles must be ordered oldest to newest");
    }
  }
}

// Pine-style EMA using the first available value as the seed.
function emaSeries(values, period) {
  const result = new Array(values.length).fill(null);
  const alpha = 2 / (period + 1);
  let previous = null;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];

    if (value == null || !Number.isFinite(value)) continue;

    previous =
      previous == null ? value : value * alpha + previous * (1 - alpha);

    result[i] = previous;
  }

  return result;
}

// Daily session key in the configured exchange timezone.
function getSessionKey(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));

  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));

  return `${p.year}-${p.month}-${p.day}`;
}

// TradingView VWAP equivalent for Session anchor and HLC3 source.
// VWAP resets at the start of each exchange-timezone day.
function calculateVWAP(candles, timezone) {
  let currentSession = null;
  let cumulativePV = 0;
  let cumulativeVolume = 0;

  return candles.map((candle) => {
    const session = getSessionKey(candle.timestamp, timezone);

    if (session !== currentSession) {
      currentSession = session;
      cumulativePV = 0;
      cumulativeVolume = 0;
    }

    const hlc3 = (candle.high + candle.low + candle.close) / 3;

    cumulativePV += hlc3 * candle.volume;
    cumulativeVolume += candle.volume;

    return cumulativeVolume > 0 ? cumulativePV / cumulativeVolume : null;
  });
}

// Default Range Filter from the supplied Pine Script.
// Source = close, period = 100, multiplier = 3.
function calculateRangeFilter(candles, period, multiplier) {
  const closes = candles.map((c) => c.close);

  const changes = closes.map((close, i) =>
    i === 0 ? null : Math.abs(close - closes[i - 1]),
  );

  const averageChange = emaSeries(changes, period);
  const smoothingPeriod = period * 2 - 1;
  const smoothedAverage = emaSeries(averageChange, smoothingPeriod);

  const filter = new Array(candles.length).fill(null);
  const upward = new Array(candles.length).fill(0);
  const downward = new Array(candles.length).fill(0);
  const longDirection = new Array(candles.length).fill(false);
  const shortDirection = new Array(candles.length).fill(false);

  let previousFilter = 0;
  let previousUpward = 0;
  let previousDownward = 0;

  for (let i = 0; i < candles.length; i++) {
    const close = closes[i];
    const range = smoothedAverage[i];

    if (range == null) {
      previousFilter = 0;
      continue;
    }

    // Pine rngfilt():
    // x > nz(filter[1]) ? max(x - range, filter[1])
    //                  : min(x + range, filter[1])
    const currentFilter =
      close > previousFilter
        ? Math.max(previousFilter, close - range)
        : Math.min(previousFilter, close + range);

    filter[i] = currentFilter;

    const previousClose = i > 0 ? closes[i - 1] : null;
    const filterRising = i > 0 && currentFilter > filter[i - 1];
    const filterFalling = i > 0 && currentFilter < filter[i - 1];

    const upCount = filterRising
      ? previousUpward + 1
      : filterFalling
        ? 0
        : previousUpward;

    const downCount = filterFalling
      ? previousDownward + 1
      : filterRising
        ? 0
        : previousDownward;

    upward[i] = upCount;
    downward[i] = downCount;

    // Pine rfupward / rfdownward conditions.
    longDirection[i] =
      close > currentFilter && previousClose != null && upCount > 0;

    shortDirection[i] =
      close < currentFilter && previousClose != null && downCount > 0;

    previousFilter = currentFilter;
    previousUpward = upCount;
    previousDownward = downCount;
  }

  return {
    filter,
    upward,
    downward,
    longDirection,
    shortDirection,
  };
}

function calculateMACD(candles, fast, slow, signalPeriod) {
  const closes = candles.map((c) => c.close);

  const fastEMA = emaSeries(closes, fast);
  const slowEMA = emaSeries(closes, slow);

  const macdLine = closes.map((_, i) =>
    fastEMA[i] == null || slowEMA[i] == null ? null : fastEMA[i] - slowEMA[i],
  );

  const signalLine = emaSeries(macdLine, signalPeriod);

  const histogram = macdLine.map((value, i) =>
    value == null || signalLine[i] == null ? null : value - signalLine[i],
  );

  return { macdLine, signalLine, histogram };
}

function normalizeCandles(rawCandles) {
  return rawCandles.map((c) => ({
    timestamp: new Date(c.time + "+00:00").getTime(),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,

    brisbaneTime: c.brisbaneTime,
  }));
}

function calculateSignals(theCandles, options = {}) {
  const config = { ...CONFIG, ...options };

  const candles = normalizeCandles(theCandles);

  validateCandles(candles);

  const closes = candles.map((c) => c.close);

  const ema200 = emaSeries(closes, config.emaPeriod);
  const vwap = calculateVWAP(candles, config.timezone);

  const macd = calculateMACD(
    candles,
    config.macdFast,
    config.macdSlow,
    config.macdSignal,
  );

  const range = calculateRangeFilter(
    candles,
    config.rangePeriod,
    config.rangeMultiplier,
  );

  const results = [];

  let previousSignalDirection = 0;

  let longRun = 0;
  let shortRun = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const close = candle.close;

    const isRangeLong = range.longDirection[i];
    const isRangeShort = range.shortDirection[i];

    // Count consecutive Range Filter direction bars.
    longRun = isRangeLong ? longRun + 1 : 0;
    shortRun = isRangeShort ? shortRun + 1 : 0;

    const emaLong = ema200[i] != null && close > ema200[i];
    const emaShort = ema200[i] != null && close < ema200[i];

    const vwapLong = vwap[i] != null && close > vwap[i];
    const vwapShort = vwap[i] != null && close < vwap[i];

    const macdLong =
      macd.macdLine[i] != null &&
      macd.signalLine[i] != null &&
      macd.macdLine[i] > macd.signalLine[i];

    const macdShort =
      macd.macdLine[i] != null &&
      macd.signalLine[i] != null &&
      macd.macdLine[i] < macd.signalLine[i];

    // All confirmations must agree on the same candle.
    // The setup is valid only during the first 3 direction bars.
    const longSetup =
      isRangeLong &&
      longRun <= config.signalExpiry &&
      emaLong &&
      vwapLong &&
      macdLong;

    const shortSetup =
      isRangeShort &&
      shortRun <= config.signalExpiry &&
      emaShort &&
      vwapShort &&
      macdShort;

    let signal = null;

    // Pine CondIni alternation:
    // BUY requires the previous state to be SHORT.
    // SELL requires the previous state to be LONG.
    if (config.alternateSignals) {
      if (longSetup && previousSignalDirection === -1) {
        signal = "BUY";
      } else if (shortSetup && previousSignalDirection === 1) {
        signal = "SELL";
      }
    } else {
      if (longSetup) signal = "BUY";
      else if (shortSetup) signal = "SELL";
    }

    // Update direction state from the setup, not just emitted signals.
    if (longSetup) previousSignalDirection = 1;
    else if (shortSetup) previousSignalDirection = -1;

    results.push({
      timestamp: candle.timestamp,
      timeframe: config.timeframe,
      close,

      // Trading signals
      signal,
      longSetup,
      shortSetup,

      // Range Filter
      rangeFilter: range.filter[i],
      rangeUpCount: range.upward[i],
      rangeDownCount: range.downward[i],
      rangeLong: isRangeLong,
      rangeShort: isRangeShort,
      longBarsInDirection: longRun,
      shortBarsInDirection: shortRun,

      // EMA
      ema200: ema200[i],
      emaLong,
      emaShort,

      // VWAP
      vwap: vwap[i],
      vwapLong,
      vwapShort,

      // MACD
      macd: macd.macdLine[i],
      macdSignal: macd.signalLine[i],
      macdHistogram: macd.histogram[i],
      macdLong,
      macdShort,

      // Confirmation summary
      confirmations: {
        long: {
          rangeFilter: isRangeLong,
          ema200: emaLong,
          vwap: vwapLong,
          macd: macdLong,
        },
        short: {
          rangeFilter: isRangeShort,
          ema200: emaShort,
          vwap: vwapShort,
          macd: macdShort,
        },
      },
    });
  }

  return results;
}

function calculateSignalProfit(signals, candles = []) {
  let position = null;
  let totalProfit = 0;
  let winningTrades = 0;
  let losingTrades = 0;

  const trades = [];

  // Build candle lookup in case signals don't contain close prices
  const candleMap = new Map(candles.map((c) => [Number(c.timestamp), c]));

  for (const signal of signals) {
    if (signal.signal !== "BUY" && signal.signal !== "SELL") {
      continue;
    }

    const candle = candleMap.get(Number(signal.timestamp));
    const price = Number(signal.close ?? candle?.close);

    if (!Number.isFinite(price)) continue;

    const direction = signal.signal === "BUY" ? "LONG" : "SHORT";

    // Ignore repeated signals in the same direction
    if (position?.direction === direction) continue;

    // Close existing position
    if (position) {
      const points =
        position.direction === "LONG"
          ? price - position.entryPrice
          : position.entryPrice - price;

      const profit = points; // $1 per point, 1 unit

      totalProfit += profit;

      if (profit > 0) winningTrades++;
      else if (profit < 0) losingTrades++;

      trades.push({
        direction: position.direction,
        entryPrice: position.entryPrice,
        exitPrice: price,
        entryTime: position.entryTime,
        exitTime: signal.timestamp,
        points: Number(points.toFixed(2)),
        profit: Number(profit.toFixed(2)),
      });
    }

    // Open new position
    position = {
      direction,
      entryPrice: price,
      entryTime: signal.timestamp,
    };
  }

  // Calculate unrealised P&L on the last open position
  let unrealisedProfit = 0;

  if (position && candles.length > 0) {
    const lastPrice = candles[candles.length - 1].close;

    unrealisedProfit =
      position.direction === "LONG"
        ? lastPrice - position.entryPrice
        : position.entryPrice - lastPrice;
  }

  return {
    totalProfit: Number(totalProfit.toFixed(2)),
    unrealisedProfit: Number(unrealisedProfit.toFixed(2)),
    totalProfitIncludingOpen: Number(
      (totalProfit + unrealisedProfit).toFixed(2),
    ),
    totalTrades: trades.length,
    winningTrades,
    losingTrades,
    winRate: trades.length
      ? Number(((winningTrades / trades.length) * 100).toFixed(2))
      : 0,
    openPosition: position,
    trades,
  };
}

module.exports = {
  CONFIG,
  calculateSignals,
  calculateSignalProfit,
};
