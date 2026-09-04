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

const forexKamaMulti = require("./forex_kama_multi.js");
const runTpForex = require("./tp_forex.js");
const choppyDetector = require("./choppy_detector.js");
const runTpForexHalf = require("../crons/tp_forex_profit_half.js");

const autoCryptoOrder = require("./auto_crypto_order.js");
const cisdLookup = require("./cisd.js");

const marketCloser = require("./market_closer.js");
const autoForexOrder4Hr = require("./auto_forex_order_4hr.js");

const fvgDetectorBTC = require("./fvg_detector_btc.js");
const orderChecker = require("./order_checker.js");
const checkVortexForex = require("./vortex_forex.js");
dayjs.extend(utc);
dayjs.extend(timezone);

const coins = ["BTCUSDT"];

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
cron.schedule("0 */1 * * *", async () => {
  await sleep(30);

  try {
    await autoForexOrder();
  } catch (err) {
    console.error("Error in autoForexOrder: ", err);
    await sendPushNotif("Error in autoForexOrder: " + err.message);
  }

  try {
    await autoCryptoOrder();
  } catch (err) {
    console.error("Error in autoCryptoOrder: ", err);
    await sendPushNotif("Error in autoCryptoOrder: " + err.message);
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
