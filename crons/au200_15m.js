require("../config/config");
const https = require("https");

const { set, get, del } = require("../adapters/redis");
const { EMA } = require("technicalindicators");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const { fetchCandles, getInstruments } = require("../exhanges/oanda");

// ─── Main ─────────────────────────────────────────────────────
async function checkAU20015M() {
  const candles = await fetchCandles("AU200_AUD", "M15", 800);

  const closes = candles.map((c) => c.close);

  const ema200 = EMA.calculate({ period: 200, values: closes });

  const ema200Last = ema200[ema200.length - 1];
  const ema200SecondLast = ema200[ema200.length - 2];

  const last12Candles = candles.slice(-5);
  const last12Ema200 = ema200.slice(-5);

  let isComingFromDiffDirection = false;

  let currentDirection = "";

  if (ema200Last <= closes[0]) {
    currentDirection = "up";
  } else {
    currentDirection = "down";
  }

  for (let gg = 0; gg < last12Candles.length; gg++) {
    if (
      currentDirection === "up" &&
      last12Candles[gg].close <= last12Ema200[gg]
    ) {
      isComingFromDiffDirection = true;
    } else if (
      currentDirection === "down" &&
      last12Candles[gg].close >= last12Ema200[gg]
    ) {
      isComingFromDiffDirection = true;
    }
  }

  console.log(
    `AU200: ${currentDirection} - ${ema200Last} - ${closes[0]} - ${isComingFromDiffDirection}`,
  );
  if (isComingFromDiffDirection) {
    let iscC = await get("aud200_trend");

    if (!iscC) {
      await sendPushNotif(
        `AUD200 Crossover Detected - Going ${currentDirection}`,
      );

      await set("aud200_trend", "ooo", 2000);
    }
  }
}

module.exports = checkAU20015M;
