require("../config/config");
const cron = require("node-cron");
const populateDataInRedis = require("./populate_data");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { sendPushNotif } = require("../config/telegram_notify");

const autoForexOrder = require("./auto_forex_order");

const autoCryptoOrder = require("./auto_crypto_order.js");
const cisdLookup = require("./cisd.js");

const marketCloser = require("./market_closer.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

cron.schedule(
  "0 5 * * 6",
  async () => {
    console.log("Running Saturday 5:00 AM Brisbane time");

    try {
      await marketCloser();
    } catch (err) {
      console.error("Error in marketCloser: ", err);
      await sendPushNotif("Error in marketCloser: " + err.message);
    }
  },
  {
    timezone: "Australia/Brisbane",
  },
);

cron.schedule("*/15 * * * *", async () => {
  await sleep(5);
  try {
    await autoCryptoOrder();
  } catch (err) {
    console.error("Error in autoCryptoOrder: ", err);
    await sendPushNotif("Error in autoCryptoOrder: " + err.message);
  }
});

cron.schedule("0 */1 * * *", async () => {
  await sleep(30);

  try {
    await autoForexOrder();
  } catch (err) {
    console.error("Error in autoForexOrder: ", err);
    await sendPushNotif("Error in autoForexOrder: " + err.message);
  }
});

cron.schedule(
  "0 3,7,11,15,19,23 * * *",
  async () => {
    await sleep(10);

    try {
      await cisdLookup();
    } catch (err) {
      console.error("Error in autoForexOrder: ", err);
      await sendPushNotif("Error in autoForexOrder: " + err.message);
    }
  },
  {
    timezone: "Australia/Brisbane",
  },
);

cron.schedule("0 */12 * * *", async () => {
  await populateDataInRedis();
});
