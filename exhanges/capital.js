require("../config/config");
const process = require("process");
const https = require("https");

// ============================================================
// CONFIG
// ============================================================
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

const { get, set, del, setNX } = require("../adapters/redis");

const API_KEY = process.env.CAPITAL_API_KEY;
const IDENTIFIER = process.env.CAPITAL_IDENTIFIER;
const PASSWORD = process.env.CAPITAL_PASSWORD;

const SESSION_KEY = "capital:session";
const SESSION_LOCK_KEY = "capital:session:lock";
const SESSION_TTL_SECONDS = 60 * 9; // Capital sessions expire ~10 min idle;

// LIVE
const BASE_URL = "https://api-capital.backend-capital.com";

// DEMO:
// const BASE_URL = "https://demo-api-capital.backend-capital.com";

const MAX_CANDLES = 1000;

// Keep this below Capital.com's 10 requests/sec limit.
// 5 concurrent requests is a comfortable starting point.
const CONCURRENCY = 5;

// Retry settings
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;

// ============================================================
// PAIRS
// ============================================================

// IMPORTANT:
// These must be Capital.com EPICs.
//
// Verify the exact EPICs using getMarkets().
// Examples only:
//
// "EURUSD"
// "GBPUSD"
// "AUDUSD"
// "NZDUSD"
// "USDJPY"
// "USDCHF"
// "USDCAD"
// "EURJPY"
// "GBPJPY"
// "GOLD"

const FOREX_PAIRS = [
  "EURUSD",
  "GBPUSD",
  "AUDUSD",
  "NZDUSD",
  "USDJPY",
  "USDCHF",
  "USDCAD",
  "EURJPY",
  "GBPJPY",
];

// ============================================================
// TIMEFRAMES
// ============================================================

const RESOLUTIONS = {
  "15m": "MINUTE_15",
  "1h": "HOUR",
  "4h": "HOUR_4",
  "1d": "DAY",
};

// ============================================================
// HTTP KEEP-ALIVE AGENT
// ============================================================

const agent = new https.Agent({
  keepAlive: true,

  // Maximum number of sockets opened at once.
  maxSockets: CONCURRENCY,

  // Keep idle sockets around.
  maxFreeSockets: CONCURRENCY,

  // Optional socket timeout.
  timeout: 30000,
});

// ============================================================
// SESSION
// ============================================================

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// HTTP REQUEST
// ============================================================

function request(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);

    const requestHeaders = {
      Accept: "application/json",
      ...headers,
    };

    if (body) {
      requestHeaders["Content-Type"] = "application/json";
    }

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,

      agent,

      headers: requestHeaders,

      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.setEncoding("utf8");

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        let parsed;

        try {
          parsed = data ? JSON.parse(data) : {};
        } catch {
          parsed = data;
        }

        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: parsed,
        });
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("Request timeout"));
    });

    req.on("error", (error) => {
      reject(error);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

// ============================================================
// CREATE SESSION
// ============================================================

async function createSession() {
  if (!API_KEY) throw new Error("Missing CAPITAL_API_KEY");
  if (!IDENTIFIER) throw new Error("Missing CAPITAL_IDENTIFIER");
  if (!PASSWORD) throw new Error("Missing CAPITAL_PASSWORD");

  console.log("Creating Capital.com session...");

  const response = await request(
    "POST",
    "/api/v1/session",
    { "X-CAP-API-KEY": API_KEY, "Content-Type": "application/json" },
    { identifier: IDENTIFIER, password: PASSWORD, encryptedPassword: false },
  );

  if (response.statusCode !== 200) {
    throw new Error(
      `Session creation failed (${response.statusCode}): ${JSON.stringify(response.data)}`,
    );
  }

  const cst = response.headers["cst"];
  const securityToken = response.headers["x-security-token"];

  if (!cst || !securityToken) {
    throw new Error("Capital.com did not return CST/X-SECURITY-TOKEN");
  }

  const session = { cst, securityToken, createdAt: Date.now() };

  await set(SESSION_KEY, JSON.stringify(session), SESSION_TTL_SECONDS);

  console.log("Capital.com session created");

  return session;
}

async function ensureSession() {
  const cached = await get(SESSION_KEY);

  if (cached) {
    return JSON.parse(cached);
  }

  return acquireSessionWithLock();
}

async function acquireSessionWithLock() {
  const gotLock = await setNX(SESSION_LOCK_KEY, "1", 15);

  if (gotLock === "OK") {
    try {
      return await createSession();
    } finally {
      await del(SESSION_LOCK_KEY); // however your adapter exposes delete
    }
  }

  await sleep(300);

  const cached = await get(SESSION_KEY); // however your adapter exposes get
  if (cached) {
    return cached;
  }

  return acquireSessionWithLock();
}

// ============================================================
// REFRESH SESSION
// ============================================================

async function refreshSession() {
  await del(SESSION_KEY);

  return acquireSessionWithLock();
}

// ============================================================
// AUTHENTICATED REQUEST
// ============================================================

async function authenticatedRequest(method, path, retryCount = 0) {
  const session = await ensureSession();

  const response = await request(method, path, {
    CST: session.cst,
    "X-SECURITY-TOKEN": session.securityToken,
  });

  if (response.statusCode === 401) {
    console.log("Capital.com session expired. Refreshing...");

    await refreshSession();

    if (retryCount >= MAX_RETRIES) {
      throw new Error("Maximum session refresh retries reached");
    }

    return authenticatedRequest(method, path, retryCount + 1);
  }
  // ----------------------------------------------------------
  // RATE LIMITED
  // ----------------------------------------------------------

  if (response.statusCode === 429) {
    if (retryCount >= MAX_RETRIES) {
      throw new Error(`Rate limited after ${MAX_RETRIES} retries`);
    }

    const delay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);

    console.log(`Rate limited. Waiting ${delay}ms...`);

    await sleep(delay);

    return authenticatedRequest(method, path, retryCount + 1);
  }

  // ----------------------------------------------------------
  // OTHER ERRORS
  // ----------------------------------------------------------

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Capital API ${response.statusCode}: ${JSON.stringify(response.data)}`,
    );
  }

  return response.data;
}

// ============================================================
// GET CANDLES
// ============================================================

async function getCandles(
  epic,
  timeframe = "1h",
  max = MAX_CANDLES,
  options = {},
) {
  if (!RESOLUTIONS[timeframe]) {
    throw new Error(
      `Invalid timeframe "${timeframe}". ` +
        `Use: ${Object.keys(RESOLUTIONS).join(", ")}`,
    );
  }

  if (max < 1 || max > 1000) {
    throw new Error("max must be between 1 and 1000");
  }

  const query = new URLSearchParams();

  query.set("resolution", RESOLUTIONS[timeframe]);

  query.set("max", String(max));

  // Optional historical range
  if (options.from) {
    query.set("from", options.from);
  }

  if (options.to) {
    query.set("to", options.to);
  }

  const path =
    `/api/v1/prices/${encodeURIComponent(epic)}` + `?${query.toString()}`;

  const data = await authenticatedRequest("GET", path);

  return formatCandles(data);
}

// ============================================================
// FORMAT CANDLES
// ============================================================

function formatCandles(data) {
  if (!data || !Array.isArray(data.prices)) {
    return [];
  }

  const closedCandles = data.prices.slice(0, -1);

  return closedCandles.map((candle) => ({
    time: candle.snapshotTimeUTC,
    openTime: new Date(candle.snapshotTimeUTC).getTime(),
    open: candle.openPrice?.bid ?? null,
    high: candle.highPrice?.bid ?? null,
    low: candle.lowPrice?.bid ?? null,
    close: candle.closePrice?.bid ?? null,
    // Ask prices
    openAsk: candle.openPrice?.ask ?? null,
    highAsk: candle.highPrice?.ask ?? null,
    lowAsk: candle.lowPrice?.ask ?? null,
    closeAsk: candle.closePrice?.ask ?? null,
    volume: candle.lastTradedVolume ?? null,
    brisbaneTime: dayjs(candle.snapshotTimeUTC)
      .add("10", "hours")
      .tz("Australia/Brisbane")
      .format("YYYY-MM-DD HH:mm:ss"),
  }));
}

// ============================================================
// GET MARKET INFORMATION
// ============================================================

async function getMarkets(searchTerm) {
  const query = new URLSearchParams();

  if (searchTerm) {
    query.set("searchTerm", searchTerm);
  }

  const path = `/api/v1/markets?${query.toString()}`;

  const data = await authenticatedRequest("GET", path);

  return data.markets || [];
}

// ============================================================
// GET MARKET EPICS
// ============================================================

async function findEpic(searchTerm) {
  const markets = await getMarkets(searchTerm);

  return markets.map((market) => ({
    epic: market.epic,
    name: market.instrumentName,
    symbol: market.symbol,
    type: market.instrumentType,
    status: market.marketStatus,
  }));
}

// ============================================================
// FETCH MULTIPLE PAIRS WITH CONCURRENCY
// ============================================================

async function fetchPairs(pairs, timeframe, max = MAX_CANDLES) {
  const results = {};

  let currentIndex = 0;

  async function worker() {
    while (true) {
      const index = currentIndex++;

      if (index >= pairs.length) {
        return;
      }

      const epic = pairs[index];

      try {
        console.log(`[${timeframe}] Fetching ${epic}...`);

        const candles = await getCandles(epic, timeframe, max);

        results[epic] = candles;

        console.log(`[${timeframe}] ${epic}: ${candles.length} candles`);
      } catch (error) {
        console.error(`[${timeframe}] ${epic} ERROR:`, error.message);

        results[epic] = {
          error: error.message,
        };
      }
    }
  }

  const workers = [];

  const workerCount = Math.min(CONCURRENCY, pairs.length);

  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return results;
}

// ============================================================
// FETCH ALL TIMEFRAMES
// ============================================================

async function fetchAllTimeframes(pairs, max = MAX_CANDLES) {
  const result = {};

  // 15 MIN
  console.log("\n==============================");
  console.log("15 MINUTES");
  console.log("==============================");

  result["15m"] = await fetchPairs(pairs, "15m", max);

  // 1 HOUR
  console.log("\n==============================");
  console.log("1 HOUR");
  console.log("==============================");

  result["1h"] = await fetchPairs(pairs, "1h", max);

  // 4 HOURS
  console.log("\n==============================");
  console.log("4 HOURS");
  console.log("==============================");

  result["4h"] = await fetchPairs(pairs, "4h", max);

  // 1 DAY
  console.log("\n==============================");
  console.log("1 DAY");
  console.log("==============================");

  result["1d"] = await fetchPairs(pairs, "1d", max);

  return result;
}

module.exports = {
  createSession,
  getCandles,
  getMarkets,
  findEpic,
  fetchPairs,
  fetchAllTimeframes,
};
