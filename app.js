var express = require("express");
var path = require("path");
require("./config/config.js");
var { get, set, del } = require("./adapters/redis");
const bodyParser = require("body-parser");
const { closeAllBTCPositions, placeOrderBTC } = require("./exhanges/bybit");
const { insert, find } = require("./adapters/mongo");
const {
  getPositions,
  placeOrder,
  closePositions,
} = require("./exhanges/oanda");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

var app = express();
app.set("port", 3000);
var http = require("http");

var server = http.createServer(app);

app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");
app.use(bodyParser.text({ type: "*/*" }));

app.post("/tv-webhook", async (req, res) => {
  try {
    console.log("Body:");
    console.log(req.body);

    const alertParts = JSON.parse(req.body);
    console.log(alertParts);
    console.log(`Symbol is - ${alertParts.symbol}`);
    console.log(`Signal is - ${alertParts.signal}`);

    const now = dayjs().tz("Australia/Brisbane");
    const day = now.day(); // 0 Sun - 6 Sat
    const hour = now.hour();

    console.log(`Day is ${day} and hour is ${hour}`);

    let isWeekend = false;
    // Saturday after 4am
    if (day === 6 && hour >= 4) {
      isWeekend = true;
    }

    // Sunday full day
    if (day === 0) {
      isWeekend = true;
    }

    // Monday before 4am
    if (day === 1 && hour < 11) {
      isWeekend = true;
    }
    if (isWeekend) {
      throw new Error("Weekend detected, cant place orders !!!");
    }

    if (!alertParts?.signal) {
      throw new Error("Signal not exists in webhook data");
    }
    if (
      alertParts?.symbol &&
      alertParts?.symbol !== "EURUSD" &&
      alertParts?.symbol !== "USDJPY" &&
      alertParts?.symbol !== "GOLD" &&
      alertParts?.symbol !== "DOGE" &&
      alertParts?.symbol !== "XRP" &&
      alertParts?.symbol !== "POPCAT" &&
      alertParts?.symbol !== "CLOSEALL" &&
      alertParts?.symbol !== "BTC"
    ) {
      throw new Error(
        `Symbol ${alertParts.symbol} does not exists in webhook data in symbol`,
      );
    }

    if (alertParts?.symbol === "EURUSD") {
      const existsInCache = await get("EURUSD");

      if (existsInCache) {
        throw new Error("Signal already exists in cache");
      }
      await set("EURUSD", "oks", 30);

      console.log("Redis key set");

      const alertData = alertParts;

      alertData.receivedAt = new Date();

      try {
        await insert("alerts", alertData);
        console.log("Mongo inserted");
      } catch {
        console.log("Mongo error");
      }

      console.log("--lets check balance");
      //await getBalance();

      const positions = await getPositions();
      console.log("--lets check positions");
      console.log(positions.length);

      if (positions.length > 0) {
        console.log("--lets close positions");
        console.log(positions);
        await closePositions(positions);
      }

      await del("EURUSD_sell_10");
      await del("EURUSD_sell_20");
      await del("EURUSD_sell_30");
      await del("EURUSD_sell_40");
      await del("EURUSD_sell_50");
      await del("EURUSD_sell_60");
      await del("EURUSD_sell_70");
      await del("EURUSD_buy_10");
      await del("EURUSD_buy_20");
      await del("EURUSD_buy_30");
      await del("EURUSD_buy_40");
      await del("EURUSD_buy_50");
      await del("EURUSD_buy_60");
      await del("EURUSD_buy_70");

      if (alertParts.signal === "BUY") {
        await set("mt5:pending_command", {
          action: "replace",
          direction: "buy",
        });
        await placeOrder("buy");
      } else if (alertParts.signal === "SELL") {
        await set("mt5:pending_command", {
          action: "replace",
          direction: "sell",
        });
        await placeOrder("short");
      }
    } else if (alertParts?.symbol === "POPCAT") {
      await closeAllBTCPositions();

      await del("btc_profit_10");
      await del("btc_profit_20");
      await del("btc_profit_30");
      await del("btc_profit_40");
      await del("btc_profit_50");
      await del("btc_profit_orders");

      if (alertParts.signal === "BUY" || alertParts.signal === "SELL") {
        await placeOrderBTC(alertParts.signal);
      } else {
        log("ℹ️  CLOSE signal — no new position opened.");
      }
    } else if (
      alertParts?.symbol === "CLOSEALL" &&
      alertParts.signal === "CLOSEALL"
    ) {
      await closeAllBTCPositions();
    }

    res.status(200).json({
      status: "success",
      message: "Alert received",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
});

// MT5 polls this every 2 seconds
app.get("/mt5/command", async (req, res) => {
  console.log("MT5 polling for command");

  const cmd = await get("mt5:pending_command");

  if (cmd) {
    await del("mt5:pending_command");
    return res.json(cmd);
  }
  res.json({ action: "none" });
});

// MT5 calls this after executing a command
app.post("/mt5/ack", async (req, res) => {
  console.log("MT5 acknowledged command");
  console.log("Request");
  console.log(req);
  console.log(req.body);
  await del("mt5:pending_command");

  return res.json({ status: "ok" });
  console.log("MT5 acknowledged command — queue cleared");
  res.json({ status: "ok" });
});

// Your algo calls this to queue a command
app.post("/algo/signal", async (req, res) => {
  console.log("Algo received signal");
  const { action, direction } = req.body;

  /*
  // Open fresh (no existing positions)
{ action: "open", direction: "buy" }
{ action: "open", direction: "sell" }

// Close existing + open new in one atomic command
{ action: "replace", direction: "buy" }
{ action: "replace", direction: "sell" }

// Close everything, no new trade
{ action: "closeall" }
*/

  const command = { action, direction };
  //await set("mt5:pending_command", JSON.stringify(command));

  console.log("Command queued for MT5:", command);
  res.json({ status: "queued", command });
});

server.listen(3000);
