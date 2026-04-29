/**
 * Point of Control (POC) Calculator for BTCUSDT.P
 * Uses bybit-api to fetch 5m and 15m kline data
 *
 * Install: npm install bybit-api
 * Run:     node poc.js
 */

const { RestClientV5 } = require("bybit-api");

// ── Config ────────────────────────────────────────────────────────────────────
const SYMBOL = "BTCUSDT";
const CATEGORY = "linear"; // perpetual futures
const INTERVALS = ["5"]; // minutes
const CANDLES = 200; // lookback (max 200 per request)
const TICK_SIZE = 0.5; // price bucket width in USDT (adjust for precision)
// ──────────────────────────────────────────────────────────────────────────────

const client = new RestClientV5({ testnet: false });

/**
 * Build a Volume Profile from kline data and return the Point of Control.
 *
 * Kline row format (Bybit V5):
 *   [startTime, open, high, low, close, volume, turnover]
 *
 * We distribute each candle's volume evenly across price buckets
 * that span [low, high] at TICK_SIZE resolution.
 *
 * @param {string[][]} klines
 * @returns {{ poc: number, profile: Map<number, number> }}
 */
function calculatePOC(klines) {
  const profile = new Map(); // price bucket → accumulated volume

  for (const [, , high, low, , volume] of klines) {
    const hi = parseFloat(high);
    const lo = parseFloat(low);
    const vol = parseFloat(volume);

    // Number of ticks this candle spans
    const loTick = Math.floor(lo / TICK_SIZE) * TICK_SIZE;
    const hiTick = Math.ceil(hi / TICK_SIZE) * TICK_SIZE;
    const ticks = Math.max(1, Math.round((hiTick - loTick) / TICK_SIZE));
    const volPerTick = vol / ticks;

    for (let price = loTick; price <= hiTick + 1e-9; price += TICK_SIZE) {
      const bucket = Math.round(price / TICK_SIZE) * TICK_SIZE;
      profile.set(bucket, (profile.get(bucket) ?? 0) + volPerTick);
    }
  }

  // Find the price bucket with the highest volume → POC
  let pocPrice = 0;
  let maxVol = -Infinity;
  for (const [price, vol] of profile) {
    if (vol > maxVol) {
      maxVol = vol;
      pocPrice = price;
    }
  }

  return { poc: pocPrice, maxVolume: maxVol, profile };
}

/**
 * Print a compact ASCII volume profile around the POC.
 */
function printProfile(profile, poc, topN = 20) {
  const sorted = [...profile.entries()].sort((a, b) => b[0] - a[0]);
  const maxVol = Math.max(...profile.values());
  const barWidth = 30;

  // Show top N rows by price, centred around POC
  const pocIdx = sorted.findIndex(([p]) => p === poc);
  const start = Math.max(0, pocIdx - Math.floor(topN / 2));
  const slice = sorted.slice(start, start + topN);

  console.log("\n  Price (USDT)   Volume          Profile");
  console.log("  ─────────────  ──────────────  " + "─".repeat(barWidth));
  for (const [price, vol] of slice) {
    const bar = "█".repeat(Math.round((vol / maxVol) * barWidth));
    const marker = price === poc ? " ◄ POC" : "";
    console.log(
      `  ${price.toFixed(1).padStart(12)}  ${vol.toFixed(2).padStart(14)}  ${bar}${marker}`,
    );
  }
}

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Bybit Point of Control Calculator — ${SYMBOL} (Perpetual)`);
  console.log(`${"═".repeat(60)}\n`);

  for (const interval of INTERVALS) {
    const label = `${interval}-minute`;
    console.log(
      `─── ${label.toUpperCase()} ─────────────────────────────────────`,
    );

    try {
      const res = await client.getKline({
        category: CATEGORY,
        symbol: SYMBOL,
        interval,
        limit: CANDLES,
      });

      if (res.retCode !== 0) {
        console.error(`  API error: ${res.retMsg}`);
        continue;
      }

      const klines = res.result?.list ?? [];
      if (klines.length === 0) {
        console.warn("  No kline data returned.");
        continue;
      }

      const { poc, maxVolume, profile } = calculatePOC(klines);
      const latest = parseFloat(klines[0][4]); // close of most recent candle

      console.log(`  Candles analysed : ${klines.length}`);
      console.log(`  Tick size (bucket): $${TICK_SIZE}`);
      console.log(`  Current price    : $${latest.toLocaleString()}`);
      console.log(
        `  Point of Control : $${poc.toLocaleString()} (highest-volume price)`,
      );
      console.log(`  POC volume       : ${maxVolume.toFixed(4)} BTC`);
      console.log(`  Distance to POC  : ${(latest - poc).toFixed(2)} USDT`);
      console.log(
        `                     (${(((latest - poc) / poc) * 100).toFixed(3)}%)`,
      );

      printProfile(profile, poc);
      console.log();
    } catch (err) {
      console.error(`  Error fetching ${label} data:`, err.message ?? err);
    }
  }
}

main();
