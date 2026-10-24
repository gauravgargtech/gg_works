require("../config/config");
const process = require("process");

const LEVERAGE = 2;

const { RestClientV5 } = require("bybit-api");

const { sendPushNotif } = require("../config/telegram_notify");

const BYBIT_API_KEY = process.env.DEMO_10k_BYBIT_API_KEY || "";
const BYBIT_API_SECRET = process.env.DEMO_10k_BYBIT_SECRET_KEY || "";
const USE_TESTNET =
  (process.env.BYBIT_TESTNET || "false").toLowerCase() === "true";

const client = new RestClientV5({
  key: BYBIT_API_KEY,
  secret: BYBIT_API_SECRET,
  demoTrading: true,
  testnet: false,
});

const BYBIT_BASE_URL = "https://api-demo.bybit.com";

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

async function getAllActivePositions() {
  const res = await client.getPositionInfo({
    category: "linear",
    settleCoin: "USDT",
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
  const decimals = step.toString().split(".")[1]?.length || 0;

  return Number((Math.floor(value / step) * step).toFixed(decimals));
}

function roundToStep_old(value, step) {
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
  try {
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
    const rawQty = (150 * LEVERAGE) / entryPrice;

    const instrument = await getInstrumentInfo(symbol);

    const qtyStep = parseFloat(instrument.lotSizeFilter.qtyStep);
    const minQty = parseFloat(instrument.lotSizeFilter.minOrderQty);
    const tickSizeStr = instrument.priceFilter.tickSize;
    const tickSize = parseFloat(tickSizeStr);
    const tickDecimals = (tickSizeStr.split(".")[1] || "").length;

    const roundToTick = (price) =>
      (Math.round(price / tickSize) * tickSize).toFixed(tickDecimals);

    const qty = roundToStep(rawQty, qtyStep);

    if (qty < minQty) {
      log(`❌ Quantity ${qty} is below minimum ${minQty}`);
      return;
    }

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
      timeInForce: "GTC",
    });

    console.log(
      "----------------------orderRes---------------------------------------",
    );
    console.log(orderRes);

    if (orderRes.retCode !== 0) {
      throw new Error(`Entry order failed: ${orderRes.retMsg}`);
    }

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

    // 6. Take profits
    const totalQty = parseFloat(actualQty);

    // TP1: +10% (Buy) / -10% (Sell) with 50% of the position
    const tp1Price = roundToTick(
      side === "Buy" ? actualEntry * 1.1 : actualEntry * 0.9,
    );
    const tp1Qty = roundToStep(totalQty * 0.5, qtyStep);

    // TP2: +25% (Buy) / -25% (Sell) with the full remaining quantity
    const tp2Price = roundToTick(
      side === "Buy" ? actualEntry * 1.25 : actualEntry * 0.75,
    );
    const tp2Qty = roundToStep(totalQty - tp1Qty, qtyStep);

    // ── TP1 ──────────────────────────────────────────────────────
    log(`\n🎯 Setting TP1 (50%)`);
    log(`   TP1 price : $${Number(tp1Price).toLocaleString()}`);
    log(`   TP1 qty   : ${tp1Qty}`);

    await sendPushNotif(
      `Lets place TP1 order for ${symbol} at price ${Number(tp1Price).toLocaleString()} with qty ${tp1Qty}`,
    );

    const tp1Order = await client.setTradingStop({
      category: "linear",
      symbol,
      takeProfit: tp1Price.toString(),
      tpSize: tp1Qty.toString(),
      tpOrderType: "Market",
      positionIdx: 0,
      tpslMode: "Partial",
    });

    if (tp1Order.retCode !== 0) {
      throw new Error(`TP1 failed: ${tp1Order.retMsg}`);
    }

    // ── TP2 ──────────────────────────────────────────────────────
    log(`\n🎯 Setting TP2 (remaining)`);
    log(`   TP2 price : $${Number(tp2Price).toLocaleString()}`);
    log(`   TP2 qty   : ${tp2Qty}`);

    let tp2Order = null;
    if (tp2Qty >= minQty) {
      await sendPushNotif(
        `Lets place TP2 order for ${symbol} at price ${Number(tp2Price).toLocaleString()} with qty ${tp2Qty}`,
      );

      tp2Order = await client.setTradingStop({
        category: "linear",
        symbol,
        takeProfit: tp2Price.toString(),
        tpSize: tp2Qty.toString(),
        tpOrderType: "Market",
        positionIdx: 0,
        tpslMode: "Partial",
      });

      if (tp2Order.retCode !== 0) {
        throw new Error(`TP2 failed: ${tp2Order.retMsg}`);
      }
    } else {
      log(`⚠️  Remaining qty ${tp2Qty} is below min ${minQty} — skipping TP2`);
    }

    await sendPushNotif(
      `TP orders placed on Bybit for ${symbol}\n` +
        `TP1: ${tp1Price} x ${tp1Qty}\n` +
        `TP2: ${tp2Price} x ${tp2Qty}\n` +
        `${JSON.stringify({ tp1Order, tp2Order }, null, 2)}`,
    );

    // Summary
    log(`${"═".repeat(60)}`);
    log(`🏁 Done! Full order summary:`);
    log(`   Direction     : ${signalLabel}`);
    log(`   Entry price   : $${actualEntry.toLocaleString()}`);
    log(`   Position size : ${actualQty} BTC`);
    log(`   Entry orderId : ${entryOrderId}`);
    log(`   TP1           : $${tp1Price} (${tp1Qty})`);
    log(`   TP2           : $${tp2Price} (${tp2Qty})`);

    return { entryOrderId };
  } catch (err) {
    await sendPushNotif(`Error Placing Order Bybit,  ${err.message}`);
  }
}

async function placeOrderBTCOld(signal, symbol) {
  try {
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
    if (currentBalance < 500) {
      return true;
    }
    const rawQty = (150 * LEVERAGE) / entryPrice;

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

    const tpPrice = side === "Buy" ? actualEntry * 1.1 : actualEntry * 0.9;

    const tpQty = roundToStep(parseFloat(actualQty) * 0.5, qtyStep);

    log(`\n🎯 Setting 50% Take Profit`);
    log(`   TP price : $${tpPrice.toLocaleString()}`);
    log(`   TP qty   : ${tpQty}`);

    await sendPushNotif(
      "Lets place TP order for " +
        symbol +
        " at price " +
        tpPrice.toLocaleString() +
        " with qty " +
        tpQty,
    );

    const tpOrder = await client.setTradingStop({
      category: "linear",
      symbol,
      takeProfit: tpPrice.toString(),
      tpSize: tpQty.toString(),
      tpOrderType: "Market",
      positionIdx: 0,
      tpslMode: "Partial",
    });

    await sendPushNotif(
      `TP  Order Placed Bybit,  ${JSON.stringify(tpOrder, null, 2)}`,
    );

    log(`🎯 TP price : $${tpPrice.toLocaleString()}`);
    log(`🎯 TP qty   : ${tpQty} ${symbol}`);

    // Summary
    log(`${"═".repeat(60)}`);
    log(`🏁 Done! Full order summary:`);
    log(`   Direction     : ${signalLabel}`);
    log(`   Entry price   : $${actualEntry.toLocaleString()}`);
    log(`   Position size : ${actualQty} BTC`);
    log(`   Entry orderId : ${entryOrderId}`);

    return { entryOrderId };
  } catch (err) {
    await sendPushNotif(`Error Placing Order Bybit,  ${err.message}`);
  }
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
  getAllActivePositions,
  getBalance,
  closePosition,
};
