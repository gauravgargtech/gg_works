require("../config/config");
const cron = require("node-cron");
const populateDataInRedis = require("./populate_data");
const checkAdxTrend = require("./adx");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { sendSignalAlert, sendPushNotif } = require("../config/telegram_notify");
const checkAdxTrendForex = require("./adx_forex");
const runSentiment = require("./news_sentiment");

const checkIsNearSupportResis = require("./is_near_resis_support");
const calculateResistanceSupport = require("./bos_4_hr");
const runEmaCrossingSimpleFar = require("./ema_crossing_simple");

/*
const btcEmaTrending = require("./btc_ema_50_200.js");
const runIndicator = require("./log_signals_indicator");
const weekendClose = require("./weekend_close");
const scanMongoAndFindSignals = require("./place_order");
const fetchBalance = require("./fetch_balance");
//require("./place_tp_orders");
const mapoBtc = require("./mapo_btc");
const theForexPerfectMapo = require("./mapo_forex_perfect");
const closeTo4Hour = require("./close_to_4_hour");
const runEmaCrossing = require("./ema_crossing");
const runEmaCrossingSimple = require("./ema_crossing_simple");
const checkMacdAdx = require("./macd_adx");
const checkMacdAdxReversal = require("./macd_adx_reversal");
const fvgDetector = require("../crons/fvg_detector_forex.js");
*/
const scanAllPairs = require("./fvg_detector_new.js");
const fetchBOS = require("./fetch_bos.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const coins = ["BTCUSDT"];

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

cron.schedule("0 */1 * * *", async () => {
  await sleep(5);

  try {
    await checkAdxTrendForex(240);
  } catch (err) {
    console.error("Error in adx_forex: ", err);
    await sendPushNotif("Error in adx_forex: " + err.message);
  }

  await sleep(5);

  try {
    // This is for FVG BOS
    await fetchBOS();
  } catch (err) {
    console.error("Error in fetchBOS: ", err);
    await sendPushNotif("Error in fetchBOS: " + err.message);
  }

  await sleep(5);

  try {
    // This is for BOS
    await scanAllPairs();
  } catch (err) {
    console.error("Error in scanAllPairs: ", err);
    await sendPushNotif("Error in scanAllPairs: " + err.message);
  }
});

cron.schedule("0 */4 * * *", async () => {
  console.log("Refresh MAPO Data every 4 hours");

  try {
    await checkAdxTrend(240);
  } catch (err) {
    console.error("Error in adx: ", err);
    await sendPushNotif("Error in adx: " + err.message);
  }

  /*
  try {
    await checkMacdAdxReversal(240);
  } catch (err) {
    console.error("Error in checkMacdAdxReversal: ", err);
    await sendPushNotif("Error in checkMacdAdxReversal: " + err.message);
  }


  try {
    await runEmaCrossingSimple();
  } catch (err) {
    console.error("Error in ema_crossing_simple: ", err);
    await sendPushNotif("Error in ema_crossing_simple: " + err.message);
  }

  await sleep(5);

  */
});

cron.schedule("*/5 * * * *", async () => {
  try {
    await checkIsNearSupportResis();
  } catch (err) {
    console.error("Error in checkIsNearSupportResis: ", err);
    await sendPushNotif("Error in checkIsNearSupportResis: " + err.message);
  }
});

cron.schedule("*/15 * * * *", async () => {
  console.log("Refresh Instruments Data every 5 minutes");

  try {
    await checkAdxTrend(15);
  } catch (err) {
    console.error("Error in adx: ", err);
    await sendPushNotif("Error in adx: " + err.message);
  }
  /*
  try {
    await checkMacdAdx();
  } catch (err) {
    console.error("Error in macd_adx: ", err);
    await sendPushNotif("Error in macd_adx: " + err.message);
  }
*/
  /*
  try {
    await checkMacdAdxReversal(15);
  } catch (err) {
    console.error("Error in checkMacdAdxReversal: ", err);
    await sendPushNotif("Error in checkMacdAdxReversal: " + err.message);
  }
    */

  await sleep(2);

  try {
    await runEmaCrossingSimpleFar();
  } catch (err) {
    console.error("Error in ema_crossing_simple_far: ", err);
    await sendPushNotif("Error in ema_crossing_simple_far: " + err.message);
  }

  /*
  try {
    await btcEmaTrending();
  } catch (err) {
    console.error("Error in btcEmaTrending: ", err);
    await sendPushNotif("Error in btcEmaTrending: " + err.message);
  }
    */
});

cron.schedule("0 */12 * * *", async () => {
  await populateDataInRedis();
});
