require("../config/config");
const https = require("https");
const process = require("process");
const axios = require("axios");
const { get, set } = require("../adapters/redis");
const {
  request,
  getPositionsForProfits,
  getPrice,
  closePartial,
} = require("../exhanges/oanda");

const { performance } = require("perf_hooks");

const API_KEY = process.env.OANDA_API_KEY;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const PRACTICE = true;
const BASE_URL = PRACTICE
  ? "api-fxpractice.oanda.com"
  : "api-fxtrade.oanda.com";

const INSTRUMENT = process.env.OANDA_SYMBOL;
const LOT_SIZE = 1500; // 0.01 lot = 1000 units in Forex

const expiryTime = 864000;

function calculatePips(entry, exit, type = "buy", pipSize = 0.01) {
  if (type === "buy") {
    return (exit - entry) / pipSize;
  } else {
    return (entry - exit) / pipSize;
  }
}
setInterval(async () => {
  const start = performance.now();
  const priceFromCache = await get(`${INSTRUMENT}_price`);

  let thePrice;
  if (priceFromCache) {
    thePrice = parseFloat(priceFromCache);
  } else {
    const priceFromAPI = await getPrice();
    thePrice = parseFloat(priceFromAPI.bid);
  }

  const positions = await getPositionsForProfits();

  const instrumentDetails = await get(INSTRUMENT);
  console.log(instrumentDetails);

  const buyPipsProfit = calculatePips(
    positions.price_avg,
    thePrice,
    "buy",
    instrumentDetails.tickSize,
  );
  const sellPipsProfit = calculatePips(
    positions.price_avg,
    thePrice,
    "sell",
    instrumentDetails.tickSize,
  );

  if (positions && positions?.side) {
    console.log("Buy Pips Profit: ", buyPipsProfit);
    console.log("Sell Pips Profit: ", sellPipsProfit);
    if (positions.side === "Buy") {
      const existsInCache10 = await get("EURUSD_buy_10");
      const existsInCache20 = await get("EURUSD_buy_20");
      const existsInCache30 = await get("EURUSD_buy_30");
      const existsInCache40 = await get("EURUSD_buy_40");
      const existsInCache50 = await get("EURUSD_buy_50");
      const existsInCache60 = await get("EURUSD_buy_60");
      const existsInCache70 = await get("EURUSD_buy_70");

      if (buyPipsProfit > 10 && buyPipsProfit < 20 && !existsInCache10) {
        await set("EURUSD_buy_10", "oks", expiryTime);

        await closePartial("sell", 200);
      } else if (buyPipsProfit > 20 && buyPipsProfit < 30 && !existsInCache20) {
        await set("EURUSD_buy_20", "oks", expiryTime);

        await closePartial("sell", 200);
      } else if (buyPipsProfit > 30 && buyPipsProfit < 40 && !existsInCache30) {
        await set("EURUSD_buy_30", "oks", expiryTime);

        await closePartial("sell", 200);
      } else if (buyPipsProfit > 40 && buyPipsProfit < 50 && !existsInCache40) {
        await set("EURUSD_buy_40", "oks", expiryTime);

        await closePartial("sell", 200);
      } else if (buyPipsProfit > 50 && !existsInCache50) {
        await set("EURUSD_buy_50", "oks", expiryTime);

        await closePartial("sell", 200);
      } else if (buyPipsProfit > 60 && !existsInCache60) {
        await set("EURUSD_buy_60", "oks", expiryTime);

        await closePartial("sell", 200);
      } else if (buyPipsProfit > 70 && !existsInCache70) {
        await set("EURUSD_buy_70", "oks", expiryTime);

        await closePartial("sell", 200);
      }
    } else if (positions.side === "Sell") {
      const existsInCache10 = await get("EURUSD_sell_10");
      const existsInCache20 = await get("EURUSD_sell_20");
      const existsInCache30 = await get("EURUSD_sell_30");
      const existsInCache40 = await get("EURUSD_sell_40");
      const existsInCache50 = await get("EURUSD_sell_50");
      const existsInCache60 = await get("EURUSD_sell_60");
      const existsInCache70 = await get("EURUSD_sell_70");

      if (sellPipsProfit > 10 && sellPipsProfit < 20 && !existsInCache10) {
        await set("EURUSD_sell_10", "oks", expiryTime);

        await closePartial("buy", 200);
      } else if (
        sellPipsProfit > 20 &&
        sellPipsProfit < 30 &&
        !existsInCache20
      ) {
        await set("EURUSD_sell_20", "oks", expiryTime);

        await closePartial("buy", 200);
      } else if (
        sellPipsProfit > 30 &&
        sellPipsProfit < 40 &&
        !existsInCache30
      ) {
        await set("EURUSD_sell_30", "oks", expiryTime);

        await closePartial("buy", 200);
      } else if (
        sellPipsProfit > 40 &&
        sellPipsProfit < 50 &&
        !existsInCache40
      ) {
        await set("EURUSD_sell_40", "oks", expiryTime);

        await closePartial("buy", 200);
      } else if (sellPipsProfit > 50 && !existsInCache50) {
        await set("EURUSD_sell_50", "oks", expiryTime);

        await closePartial("buy", 200);
      } else if (sellPipsProfit > 60 && !existsInCache60) {
        await set("EURUSD_sell_60", "oks", expiryTime);

        await closePartial("buy", 200);
      } else if (sellPipsProfit > 70 && !existsInCache70) {
        await set("EURUSD_sell_70", "oks", expiryTime);

        await closePartial("buy", 200);
      }
    }
  }

  console.log(positions);
  console.log(thePrice);
  const end = performance.now();

  console.log(`Execution time: ${end - start} ms`);
}, 5000);
