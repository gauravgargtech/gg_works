require("../config/config");
const cron = require("node-cron");
const populateDataInRedis = require("./populate_data");
const runIndicator = require("./log_signals_indicator");
const weekendClose = require("./weekend_close");
const scanMongoAndFindSignals = require("./place_order");
const fetchBalance = require("./fetch_balance");
//require("./place_tp_orders");
const mapoBtc = require("./mapo_btc");
const { sendSignalAlert, sendPushNotif } = require("../config/telegram_notify");
const theForexPerfectMapo = require("./mapo_forex_perfect");
const closeTo4Hour = require("./close_to_4_hour");
const runEmaCrossing = require("./ema_crossing");
const runEmaCrossingSimple = require("./ema_crossing_simple");
const checkMacdAdx = require("./macd_adx");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const checkMacdAdxReversal = require("./macd_adx_reversal");

dayjs.extend(utc);
dayjs.extend(timezone);

const coins = ["BTCUSDT"];

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

cron.schedule("0 */4 * * *", async () => {
  console.log("Refresh MAPO Data every 4 hours");

  const now = dayjs().tz("Australia/Brisbane");
  const hour = now.hour();

  if (hour > 2 && hour < 8) return;

  try {
    await runEmaCrossingSimple();
  } catch (err) {
    console.error("Error in ema_crossing_simple: ", err);
    await sendPushNotif("Error in ema_crossing_simple: " + err.message);
  }
});

cron.schedule("*/5 * * * *", async () => {
  console.log("Refresh Instruments Data every 5 minutes");

  const now = dayjs().tz("Australia/Brisbane");
  const hour = now.hour();

  if (hour > 2 && hour < 8) return;

  /*
  try {
    await theForexPerfectMapo("M5");
  } catch (err) {
    console.error("Error in mapo_forex_perfect: ", err);
    await sendPushNotif("Error in mapo_forex_perfect: " + err.message);
  }*/
});

cron.schedule("*/15 * * * *", async () => {
  console.log("Refresh Instruments Data every 5 minutes");
  const now = dayjs().tz("Australia/Brisbane");
  const hour = now.hour();

  if (hour > 2 && hour < 8) return;

  try {
    await checkMacdAdx();
  } catch (err) {
    console.error("Error in macd_adx: ", err);
    await sendPushNotif("Error in macd_adx: " + err.message);
  }

  try {
    await checkMacdAdxReversal();
  } catch (err) {
    console.error("Error in checkMacdAdxReversal: ", err);
    await sendPushNotif("Error in checkMacdAdxReversal: " + err.message);
  }
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
