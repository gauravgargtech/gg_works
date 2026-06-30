require("../config/config");
const YahooFinance = require("yahoo-finance2").default;
const { EMA, ADX } = require("technicalindicators");

// Create a class instance as required by the library updates
const yahooFinance = new YahooFinance();
const { sendPushNotif } = require("../config/telegram_notify");
const { set, get, del } = require("../adapters/redis");

function checkCrossover(results, threshold) {
  // Only use bars where ADX is fully calculated
  const valid = results.filter((r) => r.adx !== null);
  if (valid.length < 2) return null;

  const curr = valid[valid.length - 1];
  const prev = valid[valid.length - 2];

  const last12ADx = results.slice(-22);

  let wasMarketSilent = false;

  for (const adx of last12ADx) {
    if (adx.adx < 18) {
      wasMarketSilent = true;
    }
  }

  return {
    curr,
    prev,
    // The key signal: ADX was below threshold, now crossed above
    crossedAbove: prev.adx < threshold && curr.adx >= threshold,
    // Also useful: ADX is above threshold AND still rising
    risingAbove: curr.adx >= threshold && curr.adx > prev.adx && curr.adx < 28,
    // ADX is rising regardless of level
    rising: curr.adx > prev.adx,
    wasMarketSilent,
  };
}

async function getOfficialDXYIndicators() {
  const symbol = "DX-Y.NYB";

  const queryOptions = {
    // Go back ~5 days to ensure we easily cover the 300 candle threshold
    // taking weekend gaps and market closes into account
    period1: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0],
    interval: "2m", // Supported options: '1m', '2m', '5m', '15m', '30m'
  };
  try {
    console.log(
      `Fetching official DXY historical data via Chart API (${symbol})...`,
    );

    // This will now call cleanly off the instance wrapper
    const chartData = await yahooFinance.chart(symbol, queryOptions);

    if (!chartData || !chartData.quotes) {
      throw new Error("No data returned from Yahoo Finance.");
    }

    // Filter and sort the array
    const cleanData = chartData.quotes
      .filter(
        (bar) => bar.close !== null && bar.high !== null && bar.low !== null,
      )
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    console.log(`Retrieved ${cleanData.length} valid days of index data.`);

    const highs = cleanData.map((bar) => bar.high);
    const lows = cleanData.map((bar) => bar.low);
    const closes = cleanData.map((bar) => bar.close);
    const dates = cleanData.map((bar) => bar.date);

    // Calculate Technical Indicators
    const ema200Values = EMA.calculate({ period: 50, values: closes });
    const adxValues = ADX.calculate({
      period: 14,
      high: highs,
      low: lows,
      close: closes,
    });

    const emaOffset = closes.length - ema200Values.length;
    const adxOffset = closes.length - adxValues.length;

    const check = checkCrossover(adxValues, 20);
    const { curr, prev } = check;

    const currentPrice = cleanData[cleanData.length - 1].close;
    let isEMA200Aligned = false;

    if (curr.diPlus > curr.diMinus && currentPrice > ema200Last) {
      isEMA200Aligned = true;
    } else if (curr.diPlus < curr.diMinus && currentPrice < ema200Last) {
      isEMA200Aligned = true;
    }

    const last12Candles = cleanData.slice(-12);
    let isComingFromDiffDirection = false;

    for (const cg of last12Candles) {
      if (curr.diPlus > curr.diMinus && cg.low <= ema200Last) {
        isComingFromDiffDirection = true;
      } else if (curr.diPlus < curr.diMinus && cg.high >= ema200Last) {
        isComingFromDiffDirection = true;
      }
    }

    const redisKeyUp = `dxy_adx_value_up_5`;
    const redisKeyDown = `dxy_adx_value_down_5`;

    console.log(
      `is Market Aligned : ${isEMA200Aligned} is Coming From Different Direction : ${isComingFromDiffDirection}`,
    );
    if (
      (check.crossedAbove || check.risingAbove) &&
      check.wasMarketSilent &&
      isEMA200Aligned &&
      isComingFromDiffDirection
    ) {
      let iscC = false;
      if (curr.diPlus > curr.diMinus) {
        iscC = await get(redisKeyUp);
      } else if (curr.diPlus < curr.diMinus) {
        iscC = await get(redisKeyDown);
      }

      if (!iscC) {
        await sendPushNotif(
          `DXY 5 Minutes : ADX above 20 and rising in some direction`,
        );

        let cacheExpiry = 3600 * 16;
        if (theTimeInterval === "D") {
          cacheExpiry = 3600 * 24 * 3;
        }

        if (curr.diPlus > curr.diMinus) {
          await set(redisKeyUp, JSON.stringify(check), cacheExpiry);
        } else if (curr.diPlus < curr.diMinus) {
          await set(redisKeyDown, JSON.stringify(check), cacheExpiry);
        }
      }
    }
  } catch (error) {
    console.error("Failed to parse official DXY metrics:", error.message);
  }
}

module.exports = getOfficialDXYIndicators;
