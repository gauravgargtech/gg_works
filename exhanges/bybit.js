require("../config/config");
const process = require("process");

const LEVERAGE = 3;

const SYMBOL = process.env.BYBIT_SYMBOL;
const { RestClientV5 } = require("bybit-api");

const BYBIT_API_KEY = process.env.BYBIT_API_KEY || "";
const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET || "";
const USE_TESTNET =
  (process.env.BYBIT_TESTNET || "false").toLowerCase() === "true";

const client = new RestClientV5({
  key: BYBIT_API_KEY,
  secret: BYBIT_API_SECRET,
  demoTrading: true,
});

const BYBIT_BASE_URL = "https://api-testnet.bybit.com";
//  : "https://api.bybit.com";

async function getBtcPrice() {
  const res = await client.getTickers({ category: "linear", symbol: SYMBOL });
  const price = parseFloat(res.result.list[0].lastPrice);
  log(`📈 ${SYMBOL} price: $${price.toLocaleString()}`);
  return price;
}

async function getOpenPositions() {
  const res = await client.getPositionInfo({
    category: "linear",
    symbol: SYMBOL,
  });
  return res.result.list.filter((p) => parseFloat(p.size) > 0);
}

async function closePosition(position) {
  const closeSide = position.side === "Buy" ? "Sell" : "Buy";
  log(`🔒 Closing ${position.side} position — size=${position.size} BTC`);

  const res = await client.submitOrder({
    category: "linear",
    symbol: SYMBOL,
    side: closeSide,
    orderType: "Market",
    qty: position.size,
    reduceOnly: true,
    timeInForce: "IOC",
  });

  log(`✅ Position closed — orderId=${res.result.orderId}`);
}

async function closeAllBTCPositions() {
  log("🔍 Checking for open positions...");
  const positions = await getOpenPositions();

  if (positions.length === 0) {
    log("ℹ️  No open positions found.");
    return;
  }

  log(
    `⚠️  Found ${positions.length} open position(s) — closing before new order...`,
  );
  for (const pos of positions) {
    await closePosition(pos);
  }

  // Let exchange settle before placing a new order
  await new Promise((r) => setTimeout(r, 1500));
}

async function setLeverage() {
  log(`⚙️  Setting leverage to ${LEVERAGE}x...`);

  const res = await client.setLeverage({
    category: "linear",
    symbol: SYMBOL,
    buyLeverage: String(LEVERAGE),
    sellLeverage: String(LEVERAGE),
  });

  // retCode 110043 = leverage already set at this value — not an error
  if (res.retCode !== 0 && res.retCode !== 110043) {
    throw new Error(
      `setLeverage failed — retCode=${res.retCode} msg="${res.retMsg}"`,
    );
  }

  log(`✅ Leverage set to ${LEVERAGE}x`);
}

/**
 * placeOrderBTC
 *
 * Full flow:
 *  1. Close any existing positions (+ cancel open TP orders)
 *  2. Set leverage to 3x
 *  3. Fetch live BTC price → calculate qty from TRADE_USD
 *  4. Place market entry order (Buy or Sell)
 *  5. Wait for position to register, fetch actual fill price
 *  6. Place 3 partial TP limit orders (20% / 20% / 30%)
 *  7. Leave remaining 30% for manual execution
 *
 * @param {'BUY'|'SELL'} signal
 */
async function placeOrderBTC(signal) {
  const side = signal === "BUY" ? "Buy" : "Sell";
  const signalLabel = signal === "BUY" ? "LONG" : "SHORT";

  log(`\n${"═".repeat(60)}`);
  log(`📡 Signal : ${signal}  →  Opening ${signalLabel}`);
  log(`🌐 Mode   : ${USE_TESTNET ? "TESTNET" : "MAINNET"}`);
  log(`${"═".repeat(60)}\n`);

  // 2. Set leverage
  await setLeverage();

  // 3. Price + qty
  const entryPrice = await getBtcPrice();

  const currentBalance = (await getBalance()) - 5;
  const rawQty = (currentBalance * LEVERAGE) / entryPrice;
  const qty = parseInt(rawQty.toFixed(3)); // use 0 decimals for XRP if step size = 1

  log(`\n🚀 Placing ${signalLabel} Market Entry`);
  log(`   qty      : ${qty} ${SYMBOL}`);
  log(`   notional : ~$${currentBalance} USD`);
  log(`   leverage : ${LEVERAGE}x`);

  // 4. Entry market order
  const orderRes = await client.submitOrder({
    category: "linear",
    symbol: SYMBOL,
    side,
    orderType: "Market",
    qty: qty.toString(),
    timeInForce: "GTC",
  });

  console.log(
    "----------------------orderRes---------------------------------------",
  );
  console.log(orderRes);
  const entryOrderId = orderRes.result.orderId;
  log(`✅ Entry order placed — orderId=${entryOrderId}`);

  // 5. Wait for position to register, then fetch actual fill data
  await new Promise((r) => setTimeout(r, 2000));

  let actualQty = qty;
  let actualEntry = entryPrice;

  try {
    const positions = await getOpenPositions();
    const pos = positions.find((p) => p.symbol === SYMBOL);
    if (pos) {
      actualQty = pos.size;
      actualEntry = parseFloat(pos.avgPrice);
      log(
        `📊 Confirmed fill — avgEntry=$${actualEntry.toLocaleString()} | size=${actualQty} BTC`,
      );
    }
  } catch {
    log("⚠️  Could not confirm fill — using estimate for TP prices.");
  }

  // Summary
  log(`${"═".repeat(60)}`);
  log(`🏁 Done! Full order summary:`);
  log(`   Direction     : ${signalLabel}`);
  log(`   Entry price   : $${actualEntry.toLocaleString()}`);
  log(`   Position size : ${actualQty} BTC`);
  log(`   Entry orderId : ${entryOrderId}`);

  return { entryOrderId };
}

function log(level, msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const emoji = level === "ERROR" ? "❌" : level === "WARN" ? "⚠️ " : "ℹ️ ";
  console.log(`[${ts}] [${level}] ${emoji} ${msg}`);
}

async function getBalance() {
  try {
    const response = await client.getWalletBalance({
      accountType: "UNIFIED", // or 'CONTRACT', 'SPOT'
    });

    console.log(JSON.stringify(response, null, 2));

    const coins = response.result.list[0].coin;

    coins.forEach((c) => {
      console.log(`Coin: ${c.coin}`);
      console.log(`Wallet Balance: ${c.walletBalance}`);
      console.log(`Available Balance: ${c.availableToWithdraw}`);
      console.log("---");
    });
    return coins[0].walletBalance;
  } catch (err) {
    console.error(err);
  }
}

module.exports = {
  closeAllBTCPositions,
  placeOrderBTC,
  getBtcPrice,
};
