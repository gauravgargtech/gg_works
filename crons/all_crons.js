require("../config/config");
const cron = require("node-cron");
const populateDataInRedis = require("./populate_data");
const checkAdxTrend = require("./adx");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { sendSignalAlert, sendPushNotif } = require("../config/telegram_notify");
const checkAdxTrendForex = require("./adx_forex");
//const runSentiment = require("./news_sentiment");

const fvgForexInstant = require("./fvg_forex");
const checkIsNearSupportResis = require("./is_near_resis_support");
const calculateResistanceSupport = require("./bos_4_hr");
const checkIfFVGFilled = require("./fvg_filled");

const currencyTrend = require("./currency_trend");
const checkAdxTrendIndices = require("./indices");

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
*/
const fvgDetector = require("../crons/fvg_detector_forex.js");
const btcICT = require("./btc_ict.js");
const findSwingPointsBTC = require("./swings_btc.js");
const findSwingPointsForex = require("./swing_forex.js");

const fvgDetectorBTC = require("./fvg_detector_btc.js");
const getOfficialDXYIndicators = require("./dxy.js");
const orderChecker = require("./order_checker.js");
const checkAU20015M = require("./au200_15m.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const coins = ["BTCUSDT"];

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

cron.schedule("0 */1 * * *", async () => {
  await sleep(5);

  try {
    await checkAdxTrendForex("H1");
  } catch (err) {
    console.error("Error in adx_forex: ", err);
    await sendPushNotif("Error in adx_forex: " + err.message);
  }

  await sleep(5);
  try {
    await checkAdxTrendForex("H4");
  } catch (err) {
    console.error("Error in adx_forex: ", err);
    await sendPushNotif("Error in adx_forex: " + err.message);
  }

  await sleep(5);

  try {
    await checkAdxTrendForex("D");
  } catch (err) {
    console.error("Error in adx_forex: ", err);
    await sendPushNotif("Error in adx_forex: " + err.message);
  }

  await sleep(5);
  try {
    await fvgDetector("H1");
  } catch (err) {
    console.error("Error in fvgDetector: ", err);
    await sendPushNotif("Error in fvgDetector: " + err.message);
  }

  await sleep(60);
  try {
    await checkAdxTrend(60);
  } catch (err) {
    console.error("Error in adx: ", err);
    await sendPushNotif("Error in adx: " + err.message);
  }

  try {
    await currencyTrend();
  } catch (err) {
    console.error("Error in currencyTrend: ", err);
    await sendPushNotif("Error in currencyTrend: " + err.message);
  }
  await sleep(5);
});

cron.schedule("0 */4 * * *", async () => {
  console.log("Refresh MAPO Data every 4 hours");

  await sleep(60);
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

cron.schedule("*/1 * * * *", async () => {
  try {
    await sleep(2);
    await fvgDetectorBTC();
  } catch (err) {
    console.error("Error in fvgDetectorBTC: ", err);
    await sendPushNotif("Error in fvgDetectorBTC: " + err.message);
  }
});

cron.schedule("*/3 * * * *", async () => {
  console.log("Refresh Instruments Data every 5 minutes");
  await sleep(5);

  try {
    await checkAdxTrend(3);
  } catch (err) {
    console.error("Error in adx: ", err);
    await sendPushNotif("Error in adx: " + err.message);
  }

  try {
    await checkIfFVGFilled();
  } catch (err) {
    console.error("Error in checkIfFVGFilled: ", err);
    await sendPushNotif("Error in checkIfFVGFilled: " + err.message);
  }

  await sleep(5);
  try {
    await fvgForexInstant();
  } catch (err) {
    console.error("Error in fvgForexInstant: ", err);
    await sendPushNotif("Error in fvgForexInstant: " + err.message);
  }
});

cron.schedule("*/5 * * * *", async () => {
  console.log("Refresh Instruments Data every 5 minutes");
  await sleep(5);

  try {
    await checkAdxTrendIndices("M5");
  } catch (err) {
    console.error("Error in adx: ", err);
    await sendPushNotif("Error in adx: " + err.message);
  }
  /*
  try {
    await checkMacdAdxReversal(15);
  } catch (err) {
    console.error("Error in checkMacdAdxReversal: ", err);
    await sendPushNotif("Error in checkMacdAdxReversal: " + err.message);
  }
    */

  /*
  try {
    await btcEmaTrending();
  } catch (err) {
    console.error("Error in btcEmaTrending: ", err);
    await sendPushNotif("Error in btcEmaTrending: " + err.message);
  }
    */
});

cron.schedule("*/15 * * * *", async () => {
  console.log("Refresh Instruments Data every 15 minutes");
  await sleep(3);
  try {
    await checkAU20015M();
  } catch (err) {
    console.error("Error in checkAU20015M: ", err);
    await sendPushNotif("Error in checkAU20015M: " + err.message);
  }
});

cron.schedule("0 */12 * * *", async () => {
  await populateDataInRedis();
});
