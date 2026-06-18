require("../config/config");
const _ = require("lodash");

const { find } = require("../adapters/mongo");
const { get, set } = require("../adapters/redis");
const { sendPushNotif } = require("../config/telegram_notify");

async function getCurrentPricePrice(coin = "BTCUSDT") {
  try {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${coin}`;

    const response = await fetch(url);
    const data = await response.json();

    return data.price;
  } catch (error) {
    console.error("Error fetching BTC price:", error);
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const findPercentage = (a, b) => {
  return Math.abs(((a - b) / a) * 100);
};

const checkIsNearSupportResis = async () => {
  const coinsWithNews = await get("all_found_coins");

  const coins = JSON.parse(coinsWithNews);

  for (const coin of coins) {
    const price = await getCurrentPricePrice(coin);
    console.log(`Scanning symbol ${coin}...`);

    if (!price) continue;

    const dataFromMongo = await find("resis_support", { coin: coin });

    if (dataFromMongo.length === 0) {
      continue;
    }

    let favour = "";
    for (const dd of dataFromMongo) {
      const perTop = findPercentage(price, dd.top);
      const perBottom = findPercentage(price, dd.bottom);

      if (perTop < 5 || perBottom < 5) {
        favour = dd.block_type;
      }
    }

    const percentages = [];

    for (const dd of dataFromMongo) {
      if (dd.block_type !== favour) {
        continue;
      }

      percentages.push({
        percentage: findPercentage(price, dd.top),
        timeFrame: dd.theTimeFrame,
      });
    }

    if (percentages.length === 0) {
      continue;
    }

    const lowestPercentage = _.sortBy(percentages, "percentage")[0];

    console.log(
      `Near ${favour}: ${coin} is near ${lowestPercentage.timeFrame} , close to ${lowestPercentage.percentage}%`,
    );

    if (lowestPercentage.percentage < 1) {
      const isCC = await get(`${coin}_is_near_resis_supports`);
      if (!isCC) {
        await sendPushNotif(
          `Near ${favour}: ${coin} is near ${lowestPercentage.timeFrame} , close to ${lowestPercentage.percentage}!`,
        );
        await set(`${coin}_is_near_resis_supports`, "ok", 3600 * 16);
      }
    }

    await sleep(1000);
  }
  return;
};

module.exports = checkIsNearSupportResis;
