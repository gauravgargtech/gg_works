require("../config/config");
const https = require("https");

const { set, get } = require("../adapters/redis");
const { EMA } = require("technicalindicators");

const { sendPushNotif } = require("../config/telegram_notify");

const { fetchCandles } = require("../exhanges/oanda");

const findOrberBlocks = require("../indicators/order_block");
const axios = require("axios");

// ─── Helpers ──────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Main ─────────────────────────────────────────────────────
async function orderBlockFound() {
  const lowTFPairs = ["AU200_AUD", "XAU_USD", "XAG_USD", "BTC_USD"];
  for (const coin of FOREX_PAIRS) {
    const symbol = coin;

    await sleep(1000);

    console.log(`Scanning for ${symbol}...`);

    const bullishOBsH1 = JSON.parse(await get(`bullishOBs_${symbol}_H1`));
    const bearishOBsH1 = JSON.parse(await get(`bearishOBs_${symbol}_H1`));

    const bullishOBsH4 = JSON.parse(await get(`bullishOBs_${symbol}_H4`));
    const bearishOBsH4 = JSON.parse(await get(`bearishOBs_${symbol}_H4`));

    const bullishOBsD = JSON.parse(await get(`bullishOBs_${symbol}_D`));
    const bearishOBsD = JSON.parse(await get(`bearishOBs_${symbol}_D`));

    const bullishOBsW = JSON.parse(await get(`bullishOBs_${symbol}_W`));
    const bearishOBsW = JSON.parse(await get(`bearishOBs_${symbol}_W`));

    const allBullishObs = [];
    const allBearishObs = [];

    if (
      bullishOBsH1 &&
      bullishOBsH1.length > 0 &&
      lowTFPairs.includes(symbol)
    ) {
      for (const bb of bullishOBsH1) {
        allBullishObs.push({
          timeframe: "H1",
          ...bb,
        });
      }
    }
    if (
      bullishOBsH4 &&
      bullishOBsH4.length > 0 &&
      lowTFPairs.includes(symbol)
    ) {
      for (const bb of bullishOBsH4) {
        allBullishObs.push({
          timeframe: "H4",
          ...bb,
        });
      }
    }
    if (bullishOBsD && bullishOBsD.length > 0) {
      for (const bb of bullishOBsD) {
        allBullishObs.push({
          timeframe: "D",
          ...bb,
        });
      }
    }

    if (bullishOBsW && bullishOBsW.length > 0) {
      for (const bb of bullishOBsW) {
        allBullishObs.push({
          timeframe: "W",
          ...bb,
        });
      }
    }

    if (bearishOBsH1 && lowTFPairs.includes(symbol)) {
      for (const bb of bearishOBsH1) {
        allBearishObs.push({
          timeframe: "H1",
          ...bb,
        });
      }
    }
    if (bearishOBsH4 && lowTFPairs.includes(symbol)) {
      for (const bb of bearishOBsH4) {
        allBearishObs.push({
          timeframe: "H4",
          ...bb,
        });
      }
    }
    if (bearishOBsD) {
      for (const bb of bearishOBsD) {
        allBearishObs.push({
          timeframe: "D",
          ...bb,
        });
      }
    }

    if (bearishOBsW) {
      for (const bb of bearishOBsW) {
        allBearishObs.push({
          timeframe: "W",
          ...bb,
        });
      }
    }

    const candles = await fetchCandles(symbol, "H1", 250);
    const closes = candles.map((c) => c.close);

    const ema200Minute15 = EMA.calculate({ period: 200, values: closes });

    const latestCandleClose = candles[candles.length - 1].close;
    const latestEma = ema200Minute15[ema200Minute15.length - 1];

    let theBias = "bearish";
    if (latestCandleClose > latestEma) {
      theBias = "bullish";
    }

    await sleep(1000);
    const candlesAt3Minute = await fetchCandles(symbol, "M3", 5);
    const candlesAt3MinuteLow =
      candlesAt3Minute[candlesAt3Minute.length - 1].low;
    const candlesAt3MinuteHigh =
      candlesAt3Minute[candlesAt3Minute.length - 1].high;

    if (theBias === "bearish") {
      for (const bullish of allBullishObs) {
        if (
          candlesAt3MinuteLow < bullish.top &&
          candlesAt3MinuteLow >= bullish.bottom
        ) {
          const isCC = await get(`is_send_ob_${symbol}`);
          if (!isCC) {
            sendPushNotif(
              `${bullish.timeframe} OB Tapped: for ${symbol} at ${candlesAt3MinuteLow}, ${bullish.breaker ? "Breaker Block" : ""}, Price may go UP a bit, Long entry is recommended, confirm at at 1 minute.`,
            );
            await set(`is_send_ob_${symbol}`, "ok", 3600 * 24);
          }
        }
      }
    } else {
      for (const bearish of allBearishObs) {
        if (
          candlesAt3MinuteHigh > bearish.bottom &&
          candlesAt3MinuteHigh <= bearish.top
        ) {
          const isCC = await get(`is_send_ob_${symbol}`);
          if (!isCC) {
            sendPushNotif(
              `${bearish.timeframe} OB Tapped: for ${symbol} at ${candlesAt3MinuteLow}, ${bearish.breaker ? "Breaker Block" : ""}, Price may go down a bit, Short entry is recommended, confirm at at 1 minute.`,
            );
            await set(`is_send_ob_${symbol}`, "ok", 3600 * 24);
          }
        }
      }
    }
  }
  return;
}

module.exports = orderBlockFound;
