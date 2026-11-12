require("../config/config");
const cron = require("node-cron");
const populateDataInRedis = require("./populate_data");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { sendPushNotif } = require("../config/telegram_notify");

const autoForexOrder = require("./auto_forex_order");

const obDetector = require("./ob_detector.js");
const autoCryptoOrder = require("./auto_crypto_order.js");
const cisdLookup = require("./cisd.js");

const forexEma200 = require("./forex_ema_200.js");

const marketCloser = require("./market_closer.js");
const capitalCrypto = require("./capital_crypto.js");
const xau15Minutes = require("./xau_15_minute.js");
const bhediya = require("./bhediya.js");

const btcWigs = require("./btc_wigs.js");
const trendlineCrypto = require("./trendline_crypto.js");
const coingeckoPairs = require("./coingecko_pairs.js");

const forexAdaptiveTrendline = require("./forex_adaptive_trendline.js");
const cryptoBos4Hr = require("./crypto_bos_4_hr.js");
const forexBos4Hr = require("./forex_bos_4hr.js");
const cryptoEma980 = require("./crypto_980.js");

const theForexPerfectMapo = require("./mapo_forex_perfect.js");
dayjs.extend(utc);
dayjs.extend(timezone);

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

cron.schedule(
  "0 5 * * 6",
  async () => {
    console.log("Running Saturday 5:00 AM Brisbane time");

    try {
      //await marketCloser();
    } catch (err) {
      console.error("Error in marketCloser: ", err);
      await sendPushNotif("Error in marketCloser: " + err.message);
    }
  },
  {
    timezone: "Australia/Brisbane",
  },
);

cron.schedule("*/5 * * * *", async () => {
  await sleep(20);
  try {
    await theForexPerfectMapo("5m");
    //await autoCryptoOrder();
  } catch (err) {
    console.error("Error in theForexPerfectMapo: ", err);
    await sendPushNotif("Error in theForexPerfectMapo: " + err.message);
  }
  await sleep(5);
  try {
    //await capitalCrypto();
    //await coingeckoPairs();
  } catch (err) {
    console.error("Error in coingeckoPairs: ", err);
    await sendPushNotif("Error in coingeckoPairs: " + err.message);
  }
});

cron.schedule("0 */1 * * *", async () => {
  await sleep(30);

  console.log("Running forexEma200");

  try {
    await forexEma200();
  } catch (err) {
    console.error("Error in forexEma200: ", err);
    await sendPushNotif("Error in forexEma200: " + err.message);
  }

  await sleep(2);

  console.log("Running cryptoEma980");

  try {
    await cryptoEma980();
  } catch (err) {
    console.error("Error in cryptoEma980: ", err);
    await sendPushNotif("Error in cryptoEma980: " + err.message);
  }

  await sleep(2);
  try {
    await btcWigs();
  } catch (err) {
    console.error("Error in btcWigs: ", err);
    await sendPushNotif("Error in btcWigs: " + err.message);
  }
});

cron.schedule(
  "0 3,7,11,15,19,23 * * *",
  async () => {
    console.log("Running forexBos4Hr");

    await sleep(60);

    try {
      await forexBos4Hr();
    } catch (err) {
      console.error("Error in forexBos4Hr: ", err);
      await sendPushNotif("Error in forexBos4Hr: " + err.message);
    }
  },
  {
    timezone: "Australia/Brisbane",
  },
);

cron.schedule("0 */12 * * *", async () => {
  await populateDataInRedis();
});
