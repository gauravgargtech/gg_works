require("./config/config.js");
const { Hono } = require("hono");
const { serve } = require("@hono/node-server");
const path = require("path");
const { createMiddleware } = require("hono/factory");

const { findAndSort, insert, aggregate, find } = require("./adapters/mongo");
const { sendPushNotif } = require("./config/telegram_notify");
var { get, set, del } = require("./adapters/redis");
const { closeAllBTCPositions, placeOrderBTC } = require("./exhanges/bybit");
const {
  getPositions,
  placeOrder,
  closePositions,
  getPrice,
} = require("./exhanges/oanda");

const ejs = require("ejs");
const fs = require("fs");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const app = new Hono();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

//app.use(bodyParser.text({ type: "*/*" }));

function cmdKey(symbol) {
  return `mt5:pending_command:${symbol}`;
}

app.get("/api/mt5/signals", async (c) => {
  try {
    const key = c.req.header("x-api-key");
    console.log("Received key:", key);
    let signals;

    const isMt5Sent = await get("forex_signals_webtrade_mt5");

    if (isMt5Sent) {
      signals = JSON.parse(isMt5Sent);
    } else {
      signals = [];
      for (const s of FOREX_PAIRS) {
        if (s.toLowerCase() === "gold") {
          continue; // Skip GOLD
        }
        signals.push({
          symbol: s.replace("_", "") + ".",
          action: "NONE",
          lots: 0,
          sl: 0,
          tp: 0,
        });
      }
    }

    console.log("Signals to send in app:", signals);

    const resp = {
      signals: signals,
      serverTime: Date.now(),
    };

    return c.json(resp);
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

app.get("/bos", async (c) => {
  const data = await findAndSort("bos_forex", {}, { unix: -1 }, 500);

  const template = fs.readFileSync("./views/bos.ejs", "utf-8");

  console.log(data[0]);

  const html = ejs.render(template, { data: data });

  return c.html(html);
});

app.get("/swings", async (c) => {
  const data = {};
  for (const coin of FOREX_PAIRS) {
    await sleep(100);
    const price = await getPrice(coin);
    const highs = Object.values(
      JSON.parse((await get(`swing_high_${coin}`)) || "{}"),
    );

    const lows = Object.values(
      JSON.parse((await get(`swing_low_${coin}`)) || "{}"),
    );

    data[coin] = {
      currentPrice: price.ask,
      swings: [...highs, ...lows],
    };
  }

  const template = fs.readFileSync("./views/swings.ejs", "utf-8");

  const html = ejs.render(template, { data: JSON.stringify(data) });

  return c.html(html);
});

app.get("/currency", async (c) => {
  const data = await findAndSort(
    "currency_strength_snapshots",
    {},
    { _id: -1 },
    1,
  );

  const trends = await findAndSort("currency_trend", {}, { deltaScore: -1 });

  const historicalData = await findAndSort(
    "currency_strength_snapshots",
    {},
    { _id: 1 },
    20,
  );

  const historicalScores = {};
  for (const his of historicalData) {
    const scores = his.scores;

    for (const score of scores) {
      if (historicalScores[score.currency]) {
        historicalScores[score.currency].push(score.compositeScore);
      } else {
        historicalScores[score.currency] = [score.compositeScore];
      }
    }
  }

  const lastData = data[data.length - 1];

  const template = fs.readFileSync("./views/currency.ejs", "utf-8");

  const currencies = [];
  const allScores = data[0].scores;
  for (const curr of allScores) {
    currencies.push({
      currency: curr.currency,
      rank: curr.rank,
      compositeScore: curr.compositeScore,
      technicalScore: curr.technicalScore,
      fundamentalScore: curr.fundamentalScore,
      sentimentScore: curr.sentimentScore,
      history: historicalScores[curr.currency],
      change: (
        curr.compositeScore - historicalScores[curr.currency].reverse()[0]
      ).toFixed(4),
      reasoning: data[0].raw.sentimentDetail[curr.currency].reasoning,
      sentiment: data[0].raw.sentimentDetail[curr.currency].sentiment,
    });
  }

  const html = ejs.render(template, {
    meta: {
      technicalUpdatedAt: dayjs()
        .tz("Australia/Brisbane")
        .format("YYYY-MM-DD HH:mm:ss"), // last technical-only run
      fullPipelineUpdatedAt: dayjs()
        .tz("Australia/Brisbane")
        .format("YYYY-MM-DD HH:mm:ss"), // last full run (fundamental + sentiment)
    },
    sorted: [...currencies].sort((a, b) => a.rank - b.rank),
    maxAbs: Math.max(
      1e-6,
      ...currencies.map((c) => Math.abs(c.compositeScore || 0)),
    ),
    trends: trends,
    deriveChange: function (c) {
      if (typeof c.change === "number") return c.change;
      const h = c.history || [];
      if (h.length >= 2) return h[h.length - 1] - h[h.length - 2];
      return 0;
    },
    sparklinePoints: function (history, w, h) {
      const vals = history && history.length >= 2 ? history : [0, 0];
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const range = max - min || 1;
      const step = w / (vals.length - 1);
      return vals
        .map((v, i) => {
          const x = (i * step).toFixed(2);
          const y = (h - ((v - min) / range) * h).toFixed(2);
          return `${x},${y}`;
        })
        .join(" ");
    },
    fmt: function (n) {
      if (typeof n !== "number" || isNaN(n)) return "—";
      const sign = n > 0 ? "+" : "";
      return sign + n.toFixed(2);
    },
    timeAgo: function (ts) {
      if (!ts) return "—";
      const diffMs = Date.now() - new Date(ts).getTime();
      const mins = Math.round(diffMs / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.round(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      return `${Math.round(hrs / 24)}d ago`;
    },
  });

  return c.html(html);
});

app.get("/news", async (c) => {
  const data = await aggregate("news_sentiment", [
    // 1. sort newest first for correct grouping
    { $sort: { score: -1 } },

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

app.get("daily", async (c) => {
  const data = await findAndSort("vortex_forex_daily", {}, { _id: -1 }, 500);

  const template = fs.readFileSync("./views/daily.ejs", "utf-8");

  const html = ejs.render(template, { data: data, dayjs: dayjs });

  return c.html(html);
});

app.get("hourly", async (c) => {
  const data = await findAndSort("vortex_forex_hourly", {}, { _id: -1 }, 500);

  const template = fs.readFileSync("./views/hourly.ejs", "utf-8");

  const html = ejs.render(template, { data: data, dayjs: dayjs });

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
