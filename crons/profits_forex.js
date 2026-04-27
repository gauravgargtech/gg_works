require("../config/config");
const https = require("https");
const process = require("process");
const axios = require("axios");
var redis = require("../adapters/redis");

const API_KEY = process.env.OANDA_API_KEY;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const PRACTICE = true;
const BASE_URL = PRACTICE
  ? "api-fxpractice.oanda.com"
  : "api-fxtrade.oanda.com";

const INSTRUMENT = process.env.OANDA_SYMBOL;
const LOT_SIZE = 1500; // 0.01 lot = 1000 units in Forex

const expiryTime = 864000;

function calculatePips(entry, exit, type = "buy") {
  const pipSize = 0.0001;

  if (type === "buy") {
    return (exit - entry) / pipSize;
  } else {
    return (entry - exit) / pipSize;
  }
}
setInterval(async () => {
  const thePrice = await getPrice();
  const positions = await getPositions();

  const buyPipsProfit = calculatePips(positions.price_avg, thePrice.bid, "buy");
  const sellPipsProfit = calculatePips(
    positions.price_avg,
    thePrice.bid,
    "sell",
  );

  if (positions && positions?.side) {
    if (positions.side === "Buy") {
      const existsInCache10 = await redis.get("EURUSD_buy_10");
      const existsInCache20 = await redis.get("EURUSD_buy_20");
      const existsInCache30 = await redis.get("EURUSD_buy_30");
      const existsInCache40 = await redis.get("EURUSD_buy_40");
      const existsInCache50 = await redis.get("EURUSD_buy_50");
      if (buyPipsProfit > 10 && buyPipsProfit < 20 && !existsInCache10) {
        await redis.set("EURUSD_buy_10", "oks", "EX", expiryTime);

        await closePartial("sell", 200);
      } else if (buyPipsProfit > 20 && buyPipsProfit < 30 && !existsInCache20) {
        await redis.set("EURUSD_buy_20", "oks", "EX", expiryTime);

        await closePartial("sell", 200);
      } else if (buyPipsProfit > 30 && buyPipsProfit < 40 && !existsInCache30) {
        await redis.set("EURUSD_buy_30", "oks", "EX", expiryTime);

        await closePartial("sell", 200);
      } else if (buyPipsProfit > 40 && buyPipsProfit < 50 && !existsInCache40) {
        await redis.set("EURUSD_buy_40", "oks", "EX", expiryTime);

        await closePartial("sell", 200);
      } else if (buyPipsProfit > 50 && !existsInCache50) {
        await redis.set("EURUSD_buy_50", "oks", "EX", expiryTime);

        await closePartial("sell", 200);
      }
    } else if (positions.side === "Sell") {
      const existsInCache10 = await redis.get("EURUSD_sell_10");
      const existsInCache20 = await redis.get("EURUSD_sell_20");
      const existsInCache30 = await redis.get("EURUSD_sell_30");
      const existsInCache40 = await redis.get("EURUSD_sell_40");
      const existsInCache50 = await redis.get("EURUSD_sell_50");
      if (sellPipsProfit > 10 && sellPipsProfit < 20 && !existsInCache10) {
        await redis.set("EURUSD_sell_10", "oks", "EX", expiryTime);

        await closePartial("buy", 200);
      } else if (
        sellPipsProfit > 20 &&
        sellPipsProfit < 30 &&
        !existsInCache20
      ) {
        await redis.set("EURUSD_sell_20", "oks", "EX", expiryTime);

        await closePartial("buy", 200);
      } else if (
        sellPipsProfit > 30 &&
        sellPipsProfit < 40 &&
        !existsInCache30
      ) {
        await redis.set("EURUSD_sell_30", "oks", "EX", expiryTime);

        await closePartial("buy", 200);
      } else if (
        sellPipsProfit > 40 &&
        sellPipsProfit < 50 &&
        !existsInCache40
      ) {
        await redis.set("EURUSD_sell_40", "oks", "EX", expiryTime);

        await closePartial("buy", 200);
      } else if (sellPipsProfit > 50 && !existsInCache50) {
        await redis.set("EURUSD_sell_50", "oks", "EX", expiryTime);

        await closePartial("buy", 200);
      }
    }
  }

  console.log(positions);
  console.log(thePrice);
}, 5000);

async function getPrice() {
  try {
    const res = await axios.get(
      `https://api-fxpractice.oanda.com/v3/accounts/${ACCOUNT_ID}/pricing`,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
        },
        params: {
          instruments: INSTRUMENT,
        },
      },
    );

    const price = res.data.prices[0];

    console.log("Bid:", price.bids[0].price);
    console.log("Ask:", price.asks[0].price);
    console.log("Time:", price.time);
    return {
      bid: price.bids[0].price,
      ask: price.asks[0].price,
      time: price.time,
    };
  } catch (err) {
    console.error(err.response?.data || err.message);
  }
}

async function closePartial(sideType, units) {
  try {
    const reqObj = {};

    if (sideType === "sell") {
      reqObj.longUnits = units.toString();
    } else {
      reqObj.shortUnits = units.toString();
    }
    console.log(reqObj);
    const res = await axios.put(
      `https://api-fxpractice.oanda.com/v3/accounts/${ACCOUNT_ID}/positions/${INSTRUMENT}/close`,
      reqObj,
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );

    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error(err.response?.data || err.message);
  }
}

async function getPositions() {
  console.log(`\n📋 Fetching open positions...\n`);

  try {
    const data = await request(
      "GET",
      `/v3/accounts/${ACCOUNT_ID}/positions/${INSTRUMENT}`,
    );

    const pos = data.position;
    if (!pos) {
      console.log("No position data returned.");
      return [];
    }

    console.log(pos);
    const longUnits = parseFloat(pos.long.units);
    const shortUnits = parseFloat(pos.short.units);

    console.log("━".repeat(40));
    console.log(`  Instrument  : ${pos.instrument}`);

    if (longUnits !== 0) {
      console.log(`  Long Units  : ${longUnits}`);
      console.log(`  Long P&L    : ${pos.long.unrealizedPL}`);
      console.log(`  Avg Price   : ${pos.long.averagePrice}`);
    }
    if (shortUnits !== 0) {
      console.log(`  Short Units : ${shortUnits}`);
      console.log(`  Short P&L   : ${pos.short.unrealizedPL}`);
      console.log(`  Avg Price   : ${pos.short.averagePrice}`);
    }
    if (longUnits === 0 && shortUnits === 0) {
      console.log("  No open positions for EUR/USD.");
    }

    console.log(`  Total P&L   : ${pos.unrealizedPL}`);
    console.log("━".repeat(40));

    if (longUnits !== 0 || shortUnits !== 0) {
      return {
        side: longUnits > 0 ? "Buy" : "Sell",
        size: Math.abs(longUnits + shortUnits),
        price_avg:
          longUnits > 0 ? pos.long.averagePrice : pos.short.averagePrice,
      };
    }
  } catch (error) {
    console.log("Error fetching position data:", error.message);
    return [];
  }
  return [];
}

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    if (!API_KEY || !ACCOUNT_ID) {
      reject(
        new Error(
          "Missing OANDA_API_KEY or OANDA_ACCOUNT_ID in .env file.\n" +
            "Copy .env.example to .env and fill in your credentials.",
        ),
      );
      return;
    }

    const options = {
      hostname: BASE_URL,
      path,
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${parsed.errorMessage || JSON.stringify(parsed)}`,
              ),
            );
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on("error", reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}
