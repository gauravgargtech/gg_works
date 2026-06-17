require("./config/config.js");
const { Hono } = require("hono");
const { serve } = require("@hono/node-server");
const path = require("path");
const { createMiddleware } = require("hono/factory");

const { findAndSort, insert, aggregate } = require("./adapters/mongo");
const { sendPushNotif } = require("./config/telegram_notify");
var { get, set, del } = require("./adapters/redis");
const { closeAllBTCPositions, placeOrderBTC } = require("./exhanges/bybit");
const {
  getPositions,
  placeOrder,
  closePositions,
} = require("./exhanges/oanda");

const ejs = require("ejs");
const fs = require("fs");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const app = new Hono();

//app.use(bodyParser.text({ type: "*/*" }));

app.post("/tv-webhook", async (c) => {
  try {
    const incomingBody = await c.req.text();

    console.log("Body:");
    console.log(incomingBody);

    const alertParts = JSON.parse(incomingBody);
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
    if (day === 1 && hour < 10) {
      isWeekend = true;
    }

    if (!alertParts?.signal) {
      throw new Error("Signal not exists in webhook data");
    }
    if (
      alertParts?.symbol &&
      !TRADING_ALLOWED_PAIRS.includes(alertParts?.symbol) &&
      alertParts?.symbol !== "AUDUSD" &&
      alertParts?.symbol !== "USDJPY" &&
      alertParts?.symbol !== "GOLD" &&
      alertParts?.symbol !== "DOGE" &&
      alertParts?.symbol !== "XRP" &&
      alertParts?.symbol !== "POPCAT" &&
      alertParts?.symbol !== "CLOSEALL" &&
      alertParts?.symbol !== "BTC"
    ) {
      /*
      throw new Error(
        `Symbol ${alertParts.symbol} does not exists in webhook data in symbol`,
      );
      */
    }

    if (1 || TRADING_ALLOWED_PAIRS.includes(alertParts?.symbol)) {
      if (isWeekend) {
        throw new Error("Weekend detected, cant place orders !!!");
      }

      const existsInCache = await get(`${alertParts?.symbol}_main_order`);

      if (existsInCache) {
        throw new Error("Signal already exists in cache");
      }
      await set(`${alertParts?.symbol}_main_order`, "oks", 30);

      console.log("Redis key set");

      console.log("--lets check balance");
      //await getBalance();

      const positions = await getPositions(alertParts.symbol);
      console.log("--lets check positions");
      console.log(positions.length);

      if (positions.length > 0) {
        console.log("--lets close positions");
        console.log(positions);
        await closePositions(positions, alertParts.symbol);
      }

      let candleChange = 0;
      if (alertParts?.high && alertParts?.low) {
        candleChange = alertParts.high - alertParts.low;
      }
      const instrumentDetailssss = await get(alertParts.symbol);

      try {
        const mt5Symbolssss = alertParts.symbol.replace("_", "") + ".";

        await set(`mt5:pending_command:${mt5Symbolssss}`, {
          action: "close",
          symbol: mt5Symbol,
        });
      } catch (error) {
        console.error("Error in mt5-command:", error);
        await sendPushNotif(
          `Compressed signaled error as ${alertParts.signal} for ${alertParts.symbol}`,
        );
      }

      if (instrumentDetailssss) {
        const candleChangePips = Math.abs(
          parseFloat(candleChange / instrumentDetailssss.tickSize).toFixed(2),
        );

        if (candleChangePips >= 19) {
          await sendPushNotif(
            `Compressed signaled detected as ${alertParts.signal} for ${alertParts.symbol}`,
          );
          return c.json({
            success: true,
            status: "success",
            message: "Alert received",
            timestamp: new Date().toISOString(),
          });
        }
      }

      const theSymbol = alertParts.symbol;

      await del(`${theSymbol}_limit_orders`);

      const mt5Symbol = theSymbol.replace("_", "") + ".";

      console.log("MT5 symbol:", mt5Symbol);

      if (alertParts.signal === "BUY") {
        await set(`mt5:pending_command:${mt5Symbol}`, {
          action: "replace",
          direction: "buy",
          symbol: mt5Symbol,
        });
        await placeOrder("buy", theSymbol);
      } else if (alertParts.signal === "SELL") {
        await set(`mt5:pending_command:${mt5Symbol}`, {
          action: "replace",
          direction: "sell",
          symbol: mt5Symbol,
        });
        await placeOrder("short", theSymbol);
      }
      try {
        await sendPushNotif(
          `${alertParts.signal} Order placed for ${theSymbol}`,
        );
      } catch (error) {
        console.error("Error sending push notification:", error);
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

    return c.json({
      success: true,
      status: "success",
      message: "Alert received",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error processing webhook:", error);
    await sendPushNotif("Error processing API webhook: " + error.message);
    return c.json(
      {
        success: false,
        error: error.message,
      },
      500,
    );
  }
});

function cmdKey(symbol) {
  return `mt5:pending_command:${symbol}`;
}

app.get("/mt5/command", async (c) => {
  try {
    const symbol = c.req.query("symbol");
    console.log(`MT5 polling for symbol ${symbol}`);

    return c.json({ action: "none" });

    if (!symbol) {
      return c.json({ action: "none" });
    }
    // Avoid excessive console.log every 2 sec
    // console.log("MT5 polling for command");

    const cmd = await get(cmdKey(symbol));

    if (cmd?.action) {
      // Delete immediately so it isn't re-read on the next poll
      await del(cmdKey(symbol));
      return c.json(cmd);
    }

    return c.json({ action: "none" });
  } catch (error) {
    console.error("Error in mt5-command:", error);
    await sendPushNotif("Error in mt5-command: " + error.message);
    return c.json({ action: "none" });
  }
  return c.json({ action: "none" });
});

app.get("/health", (c) => {
  return c.json({
    status: "ok",
  });
});

app.post("/mt5/ack", async (c) => {
  try {
    const body = await c.req.json();
    const symbol = body?.symbol ?? "unknown";

    console.log(`MT5 acknowledged command — symbol: ${symbol}`);
    await del(cmdKey(symbol));

    return c.json({ status: "ok" });
  } catch (error) {
    console.error("Error in mt5-ack:", error);
    await sendPushNotif("Error in mt5-ack: " + error.message);
    return c.json({ status: "ok" });
  }
  return c.json({ status: "ok" });
});

app.post("/algo/signal", async (c) => {
  try {
    const body = await c.req.json();
    const { action, direction, symbol } = body;

    if (!symbol) {
      return c.json({ status: "error", message: "symbol is required" }, 400);
    }

    const command = { action, direction, symbol };
    await set(cmdKey(symbol), command);

    console.log("Command queued:", command);

    return c.json({ status: "queued", command });
  } catch (error) {
    console.error("Error in algo-signal:", error);
    await sendPushNotif("Error in algo-signal: " + error.message);
    return c.json({ status: "queued", command });
  }
  return c.json({ status: "queued", command });
});

app.get("/mt5/status", async (c) => {
  try {
    const pairs = ["AUDUSD.", "EURUSD.", "USDCAD.", "AUDNZD.", "GBPUSD."];
    const status = {};

    for (const sym of pairs) {
      const cmd = await get(cmdKey(sym));
      status[sym] = cmd ?? null;
    }

    return c.json(status);
  } catch (error) {
    console.error("Error in mt5-status:", error);
    await sendPushNotif("Error in mt5-status: " + error.message);
    return c.json(status);
  }
  return c.json(status);
});

app.post("/balance", async (c) => {
  const apiKey = c.req.header("x-api-key");
  if (apiKey !== process.env.POST_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json();
  const { account, balance, equity, currency } = body;

  await insert("account_balance", {
    created_at: dayjs().tz("Australia/Brisbane").format("YYYY-MM-DD HH:mm:ss"),
    account,
    account_type: "wemastertrade",
    balance,
    equity,
    currency,
    timestamp: dayjs().tz("Australia/Brisbane").unix(),
  });

  return c.json({ ok: true });
});

app.get("/lister", async (c) => {
  const data = await findAndSort("push_notif", {}, { _id: -1 }, 100);

  const template = fs.readFileSync("./views/index.ejs", "utf-8");

  const html = ejs.render(template, { data: data });

  return c.html(html);
});

app.get("/fvg_lister", async (c) => {
  const data = await findAndSort("fvg_forex", {}, { candle3_unix: -1 }, 500);

  const template = fs.readFileSync("./views/fvg_forex.ejs", "utf-8");

  const html = ejs.render(template, { data: data });

  return c.html(html);
});

app.get("/fvg_forex", async (c) => {
  const data = await findAndSort("fvg_forex_deep", {}, { unix: -1 }, 500);

  const template = fs.readFileSync("./views/fvg_forex_new.ejs", "utf-8");

  const html = ejs.render(template, { data: data });

  return c.html(html);
});

app.get("/news", async (c) => {
  const data = await aggregate("news_sentiment", [
    // 1. sort newest first for correct grouping
    { $sort: { unix: -1 } },

    // 2. group by coin
    {
      $group: {
        _id: "$currency",
        scores: {
          $push: {
            score: "$score",
            mode: "$direction",
            summary: "$summary",
            ts: "$times",
            unix: "$unix",
          },
        },
      },
    },

    // 3. keep last 4
    {
      $project: {
        symbol: "$_id",
        category: { $literal: "Crypto" },
        scores: { $slice: ["$scores", 4] },
      },
    },

    // 4. compute latest score for sorting
    {
      $addFields: {
        latestScore: { $arrayElemAt: ["$scores.score", 0] },
      },
    },

    // 5. sort by latest score desc
    {
      $sort: { latestScore: -1 },
    },

    // 6. cleanup field
    {
      $project: {
        latestScore: 0,
      },
    },
  ]);

  const template = fs.readFileSync("./views/news.ejs", "utf-8");

  const html = ejs.render(template, { data: data });

  return c.html(html);
});

/*
// MT5 polls this every 2 seconds
app.get("/mt5/command", async (req, res) => {
  console.log("MT5 polling for command");

  const cmd = await get("mt5:pending_command");
  let body;
  if (cmd?.action) {
    await del("mt5:pending_command");
    body = JSON.stringify(cmd);
  } else {
    body = JSON.stringify({ action: "none" });
  }
  console.log("-Generated Body----------------------------------------------");
  console.log(body);

  res.setHeader("Connection", "close");
  res.setHeader("Content-Type", "application/json");
  res.end(body);
});

app.get("/health", (req, res) => {
  return res.json({ status: "ok" });
});

// MT5 calls this after executing a command
app.post("/mt5/ack", async (req, res) => {
  console.log("MT5 acknowledged command — queue cleared");
  await del("mt5:pending_command");
  res.setHeader("Connection", "close");
  return res.json({ status: "ok" });
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


  const command = { action, direction };
  //await set("mt5:pending_command", JSON.stringify(command));

  console.log("Command queued for MT5:", command);
  res.json({ status: "queued", command });
});
*/

serve({
  fetch: app.fetch,
  port: 3000,
});
