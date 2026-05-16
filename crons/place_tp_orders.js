require("../config/config");
const placeForexTPOrders = require("./profits_forex");
const placeBTCTpOrders = require("./profits_btc");

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

setInterval(async () => {
  try {
    await placeForexTPOrders();
  } catch (err) {
    console.error("Error in Oanda Forex Profit Cron");
    console.log(err);
  }

  await sleep(1);
  console.log("Lets check BTC TP orders");
  try {
    await placeBTCTpOrders();
  } catch (err) {
    console.error("Error in BTC Take Profit Cron");
    console.log(err);
  }
}, 15000);
