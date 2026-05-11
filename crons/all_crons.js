require("../config/config");
const cron = require("node-cron");
const ema4Hours = require("./ema_4_hours");
const logSignalsInMongo = require("./log_signals_in_mongo");
const checkMomentum = require("./momentum");
const populateDataInRedis = require("./populate_data");
const scanSignalsAndSendNotis = require("./scan_last_signals");
const oandaSignal = require("../experiments/oanda_ema_21_50_macd_histogram");
const btcSignals = require("../experiments/ema_21_50_macd_histogram");
const checkEmaCloseness = require("./4_hour_ema_closeness");

const weekendClose = require("./weekend_close");

cron.schedule("0 0 */4 * * *", async () => {
  console.log("Refresh Instruments Data every 4 hours");
  //await ema4Hours();
});

cron.schedule("*/5 * * * *", async () => {
  console.log("Refresh Instruments Data every 5 minutes");
  await logSignalsInMongo();
});

cron.schedule("*/30 * * * *", async () => {
  await checkMomentum();
});

cron.schedule("0 0 */4 * * *", async () => {
  console.log("Refresh Instruments Data every 4 hours");
  await populateDataInRedis();
});

cron.schedule("*/15 * * * *", async () => {
  console.log("Refresh Instruments Data every 15 minutes");
  await scanSignalsAndSendNotis();
});

cron.schedule("0 0 */1 * * *", async () => {
  console.log("Refresh Instruments Data every 5 minutes");
  await weekendClose();
});

cron.schedule("*/15 * * * *", async () => {
  console.log("Refresh Instruments Data every 15 minutes");
  await oandaSignal();
});

cron.schedule("*/15 * * * *", async () => {
  console.log("═══════════════════════════════════════════════════");
  console.log("  BTCUSDT Perpetual — 15m Signal Engine");
  console.log("  EMA 21/50 (3-candle gap rule) + MACD Histogram");
  console.log("═══════════════════════════════════════════════════");
  // Run immediately on start
  await btcSignals();
});

cron.schedule("0 0 */4 * * *", async () => {
  console.log("Refresh Instruments Data every 4 hours");
  console.log("═══════════════════════════════════════════════════");
  console.log("═══════════════════════════════════════════════════");
  // Run immediately on start
  await checkEmaCloseness();
});
