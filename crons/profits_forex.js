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
  placeTakeProfitOrders,
} = require("../exhanges/oanda");

const { performance } = require("perf_hooks");

const INSTRUMENT = process.env.OANDA_SYMBOL;

const expiryTime = 864000;

function calculatePips(entry, exit, type = "buy", pipSize = 0.01) {
  if (type === "buy") {
    return (exit - entry) / pipSize;
  } else {
    return (entry - exit) / pipSize;
  }
}
const runProfit = async (instrument = INSTRUMENT) => {
  try {
    const isLimitOrdersSetInRedis = await get(`${instrument}_limit_orders`);

    if (isLimitOrdersSetInRedis) {
      console.log(`Limit orders already exist for ${instrument}.`);
      return;
    }

    const positions = await getPositionsForProfits(instrument);

    if (positions.length === 0) {
      console.log(`No positions found for ${instrument}.`);
      return;
    }

    const entryPrice = positions.price_avg;
    const direction = positions.side === "Buy" ? "LONG" : "SHORT";

    const instrumentDetailss = await get(instrument);

    await placeTakeProfitOrders(
      instrument,
      direction,
      entryPrice,
      instrumentDetailss.tickSize,
    );

    await set(`${instrument}_limit_orders`, 1);

    return;

    const priceFromAPI = await getPrice(instrument);
    thePrice = parseFloat(priceFromAPI.bid);

    const instrumentDetails = await get(instrument);
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
        const existsInCache10 = await get(`${instrument}_buy_10`);
        const existsInCache20 = await get(`${instrument}_buy_20`);
        const existsInCache30 = await get(`${instrument}_buy_30`);
        const existsInCache40 = await get(`${instrument}_buy_40`);
        const existsInCache50 = await get(`${instrument}_buy_50`);
        const existsInCache60 = await get(`${instrument}_buy_60`);
        const existsInCache70 = await get(`${instrument}_buy_70`);

        if (buyPipsProfit > 10 && buyPipsProfit < 20 && !existsInCache10) {
          await set(`${instrument}_buy_10`, "oks", expiryTime);

          await closePartial("sell", 100, instrument);
        } else if (
          buyPipsProfit > 20 &&
          buyPipsProfit < 30 &&
          !existsInCache20
        ) {
          await set(`${instrument}_buy_20`, "oks", expiryTime);

          await closePartial("sell", 100, instrument);
        } else if (
          buyPipsProfit > 30 &&
          buyPipsProfit < 40 &&
          !existsInCache30
        ) {
          await set(`${instrument}_buy_30`, "oks", expiryTime);

          await closePartial("sell", 100, instrument);
        } else if (
          buyPipsProfit > 40 &&
          buyPipsProfit < 50 &&
          !existsInCache40
        ) {
          await set(`${instrument}_buy_40`, "oks", expiryTime);

          await closePartial("sell", 100, instrument);
        } else if (buyPipsProfit > 50 && !existsInCache50) {
          await set(`${instrument}_buy_50`, "oks", expiryTime);

          await closePartial("sell", 100, instrument);
        } else if (buyPipsProfit > 60 && !existsInCache60) {
          await set(`${instrument}_buy_60`, "oks", expiryTime);

          //await closePartial("sell", 100, instrument);
        } else if (buyPipsProfit > 70 && !existsInCache70) {
          await set(`${instrument}_buy_70`, "oks", expiryTime);

          //await closePartial("sell", 100, instrument);
        }
      } else if (positions.side === "Sell") {
        const existsInCache10 = await get(`${instrument}_sell_10`);
        const existsInCache20 = await get(`${instrument}_sell_20`);
        const existsInCache30 = await get(`${instrument}_sell_30`);
        const existsInCache40 = await get(`${instrument}_sell_40`);
        const existsInCache50 = await get(`${instrument}_sell_50`);
        const existsInCache60 = await get(`${instrument}_sell_60`);
        const existsInCache70 = await get(`${instrument}_sell_70`);

        if (sellPipsProfit > 10 && sellPipsProfit < 20 && !existsInCache10) {
          await set(`${instrument}_sell_10`, "oks", expiryTime);

          await closePartial("buy", 100, instrument);
        } else if (
          sellPipsProfit > 20 &&
          sellPipsProfit < 30 &&
          !existsInCache20
        ) {
          await set(`${instrument}_sell_20`, "oks", expiryTime);

          await closePartial("buy", 100, instrument);
        } else if (
          sellPipsProfit > 30 &&
          sellPipsProfit < 40 &&
          !existsInCache30
        ) {
          await set(`${instrument}_sell_30`, "oks", expiryTime);

          await closePartial("buy", 100, instrument);
        } else if (
          sellPipsProfit > 40 &&
          sellPipsProfit < 50 &&
          !existsInCache40
        ) {
          await set(`${instrument}_sell_40`, "oks", expiryTime);

          await closePartial("buy", 100, instrument);
        } else if (sellPipsProfit > 50 && !existsInCache50) {
          await set(`${instrument}_sell_50`, "oks", expiryTime);

          await closePartial("buy", 100, instrument);
        } else if (sellPipsProfit > 60 && !existsInCache60) {
          await set(`${instrument}_sell_60`, "oks", expiryTime);

          //await closePartial("buy", 100, instrument);
        } else if (sellPipsProfit > 70 && !existsInCache70) {
          await set(`${instrument}_sell_70`, "oks", expiryTime);

          //await closePartial("buy", 100, instrument);
        }
      }
    }

    console.log(positions);
    console.log(thePrice);
  } catch (e) {
    console.error("Error in Oanda Forex Profit Cron");
    console.log(e);
  }
};

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const placeForexTPOrders = async () => {
  try {
    for (const pair of TRADING_ALLOWED_PAIRS_WEBMASTER) {
      await runProfit(pair);
      await sleep(1);
    }
  } catch (e) {
    console.error("Error in Oanda Forex Profit Cron");
    console.log(e);
  }
};

module.exports = placeForexTPOrders;
