require("../config/config");

const dayjs = require("dayjs");

const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const { set, get, del } = require("../adapters/redis");
const calculateObLuxalgo = require("../indicators/ob_detector_luxalgo");

const _ = require("lodash");

const { getCandles } = require("../exhanges/capital");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Main ─────────────────────────────────────────────────────
async function obDetector() {
  const now = dayjs().tz("Australia/Brisbane");
  const day = now.day(); // 0 Sun - 6 Sat
  const hour = now.hour();

  let isWeekend = false;
  // Saturday after 4am
  if (day === 6 && hour >= 4) {
    isWeekend = true;
  }

  // Sunday full day
  if (day === 0) {
    isWeekend = true;
  }

  // Monday before 4am
  if (day === 1 && hour < 7) {
    isWeekend = true;
  }

  if (isWeekend) {
    return;
  }

  console.log("--Running auto fixex");

  for (const symbol of FOREX_PAIRS) {
    let candles;
    try {
      candles = await getCandles(symbol.replace("_", ""), "4h", 990);
    } catch (err) {
      continue;
    }

    if (candles.length < 900) {
      console.log(`Not enough candles for ${symbol}`);
      continue;
    }

    console.log(`Scanning symbol: ${symbol}`);

    await sleep(2);

    const newCandles = candles.map((c) => ({
      openTime: dayjs(c.openTime).tz("Australia/Brisbane").valueOf(),
      closeTime: dayjs(c.openTime)
        .add(15, "minutes")
        .tz("Australia/Brisbane")
        .valueOf(),
      time: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    const obs = await calculateObLuxalgo(newCandles);

    await set(`ob_detected_for_${symbol}_at`, JSON.stringify(obs));
    console.log(`Total obs detected for ${symbol} are ${obs.length} `);
  }
}

module.exports = obDetector;
