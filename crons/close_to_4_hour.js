/**
 * Bybit Support & Resistance Scanner
 *
 * 1. Fetches top 100 USDT perpetual coins by 24h volume from Bybit
 * 2. Fetches 4H OHLCV klines for each coin
 * 3. Calculates support & resistance levels using pivot highs/lows
 * 4. Alerts if current price is within 0.5% of any S/R level
 */

require("../config/config");
const https = require("https");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { fetchCandles } = require("../exhanges/oanda");
const technical = require("technicalindicators");

dayjs.extend(utc);
dayjs.extend(timezone);

const { set, get } = require("../adapters/redis");

const { sendPushNotif } = require("../config/telegram_notify");

const BASE_URL = "https://api.bybit.com";

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function pct(a, b) {
  return Math.abs((a - b) / b) * 100;
}

// ─── Step 1: Top 100 coins by 24h volume ────────────────────────────────────

async function getTop100ByVolume() {
  const url = `${BASE_URL}/v5/market/tickers?category=linear`;
  const data = await fetchJSON(url);

  if (data.retCode !== 0) throw new Error(`Bybit error: ${data.retMsg}`);

  const tickers = data.result.list
    // Only USDT-settled perpetuals (e.g. BTCUSDT), skip inverse / spot
    .filter((t) => t.symbol.endsWith("USDT") && parseFloat(t.turnover24h) > 0)
    // Sort descending by 24h quote volume (turnover24h is in USDT)
    .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
    .slice(0, 100)
    .map((t) => ({
      symbol: t.symbol,
      lastPrice: parseFloat(t.lastPrice),
      volume24h: parseFloat(t.turnover24h),
    }));

  return tickers;
}

// ─── Step 2: Fetch 4H klines ─────────────────────────────────────────────────

async function get4HKlines(symbol, limit = 100) {
  const url = `${BASE_URL}/v5/market/kline?category=linear&symbol=${symbol}&interval=D&limit=${limit}`;
  const data = await fetchJSON(url);

  if (data.retCode !== 0)
    throw new Error(`Kline error for ${symbol}: ${data.retMsg}`);

  // Each item: [startTime, open, high, low, close, volume, turnover]
  return data.result.list.map((k) => ({
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));
}

// ─── Step 3: Calculate Support & Resistance levels ───────────────────────────
//
// Strategy: Pivot-point method
//   - A pivot HIGH is a candle whose high is higher than the N candles on each side
//   - A pivot LOW  is a candle whose low  is lower  than the N candles on each side
//
// We then cluster nearby levels (within 0.5%) to avoid duplicates.

function findPivots(candles, leftBars = 5, rightBars = 5) {
  const resistances = [];
  const supports = [];

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const c = candles[i];

    // Pivot high?
    const isHighPivot =
      candles.slice(i - leftBars, i).every((l) => l.high <= c.high) &&
      candles.slice(i + 1, i + rightBars + 1).every((r) => r.high <= c.high);

    if (isHighPivot) resistances.push(c.high);

    // Pivot low?
    const isLowPivot =
      candles.slice(i - leftBars, i).every((l) => l.low >= c.low) &&
      candles.slice(i + 1, i + rightBars + 1).every((r) => r.low >= c.low);

    if (isLowPivot) supports.push(c.low);
  }

  return { resistances, supports };
}

// Merge levels that are within `threshold`% of each other (keep the average)
function clusterLevels(levels, threshold = 0.5) {
  if (!levels.length) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  const clusters = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const last = clusters[clusters.length - 1];
    const avg = last.reduce((s, v) => s + v, 0) / last.length;
    if (pct(sorted[i], avg) <= threshold) {
      last.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }

  return clusters.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

// ─── Step 4: Check proximity ─────────────────────────────────────────────────

function checkProximity(price, levels, threshold = 0.5) {
  return levels.filter((lvl) => pct(price, lvl) <= threshold);
}

// ─── Main ────────────────────────────────────────────────────────────────────

const closeTo4Hour = async () => {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Bybit 4H Support & Resistance Scanner");
  console.log("  Threshold: price within 0.5% of S/R level");
  console.log("═══════════════════════════════════════════════════════════\n");

  // 1. Top 100 by volume
  console.log("⏳ Fetching top 100 coins by 24h volume...");
  const coins = await getTop100ByVolume();
  console.log(`✅ Got ${coins.length} coins\n`);

  const alerts = [];

  // 2 & 3. For each coin, get klines + compute S/R
  for (let i = 0; i < coins.length; i++) {
    const { symbol, lastPrice, volume24h } = coins[i];
    process.stdout.write(
      `[${String(i + 1).padStart(3)}/${coins.length}] ${symbol.padEnd(12)}`,
    );

    try {
      let candles;
      const isCandlesCached = await get(`close_to_4_hours_${symbol}_candles`);
      if (isCandlesCached) {
        candles = JSON.parse(isCandlesCached);
        await set(
          `close_to_4_hours_${symbol}_candles`,
          JSON.stringify(candles),
          3500,
        );
      } else {
        candles = await get4HKlines(symbol, 300);
        await set(
          `close_to_4_hours_${symbol}_candles`,
          JSON.stringify(candles),
          3500,
        );
      }

      //const candles = candless.slice(50);

      const { resistances: rawR, supports: rawS } = findPivots(candles, 50, 50);

      const resistances = clusterLevels(rawR);
      const supports = clusterLevels(rawS);

      const nearResistance = checkProximity(lastPrice, resistances);
      const nearSupport = checkProximity(lastPrice, supports);

      if (nearResistance.length || nearSupport.length) {
        const isCc = await get(`CLOSE_TO_4_HR_${symbol}`);

        if (!isCc) {
          await set(`CLOSE_TO_4_HR_${symbol}`, "true", 3600 * 24);

          await sendPushNotif(
            `VERY FAR : Coin ${symbol} is close to a 4H S/R level. Last price: ${lastPrice.toFixed(2)}`,
          );
          alerts.push({
            symbol,
            lastPrice,
            volume24h,
            nearResistance,
            nearSupport,
          });
          process.stdout.write(" 🚨 ALERT\n");
        }
      } else {
        process.stdout.write(" ✓\n");
      }

      // Polite rate-limiting: ~2 req/sec
      await sleep(500);
    } catch (err) {
      process.stdout.write(` ⚠️  ${err.message}\n`);
    }
  }

  // 4. Print alerts
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  ALERTS — Coins within 0.5% of a 4H S/R level`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (!alerts.length) {
    console.log("  No coins are currently near a key 4H S/R level.");
    return;
  }

  for (const a of alerts) {
    const vol = (a.volume24h / 1_000_000).toFixed(1);
    console.log(
      `━━━ ${a.symbol}  |  Price: $${a.lastPrice}  |  24h Vol: $${vol}M`,
    );

    if (a.nearResistance.length) {
      for (const r of a.nearResistance) {
        const dist = pct(a.lastPrice, r).toFixed(3);
        console.log(`  📈 RESISTANCE @ $${r.toFixed(6)}  →  ${dist}% away`);
      }
    }
    if (a.nearSupport.length) {
      for (const s of a.nearSupport) {
        const dist = pct(a.lastPrice, s).toFixed(3);
        console.log(`  📉 SUPPORT    @ $${s.toFixed(6)}  →  ${dist}% away`);
      }
    }
    console.log();
  }

  console.log(`Total alerts: ${alerts.length} coin(s)`);
};
module.exports = closeTo4Hour;
