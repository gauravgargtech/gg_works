require("../config/config");
const process = require("process");

const LEVERAGE = 3;

const { RestClientV5 } = require("bybit-api");

const BYBIT_API_KEY = process.env.BYBIT_API_KEY || "";
const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET || "";
const USE_TESTNET =
  (process.env.BYBIT_TESTNET || "false").toLowerCase() === "true";

const client = new RestClientV5({
  key: BYBIT_API_KEY,
  secret: BYBIT_API_SECRET,
  demoTrading: false,
});

const BYBIT_BASE_URL = "https://api.bybit.com";
//"https://api-testnet.bybit.com";

async function getBtcPrice(symbol) {
  const res = await client.getTickers({ category: "linear", symbol: symbol });
  const price = parseFloat(res.result.list[0].lastPrice);
  log(`📈 ${symbol} price: $${price.toLocaleString()}`);
  return price;
}

async function getOpenPositions(symbol) {
  const res = await client.getPositionInfo({
    category: "linear",
    symbol: symbol,
  });

  return res.result.list.filter((p) => parseFloat(p.size) > 0);
}

async function closePosition(position, symbol) {
  const closeSide = position.side === "Buy" ? "Sell" : "Buy";
  log(`🔒 Closing ${position.side} position — size=${position.size} BTC`);

  const res = await client.submitOrder({
    category: "linear",
    symbol: symbol,
    side: closeSide,
    orderType: "Market",
    qty: position.size,
    reduceOnly: true,
    timeInForce: "IOC",
  });

  log(`✅ Position closed — orderId=${res.result.orderId}`);
}

async function closeAllBTCPositions(symbol) {
  log("🔍 Checking for open positions...");
  const positions = await getOpenPositions(symbol);

  if (positions.length === 0) {
    log("ℹ️  No open positions found.");
    return;
  }

  log(
    `⚠️  Found ${positions.length} open position(s) — closing before new order...`,
  );
  for (const pos of positions) {
    await closePosition(pos, symbol);
  }

  // Let exchange settle before placing a new order
  await new Promise((r) => setTimeout(r, 1500));
}

async function setLeverage(symbol) {
  log(`⚙️  Setting leverage to ${LEVERAGE}x...`);

  const res = await client.setLeverage({
    category: "linear",
    symbol: symbol,
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

async function getInstrumentInfo(symbol) {
  const res = await client.getInstrumentsInfo({
    category: "linear",
    symbol,
  });

  return res.result.list[0];
}

function roundToStep(value, step) {
  return Math.floor(value / step) * step;
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
async function placeOrderBTC(signal, symbol) {
  const side = signal === "BUY" ? "Buy" : "Sell";
  const signalLabel = signal === "BUY" ? "LONG" : "SHORT";

  log(`\n${"═".repeat(60)}`);
  log(`📡 Signal : ${signal}  →  Opening ${signalLabel}`);
  log(`🌐 Mode   : ${USE_TESTNET ? "TESTNET" : "MAINNET"}`);
  log(`${"═".repeat(60)}\n`);

  // 2. Set leverage
  await setLeverage(symbol);

  // 3. Price + qty
  const entryPrice = await getBtcPrice(symbol);

  const currentBalanceInAud = (await getBalance()) - 5;
  const currentBalance = currentBalanceInAud / 1.6;
  if (currentBalance < 5) {
    return true;
  }
  const rawQty = (currentBalance * LEVERAGE) / entryPrice;

  const instrument = await getInstrumentInfo(symbol);

  const qtyStep = parseFloat(instrument.lotSizeFilter.qtyStep);

  const minQty = parseFloat(instrument.lotSizeFilter.minOrderQty);

  const qty = roundToStep(rawQty, qtyStep);

  if (qty < minQty) {
    log(`❌ Quantity ${qty} is below minimum ${minQty}`);
    return;
  }
  //const qty = parseInt(rawQty.toFixed(3)); // use 0 decimals for XRP if step size = 1

  log(`\n🚀 Placing ${signalLabel} Market Entry`);
  log(`   qty      : ${qty} ${symbol}`);
  log(`   notional : ~$${currentBalance} USD`);
  log(`   leverage : ${LEVERAGE}x`);

  // 4. Entry market order
  const orderRes = await client.submitOrder({
    category: "linear",
    symbol: symbol,
    side,
    orderType: "Market",
    qty: qty.toString(),
    //timeInForce: "GTC",
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
    const positions = await getOpenPositions(symbol);
    const pos = positions.find((p) => p.symbol === symbol);
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

    let theBalance;

    coins.forEach((c) => {
      if (c.coin === "USDT") {
        theBalance = c.walletBalance;
      }
      console.log(`Coin: ${c.coin}`);
      console.log(`Wallet Balance: ${c.walletBalance}`);
      console.log(`Available Balance: ${c.availableToWithdraw}`);
      console.log("---");
    });
    return theBalance;
  } catch (err) {
    console.error("Error getting balance");
    console.error(err.stack);
  }
}

module.exports = {
  closeAllBTCPositions,
  placeOrderBTC,
  getBtcPrice,
};
