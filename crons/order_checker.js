/**
 * OANDA Open Trades EMA50 Monitor
 *
 * Every hour, fetches all currently open trades (positions) on an OANDA account
 * and, for each instrument, checks whether the H1 (1-hour) candle close has moved
 * against the trade's direction relative to the 50-period EMA:
 *
 *   - SHORT trade: console.log an alert if H1 close is ABOVE EMA50
 *   - LONG trade:  console.log an alert if H1 close is BELOW EMA50
 *
 * NOTE: "Running orders" is implemented here as OPEN TRADES (live positions),
 * since direction (Short/Long) + live price checks only apply once a position
 * is filled. If you actually meant pending limit/stop orders, let me know and
 * I'll point this at /v3/accounts/{id}/pendingOrders instead.
 *
 * Setup:
 *   npm install axios dotenv
 *
 *   Create a .env file alongside this script:
 *     OANDA_API_KEY=your_api_token
 *     OANDA_ACCOUNT_ID=your_account_id
 *     OANDA_ENV=practice        # or "live"
 *
 * Run:
 *   node oanda-ema-monitor.js
 */
const { sendPushNotif } = require("../config/telegram_notify");

require("../config/config");
const axios = require("axios");

const { getOpenTrades, fetchCandles } = require("../exhanges/oanda");

const EMA_PERIOD = 50;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Standard EMA calculation (SMA-seeded). Returns the EMA value as of the last close. */
function calculateEMA(closes, period) {
  if (closes.length < period) {
    throw new Error(
      `Not enough candles (${closes.length}) to compute EMA${period}`,
    );
  }
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** currentUnits is negative for short trades, positive for long trades. */
function getDirection(trade) {
  return parseFloat(trade.currentUnits) < 0 ? "SHORT" : "LONG";
}

async function checkTrade(trade) {
  const instrument = trade.instrument;
  const direction = getDirection(trade);
  const timestamp = new Date().toISOString();

  try {
    const candles = await fetchCandles(instrument, "H1", EMA_PERIOD * 3);
    const closes = candles.map((c) => c.close);
    const lastClose = closes[closes.length - 1];
    const ema50 = calculateEMA(closes, EMA_PERIOD);

    if (direction === "SHORT" && lastClose > ema50) {
      await sendPushNotif(
        `ORDER ALERT: ${instrument} is SHORT but H1 close (${lastClose}) is ABOVE EMA50 (${ema50.toFixed(
          5,
        )}) — trade #${trade.id}`,
      );
      console.log(
        `[${timestamp}] ALERT: ${instrument} is SHORT but H1 close (${lastClose}) is ABOVE EMA50 (${ema50.toFixed(
          5,
        )}) — trade #${trade.id}`,
      );
    } else if (direction === "LONG" && lastClose < ema50) {
      await sendPushNotif(
        `ORDER ALERT: ${instrument} is LONG but H1 close (${lastClose}) is BELOW EMA50 (${ema50.toFixed(
          5,
        )}) — trade #${trade.id}`,
      );
      console.log(
        `[${timestamp}] ALERT: ${instrument} is LONG but H1 close (${lastClose}) is BELOW EMA50 (${ema50.toFixed(
          5,
        )}) — trade #${trade.id}`,
      );
    } else {
      console.log(
        `[${timestamp}] OK: ${instrument} ${direction} | close=${lastClose} ema50=${ema50.toFixed(5)}`,
      );
    }
  } catch (err) {
    console.error(
      `[${timestamp}] Error checking ${instrument} (trade #${trade.id}):`,
      err.message,
    );
  }
}

async function orderChecker() {
  console.log(`\n--- Running check at ${new Date().toISOString()} ---`);
  try {
    const trades = await getOpenTrades();

    if (trades.length === 0) {
      console.log("No open trades.");
      return;
    }
    for (const trade of trades) {
      await checkTrade(trade);
      await sleep(2000);
    }
  } catch (err) {
    console.error(
      "Failed to fetch open trades:",
      err.response?.data || err.message,
    );
  }
}

module.exports = orderChecker;
