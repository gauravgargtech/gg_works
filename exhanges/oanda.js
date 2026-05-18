require("../config/config");
const process = require("process");
const https = require("https");

const API_KEY = process.env.OANDA_API_KEY;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;

const PRACTICE = process?.env?.OANDA_IS_SANDBOX === "true" ? true : false;
const BASE_URL = PRACTICE
  ? "api-fxpractice.oanda.com"
  : "api-fxtrade.oanda.com";

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 5,
  freeSocketTimeout: 30000,
});
const pLimit = require("p-limit").default;
const limit = pLimit(5); // max 5 concurrent requests

const INSTRUMENT = process.env.OANDA_SYMBOL;

function request(...args) {
  return limit(() => requests(...args));
}

function requests(method, path, body = null) {
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
      agent,
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

/** Fetch and display account summary */
async function getBalance() {
  console.log(
    `\n📊 Fetching account balance (${PRACTICE ? "PRACTICE" : "LIVE"})...\n`,
  );

  const data = await request("GET", `/v3/accounts/${ACCOUNT_ID}/summary`);

  const acc = data.account;
  console.log("━".repeat(40));
  console.log(`  Account ID  : ${acc.id}`);
  console.log(`  Currency    : ${acc.currency}`);
  console.log(
    `  Balance     : ${parseFloat(acc.balance).toFixed(2)} ${acc.currency}`,
  );
  console.log(
    `  NAV         : ${parseFloat(acc.NAV).toFixed(2)} ${acc.currency}`,
  );
  console.log(
    `  Unrealized  : ${parseFloat(acc.unrealizedPL).toFixed(2)} ${acc.currency}`,
  );
  console.log(`  Open Trades : ${acc.openTradeCount}`);
  console.log(
    `  Margin Used : ${parseFloat(acc.marginUsed).toFixed(2)} ${acc.currency}`,
  );
  console.log(
    `  Margin Avail: ${parseFloat(acc.marginAvailable).toFixed(2)} ${acc.currency}`,
  );
  console.log("━".repeat(40));

  return acc;
}

/** Place a market order
 * @param {"buy"|"short"} direction
 */
async function placeOrder(direction, instrument = INSTRUMENT) {
  const units = direction === "buy" ? LOT_SIZE : -LOT_SIZE;
  const label = direction === "buy" ? "BUY (Long) 📈" : "SHORT (Sell) 📉";

  console.log(`\n🚀 Placing ${label} order for ${instrument}...`);
  console.log(`   Units    : ${units} (0.01 lot)`);
  console.log(`   Mode     : ${PRACTICE ? "PRACTICE" : "LIVE"}\n`);

  const body = {
    order: {
      type: "MARKET",
      instrument: instrument,
      units: units.toString(),
      timeInForce: "FOK", // Fill Or Kill
      positionFill: "DEFAULT",
    },
  };

  const data = await request("POST", `/v3/accounts/${ACCOUNT_ID}/orders`, body);

  if (data.orderFillTransaction) {
    const tx = data.orderFillTransaction;
    console.log("✅ Order filled successfully!");
    console.log("━".repeat(40));
    console.log(`  Trade ID    : ${tx.tradeOpened?.tradeID || "N/A"}`);
    console.log(`  Instrument  : ${tx.instrument}`);
    console.log(`  Units       : ${tx.units}`);
    console.log(`  Price       : ${tx.price}`);
    console.log(`  Time        : ${tx.time}`);
    console.log("━".repeat(40));
  } else if (data.orderCancelTransaction) {
    const tx = data.orderCancelTransaction;
    console.log("❌ Order was cancelled.");
    console.log(`   Reason: ${tx.reason}`);
  } else {
    console.log("⚠️  Unexpected response:", JSON.stringify(data, null, 2));
  }

  return data;
}

/** List open EUR/USD positions */
async function getPositions(theInstrument = INSTRUMENT) {
  console.log(`\n📋 Fetching open positions...\n`);

  try {
    const data = await request(
      "GET",
      `/v3/accounts/${ACCOUNT_ID}/positions/${theInstrument}`,
    );

    const pos = data.position;
    if (!pos) {
      console.log("No position data returned.");
      return [];
    }

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
      return [longUnits, shortUnits];
    }
  } catch (error) {
    console.log("Error fetching position data:", error.message);
    return [];
  }
  return [];
}

/** Close all open EUR/USD positions */
async function closePositions(positions, instrument = INSTRUMENT) {
  console.log(`\n🔒 Closing all ${instrument} positions...\n`);

  const poss = {};
  if (positions[0] != 0) {
    poss.longUnits = "ALL";
  }
  if (positions[1] != 0) {
    poss.shortUnits = "ALL";
  }
  const data = await request(
    "PUT",
    `/v3/accounts/${ACCOUNT_ID}/positions/${instrument}/close`,
    poss,
  );

  console.log(data);

  const closed = [
    data?.longOrderFillTransaction ?? 0,
    data?.shortOrderFillTransaction ?? 0,
  ].filter(Boolean);

  if (closed.length === 0) {
    console.log("ℹ️  No positions to close (or already flat).");
    return;
  }

  for (const tx of closed) {
    console.log(`✅ Closed: ${tx.units} units @ ${tx.price}`);
    console.log(`   P&L: ${tx.pl} ${tx.accountCurrency || ""}`);
  }
}

async function getInstruments() {
  console.log(`\n📋 Fetching instruments details...\n`);

  try {
    const data = await request("GET", `/v3/accounts/${ACCOUNT_ID}/instruments`);
    return data?.instruments ?? [];
  } catch (error) {
    console.log("Error fetching position data:", error.message);
    return [];
  }
  return [];
}

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds));

function log(level, msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const emoji = level === "ERROR" ? "❌" : level === "WARN" ? "⚠️ " : "ℹ️ ";
  console.log(`[${ts}] [${level}] ${emoji} ${msg}`);
}

async function fetchCandles(instrument, timeframe = "M15", candleCount = 300) {
  try {
    const params = new URLSearchParams({
      granularity: timeframe,
      count: candleCount,
      price: "M",
    });

    console.log(`\n📋 Fetching ${candleCount} ${timeframe} candles...\n`);

    const data = await request(
      "GET",
      `/v3/instruments/${instrument}/candles?${params.toString()}`,
    );

    const candles = data?.candles ?? [];
    if (candles.length === 0) {
      throw new Error("Oanda returned empty candles array");
    }
    const complete = data.candles.filter((c) => c.complete);

    return complete.map((c) => ({
      time: c.time,
      open: parseFloat(c.mid.o),
      high: parseFloat(c.mid.h),
      low: parseFloat(c.mid.l),
      close: parseFloat(c.mid.c),
    }));
  } catch (error) {
    console.log("Error fetching position data:", error.message);
    return [];
  }
}

async function getPositionsForProfits(instrument = INSTRUMENT) {
  console.log(`\n📋 Fetching open positions...\n`);

  try {
    const data = await request(
      "GET",
      `/v3/accounts/${ACCOUNT_ID}/positions/${instrument}`,
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
      console.log(`No open positions for ${pos.instrument}`);
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
    console.error(
      `Error fetching position data for ${instrument}`,
      error.message,
    );
    return [];
  }
  return [];
}

async function getPrice(instrument = INSTRUMENT) {
  try {
    const params = new URLSearchParams({
      instruments: instrument,
    });

    const res = await request(
      "GET",
      `/v3/accounts/${ACCOUNT_ID}/pricing?${params.toString()}`,
    );

    const price = res.prices[0];

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

async function closePartial(sideType, units, instrument = INSTRUMENT) {
  try {
    const body = {};

    if (sideType === "sell") {
      body.longUnits = units.toString();
    } else {
      body.shortUnits = units.toString();
    }

    const res = await request(
      "PUT",
      `/v3/accounts/${ACCOUNT_ID}/positions/${instrument}/close`,
      body,
    );

    console.log(body);

    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error(err.response?.data || err.message);
  }
}

function getPipSize(instrument) {
  // Normalise: "EUR-USD" → "EUR_USD"
  const size = PIP_SIZE[instrument];
  if (!size)
    throw new Error(`Unknown instrument: ${instrument}. Add it to PIP_SIZE.`);
  return size;
}

function calcTakeProfitPrices(entryPrice, direction, pipSize) {
  return TP_PIPS.map((pips) => {
    const offset = pips * pipSize;
    const price =
      direction === "LONG"
        ? entryPrice + offset // profit above entry for longs
        : entryPrice - offset; // profit below entry for shorts
    // Round to instrument precision (5 dp for most pairs, 3 for JPY)
    const decimals = pipSize < 0.001 ? 5 : 3;
    return { pips, price: parseFloat(parseFloat(price).toFixed(decimals)) };
  });
}

async function cancelAllPendingLimitOrders(instrument) {
  const data = await request(
    "GET",
    `/v3/accounts/${ACCOUNT_ID}/orders?instrument=${instrument}&state=PENDING`,
  );

  const orders = data.orders ?? [];
  console.log(`Found ${orders.length} pending orders for ${instrument}`);

  for (const order of orders) {
    await request(
      "PUT",
      `/v3/accounts/${ACCOUNT_ID}/orders/${order.id}/cancel`,
    );
    console.log(`  Cancelled order ${order.id}`);
    await sleep(200);
  }
}

async function placeLimitOrder(instrument, direction, units, limitPrice) {
  // For a take-profit on a LONG  → we SELL  when price reaches the TP
  // For a take-profit on a SHORT → we BUY   when price reaches the TP
  const orderUnits =
    direction === "LONG"
      ? -Math.abs(units) // negative = sell
      : Math.abs(units); // positive = buy

  const body = {
    order: {
      type: "LIMIT",
      instrument: instrument,
      units: String(orderUnits),
      price: String(limitPrice),
      timeInForce: "GTC", // Good Till Cancelled
      positionFill: "REDUCE_ONLY", // only fills against an open position
    },
  };

  const data = await request("POST", `/v3/accounts/${ACCOUNT_ID}/orders`, body);

  console.log(data);

  return data.orderCreateTransaction?.id ?? data.relatedTransactionIDs?.[0];
}

async function placeTakeProfitOrders(
  instrument,
  direction,
  entryPrice,
  pipSize,
) {
  await cancelAllPendingLimitOrders(instrument);
  const dir = direction.toUpperCase();
  if (!["LONG", "SHORT"].includes(dir)) {
    throw new Error('direction must be "LONG" or "SHORT"');
  }

  // Use provided entry price or fetch live
  let entry = entryPrice;
  if (!entry) {
    const { bid, ask } = await getPrice(instrument);
    // For a LONG  entry the fill will be near the ASK
    // For a SHORT entry the fill will be near the BID
    entry = dir === "LONG" ? ask : bid;
    console.log(`Live price → bid: ${bid}  ask: ${ask}  using: ${entry}`);
  }

  console.log(
    `\nPlacing TP orders for ${instrument.toUpperCase()} | ${dir} | entry ≈ ${entry}`,
  );
  console.log(`Pip size: ${pipSize} | Units per level: ${LOT_SIZE}\n`);

  const levels = calcTakeProfitPrices(entry, dir, pipSize);
  const results = [];

  for (const { pips, price } of levels) {
    try {
      const orderId = await placeLimitOrder(instrument, dir, 100, price);
      await sleep(500);
      console.log(
        `  ✅  +${pips} pips → TP @ ${price}  (order ID: ${orderId})`,
      );
      results.push({ pips, price, orderId, status: "placed" });
    } catch (err) {
      console.error(
        `  ❌  +${pips} pips → TP @ ${price}  FAILED: ${err.message}`,
      );
      results.push({
        pips,
        price,
        orderId: null,
        status: "failed",
        error: err.message,
      });
    }
  }

  console.log("\nSummary:", results);
  return results;
}

module.exports = {
  getPositions,
  placeOrder,
  closePositions,
  log,
  getInstruments,
  fetchCandles,
  request,
  getPositionsForProfits,
  getPrice,
  closePartial,
  placeTakeProfitOrders,
};
