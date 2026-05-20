require("../config/config");
const cron = require("node-cron");
const populateDataInRedis = require("./populate_data");
const runIndicator = require("./log_signals_indicator");
const weekendClose = require("./weekend_close");
const scanMongoAndFindSignals = require("./place_order");
require("./place_tp_orders");

cron.schedule("*/5 * * * *", async () => {
  console.log("Refresh Instruments Data every 5 minutes");

  try {
    await runIndicator();
  } catch (err) {
    console.error("Error in scanning and logging: ", err);
  }

  try {
    await scanMongoAndFindSignals();
  } catch (err) {
    console.error("Error in placing orders: ", err);
  }
  //await logSignalsInMongo();
  //await checkMomentum();
});

cron.schedule("0 0 */8 * * *", async () => {
  console.log("Refresh Instruments Data every 4 hours");
  await populateDataInRedis();
});

cron.schedule("0 0 */1 * * *", async () => {
  console.log("Refresh Instruments Data every 4 hours");
  console.log("═══════════════════════════════════════════════════");
  console.log("═══════════════════════════════════════════════════");

  await weekendClose();
});
