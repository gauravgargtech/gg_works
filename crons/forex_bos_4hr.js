require("../config/config");

const dayjs = require("dayjs");

const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

const { getLatestBOS } = require("../indicators/bos_laviathan");

dayjs.extend(utc);
dayjs.extend(timezone);

const { get, set } = require("../adapters/redis");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const { getCandles } = require("../exhanges/capital");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Main ─────────────────────────────────────────────────────
async function forexBos4Hr() {
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

  for (const symbol of ["GOLD", "AUD_USD", "NZD_USD", "EUR_USD", "GBP_USD"]) {
    let candles;
    try {
      candles = await getCandles(symbol.replace("_", ""), "4h", 980);
    } catch (err) {
      console.error(err);
      continue;
    }

    console.log(`Scanning symbol: ${symbol}`);

    if (candles.length < 900) {
      console.log(`Not enough candles for ${symbol}`);
      continue;
    }
    const latestBos = getLatestBOS(candles, { swingSize: 20 });
    const currentTime = dayjs().tz("Australia/Brisbane");

    const latestBosTime = dayjs(latestBos.time2);

    const differenceInMinutes = currentTime.diff(latestBosTime, "minute");

    console.log(
      `Latest BOS happened for ${symbol}: at ${latestBosTime.format("YYYY-MM DD hh:ii:ss")}, difference in minutes: ${differenceInMinutes}`,
    );

    if (differenceInMinutes > 700) {
      continue;
    }

    const redisKey = `bos_for_${symbol}_occurred_at`;

    const isRedisFound = await get(redisKey);

    if (isRedisFound) {
      continue;
    }

    await set(redisKey, 1, 3600 * 4);

    await sleep(2);

    await sendPushNotif(
      `BOS Happened for ${symbol} at 4 Hour - BOS Type is - ${latestBos.direction}`,
    );
  }
  return;
}

module.exports = forexBos4Hr;
