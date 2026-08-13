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

const checkVortexBTC = require("./btc_vortex");

const autoForexOrder = require("./auto_forex_order");
const fvgForexInstant = require("./fvg_forex");
const checkIsNearSupportResis = require("./is_near_resis_support");
const calculateResistanceSupport = require("./bos_4_hr");
const checkIfFVGFilled = require("./fvg_filled");

const orderBlockFinder = require("./order_block_finder");
const currencyTrend = require("./currency_trend");
const checkAdxTrendIndices = require("./indices");

const orderBlockFound = require("./order_block_found");

const checkAU20015M = require("./au200_15m");
const vortedAdx = require("./vortex_adx");
const btcKamaTouch = require("./btc_kama");

const forexKamaTouch = require("./forex_pkama_touch");

//const slowVortexTsiForex = require("./slow_vortex_tsi_forex");

const btcFiveMinute = require("./btc_five_minute");

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

const checkCryptoVortex = require("./crypto_vortex.js");

const gbpPairsVortex = require("./gbp_vortex.js");

const xauFiveMinute = require("./xau_5_minute.js");

const forexFifteenMinute = require("./forex_15_chop.js");

const autoXauOrder = require("./auto_xau_order.js");

const runTpForex = require("./tp_forex.js");
const choppyDetector = require("./choppy_detector.js");
const runTpForexHalf = require("../crons/tp_forex_profit_half.js");

const fvgDetectorBTC = require("./fvg_detector_btc.js");
const orderChecker = require("./order_checker.js");
const checkVortexForex = require("./vortex_forex.js");
dayjs.extend(utc);
dayjs.extend(timezone);

const coins = ["BTCUSDT"];

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// PRE ORDER Daily Bias

cron.schedule(
  "0 8 * * *",
  async () => {
    await sleep(10);
    try {
      await checkVortexForex();
    } catch (err) {
      console.error("Error in checkVortexForex: ", err);
      await sendPushNotif("Error in checkVortexForex: " + err.message);
    }
    // Fetch D1 candles
    // Calculate indicators
    // Store results
  },
  { timezone: "Australia/Brisbane" },
);

cron.schedule("*/5 * * * *", async () => {
  await sleep(5);

  try {
    await xauFiveMinute();
  } catch (err) {
    console.error("Error in xauFiveMinute: ", err);
    await sendPushNotif("Error in xauFiveMinute: " + err.message);
  }

  try {
    await runTpForexHalf();
  } catch (err) {
    console.error("Error in slowVortexTsiForex: ", err);
    await sendPushNotif("Error in slowVortexTsiForex: " + err.message);
  }
});

cron.schedule("*/10 * * * *", async () => {
  await sleep(5);

  try {
    await choppyDetector();
  } catch (err) {
    console.error("Error in choppyDetector: ", err);
    await sendPushNotif("Error in choppyDetector: " + err.message);
  }
});

cron.schedule("0 */4 * * *", async () => {
  try {
    await forexKamaTouch();
  } catch (err) {
    console.error("Error in forexKamaTouch: ", err);
    await sendPushNotif("Error in forexKamaTouch: " + err.message);
  }
});
cron.schedule("0 */1 * * *", async () => {
  await sleep(5);

  try {
    await runTpForex();
  } catch (err) {
    console.error("Error in slowVortexTsiForex: ", err);
    await sendPushNotif("Error in slowVortexTsiForex: " + err.message);
  }

  try {
    await autoXauOrder();
  } catch (err) {
    console.error("Error in autoXauOrder: ", err);
    await sendPushNotif("Error in autoXauOrder: " + err.message);
  }

  await sleep(5);

  try {
    await autoForexOrder();
  } catch (err) {
    console.error("Error in autoForexOrder: ", err);
    await sendPushNotif("Error in autoForexOrder: " + err.message);
  }

  await sleep(5);

  try {
    await currencyTrend();
  } catch (err) {
    console.error("Error in currencyTrend: ", err);
    await sendPushNotif("Error in currencyTrend: " + err.message);
  }
});

cron.schedule("0 */12 * * *", async () => {
  await populateDataInRedis();
});
