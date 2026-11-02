require("../config/config");

const dayjs = require("dayjs");

const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

const { getLatestBOS } = require("../indicators/bos_laviathan");
const { getCoinsWithMarketCapAtLeast } = require("../exhanges/coingecko");
const { fetchCandles } = require("../exhanges/bybit_public");

dayjs.extend(utc);
dayjs.extend(timezone);

const { get, set } = require("../adapters/redis");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Main ─────────────────────────────────────────────────────
async function cryptoBos4Hr() {
  const coinData = await getCoinsWithMarketCapAtLeast(120_000_000);

  const top50Pairs = coinData
    .slice(0, 100)
    .map((coin) => ({ symbol: coin.symbol.toUpperCase() + "USDT" }));

  const fromAPI = [];

  for (const top50 of top50Pairs) {
    if (!["USDTUSDT", "USDCUSDT", "USD1USDT"].includes(top50.symbol)) {
      fromAPI.push(top50.symbol);
    }
  }

  for (const symbol of fromAPI) {
    let candles;
    try {
      candles = await fetchCandles(symbol, 240, 8000);
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

module.exports = cryptoBos4Hr;
