require("./config/config");
const process = require("process");
const { RestClientV5 } = require("bybit-api");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);
const redis = require("../adapters/redis");

const client = new RestClientV5({
  key: process.env.BYBIT_API_KEY,
  secret: process.env.BYBIT_API_SECRET,
  demoTrading: true,
});

const SYMBOL = process.env.BYBIT_SYMBOL;
const CATEGORY = "linear";

// -----------------------------
// 1. Brisbane weekend detector
// Sat 04:00 → Mon 04:00
// -----------------------------
function isWeekendBrisbane() {
  const now = dayjs().tz("Australia/Brisbane");

  const day = now.day(); // 0 Sun - 6 Sat
  const hour = now.hour();

  // Saturday after 4am
  if (day === 6 && hour >= 4) return true;

  // Sunday full day
  if (day === 0) return true;

  // Monday before 4am
  if (day === 1 && hour < 4) return true;

  return false;
}

// -----------------------------
// 2. Get tick size + step size
// -----------------------------
async function getSymbolPrecision(symbol) {
  const res = await client.getInstrumentsInfo({
    category: CATEGORY,
    symbol,
  });

  const info = res.result.list[0];

  return {
    tickSize: parseFloat(info.priceFilter.tickSize),
    stepSize: parseFloat(info.lotSizeFilter.qtyStep),
  };
}

// -----------------------------
// 3. Get position
// -----------------------------
async function getPosition(symbol) {
  const res = await client.getPositionInfo({
    category: CATEGORY,
    symbol,
  });

  return res.result.list?.[0] || null;
}

// -----------------------------
// 4. Round helpers
// -----------------------------
function roundToTick(price, tick) {
  return Math.round(price / tick) * tick;
}

function roundQty(qty, step) {
  return Math.floor(qty / step) * step;
}

// -----------------------------
// 5. TP generator
// -----------------------------
const profitSteps = [0.005, 0.01, 0.018, 0.024, 0.032, 0.047, 0.6, 0.75, 0.9];

function buildTPs(entryPrice, isLong, mode) {
  const steps =
    mode === "GRID"
      ? [
          0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 0.01,
          0.012, 0.014, 0.016, 0.018, 0.02, 0.022, 0.024, 0.026, 0.028, 0.03,
        ] // tighter in grid mode
      : profitSteps; // full in fixed mode

  return steps.map((pct) => {
    const price = isLong ? entryPrice * (1 + pct) : entryPrice * (1 - pct);

    return { price, pct };
  });
}

// -----------------------------
// 6. Main engine
// -----------------------------
async function runTPEngine() {
  const weekend = isWeekendBrisbane();
  const mode = weekend ? "GRID" : "FIXED";

  const btcProfitOrders = await redis.get("btc_profit_orders");
  if (btcProfitOrders) {
    console.log("📊 BTC Profit orders already exist.");
    return;
  }

  console.log("🕒 Weekend:", weekend);
  console.log("⚙️ Mode:", mode);

  const position = await getPosition(SYMBOL);
  if (!position || parseFloat(position.size) === 0) {
    console.log("No open position");
    return;
  }

  const { tickSize, stepSize } = await getSymbolPrecision(SYMBOL);

  const size = parseFloat(position.size);
  const entry = parseFloat(position.avgPrice);

  const isLong = position.side === "Buy";

  console.log("📊 Position:", { size, entry, isLong });

  const tps = buildTPs(entry, isLong, mode);

  for (let i = 0; i < tps.length; i++) {
    const tp = tps[i];

    const qty =
      mode === "GRID"
        ? parseInt(position.size / 30)
        : parseInt(position.size / 10);

    const price = roundToTick(tp.price, tickSize);

    const side = isLong ? "Sell" : "Buy";

    console.log(`TP${i + 1} | ${mode} | price=${price} qty=${qty}`);

    await client.submitOrder({
      category: CATEGORY,
      symbol: SYMBOL,
      side,
      orderType: "Limit",
      price: price.toString(),
      qty: qty.toString(),
      timeInForce: "PostOnly",
      reduceOnly: true,
    });
  }

  await redis.set("btc_profit_orders", "oks");
}

// -----------------------------
// 7. Run
// -----------------------------
setInterval(async () => {
  runTPEngine().catch(console.error);
}, 5000);
