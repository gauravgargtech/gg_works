require("../config/config");
const cron = require("node-cron");
const populateDataInRedis = require("./populate_data");
const runIndicator = require("./log_signals_indicator");
const weekendClose = require("./weekend_close");
const scanMongoAndFindSignals = require("./place_order");
const fetchBalance = require("./fetch_balance");
require("./place_tp_orders");
const mapoBtc = require("./mapo_btc");
const { sendSignalAlert, sendPushNotif } = require("../config/telegram_notify");

cron.schedule("0 */4 * * *", async () => {
  console.log("Refresh MAPO Data every 4 hours");
  try {
    await mapoBtc();
  } catch (err) {
    console.error("Error in mapo_btc: ", err);
    await sendPushNotif("Error in mapo_btc: " + err.message);
  }
});

cron.schedule("*/5 * * * *", async () => {
  console.log("Refresh Instruments Data every 5 minutes");

  try {
    //await runIndicator();
  } catch (err) {
    //console.error("Error in scanning and logging: ", err);
  }

  try {
    //await scanMongoAndFindSignals();
  } catch (err) {
    //console.error("Error in placing orders: ", err);
  }
  //await logSignalsInMongo();
  //await checkMomentum();
});

cron.schedule("0 0 */8 * * *", async () => {
  console.log("Refresh Instruments Data every 8 hours");
  await populateDataInRedis();
});

cron.schedule("0 0 */1 * * *", async () => {
  console.log("Refresh Instruments Data every 1 hours");
  console.log("═══════════════════════════════════════════════════");
  console.log("═══════════════════════════════════════════════════");

  try {
    await weekendClose();
  } catch (err) {
    console.error("Error in weekend close: ", err);
    await sendPushNotif("Error in weekend close: " + err.message);
  }

  try {
    await fetchBalance();
  } catch (err) {
    console.error("Error in fetch balance: ", err);
    await sendPushNotif("Error in fetch balance: " + err.message);
  }
});
