require("dotenv").config();

// ---------------------------------------------------------------------------
// 1. PAIRS — your active watchlist (OANDA instrument format: BASE_QUOTE)
// ---------------------------------------------------------------------------
const FOREX_PAIRS = [
  "GBP_USD",
  "AUD_USD",
  "NZD_USD",
  "USD_JPY",
  "USD_CAD",
  "XAU_USD", // gold — kept for price tracking, EXCLUDED from currency strength math (not a currency)
  "GBP_JPY",
  "AUD_JPY",
  "CHF_JPY",
  "CAD_JPY",
  "NZD_JPY",
  "EUR_GBP",
  "AUD_CAD",
  "AUD_CHF",
  "AUD_NZD",
  "CAD_CHF",
  "EUR_AUD",
  "EUR_CAD",
  "EUR_CHF",
  "EUR_NZD",
  "GBP_AUD",
  "GBP_CAD",
  "GBP_CHF",
  "GBP_NZD",
  "NZD_CAD",
];

// Pairs actually usable for currency-strength math (drop metals/commodities)
const STRENGTH_PAIRS = FOREX_PAIRS.filter((p) => !p.includes("XAU"));

// Derive the unique list of real currencies present in the basket
const CURRENCIES = [
  ...new Set(STRENGTH_PAIRS.flatMap((p) => p.split("_"))),
].sort();
// -> ["AUD","CAD","CHF","EUR","GBP","JPY","NZD","USD"]

// ---------------------------------------------------------------------------
// 2. FRED SERIES IDS — short-term policy/interbank rate proxy per currency
// ---------------------------------------------------------------------------
// NOTE: FRED occasionally renames or discontinues series (e.g. the old
// US IRSTCI01 series was discontinued in 2022 — FEDFUNDS replaces it).
// Verify these resolve before relying on them long-term:
// https://fred.stlouisfed.org/series/<ID>
const FRED_POLICY_RATE_SERIES = {
  USD: "FEDFUNDS", // Effective Federal Funds Rate
  EUR: "ECBDFR", // ECB Deposit Facility Rate (the rate the ECB itself steers policy with)
  GBP: "IRSTCI01GBM156N", // UK immediate/interbank rate (OECD via FRED)
  AUD: "IRSTCI01AUM156N",
  NZD: "IRSTCI01NZM156N",
  CHF: "IRSTCI01CHM156N",
  JPY: "IRSTCI01JPM156N",
  CAD: "IRSTCI01CAM156N", // verify on FRED — follows the same OECD naming pattern as above
};

// Optional secondary layer: 10Y govt bond yield, used as a slower-moving
// "rate expectations" proxy. Differentials here matter more than levels.
const FRED_LONG_YIELD_SERIES = {
  USD: "IRLTLT01USM156N",
  EUR: "IRLTLT01EZM156N",
  GBP: "IRLTLT01GBM156N",
  JPY: "IRLTLT01JPM156N",
  CHF: "IRLTLT01CHM156N",
  AUD: "IRLTLT01AUM156N",
  NZD: "IRLTLT01NZM156N",
  CAD: "IRLTLT01CAM156N",
};

// ---------------------------------------------------------------------------
// 3. NEWS SOURCES — free RSS, no scraping of paywalled/ToS-restricted sites
// ---------------------------------------------------------------------------
const NEWS_FEEDS = [
  // General market/forex news — mentions multiple currencies, good for
  // broad sentiment sweeps
  {
    name: "Investing.com Forex News",
    url: "https://www.investing.com/rss/news_1.rss",
  },
  { name: "FXStreet News", url: "https://www.fxstreet.com/rss/news" },
  // Central bank press releases — high-signal, low-noise, free RSS
  {
    name: "ECB Press Releases",
    url: "https://www.ecb.europa.eu/rss/press.html",
  },
  { name: "BoE News", url: "https://www.bankofengland.co.uk/rss/news" },
  {
    name: "RBA Media Releases",
    url: "https://www.rba.gov.au/rss/rss-cb-media-releases.xml",
  },
];

// Keywords used to roughly tag a headline to a currency before scoring.
// This is intentionally simple — the LLM does the real sentiment judgment,
// this just avoids feeding totally irrelevant headlines into the per-currency batch.
const CURRENCY_KEYWORDS = {
  USD: ["federal reserve", "fed ", "fomc", "u.s. dollar", "usd", "powell"],
  EUR: [
    "ecb",
    "european central bank",
    "eurozone",
    "euro area",
    "lagarde",
    "eur",
  ],
  GBP: ["bank of england", "boe", "sterling", "pound", "gbp", "bailey"],
  JPY: ["bank of japan", "boj", "yen", "jpy", "ueda"],
  CHF: ["swiss national bank", "snb", "franc", "chf"],
  AUD: ["reserve bank of australia", "rba", "aussie", "aud"],
  NZD: ["reserve bank of new zealand", "rbnz", "kiwi", "nzd"],
  CAD: ["bank of canada", "boc", "loonie", "cad"],
};

// ---------------------------------------------------------------------------
// 4. COMPOSITE SCORE WEIGHTS — tune these after backtesting, don't guess-and-forget
// ---------------------------------------------------------------------------
const SCORE_WEIGHTS = {
  technical: 0.5, // price-action based CSI (OANDA candles)
  fundamental: 0.3, // policy rate + long yield z-scores (FRED)
  sentiment: 0.2, // LLM-scored news sentiment (Groq)
};

// ---------------------------------------------------------------------------
// 5. MISC CONFIG
// ---------------------------------------------------------------------------
const OANDA = {
  apiKey: process.env.OANDA_API_KEY,
  accountId: process.env.OANDA_ACCOUNT_ID,
  baseUrl: "https://api-fxtrade.oanda.com",
  // timeframes used for the technical layer — blend short + long for stability
  granularities: ["H1", "H4", "D"],
  candleCount: 50,
};

const FRED = {
  apiKey: process.env.FRED_API_KEY,
  baseUrl: "https://api.stlouisfed.org/fred/series/observations",
};

const GROQ = {
  apiKey: process.env.GROQ_API_KEY,
  model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
};

const MONGO_URI =
  process.env.MONGO_URL || "mongodb://localhost:27017/forex_strength";

module.exports = {
  FOREX_PAIRS,
  STRENGTH_PAIRS,
  CURRENCIES,
  FRED_POLICY_RATE_SERIES,
  FRED_LONG_YIELD_SERIES,
  NEWS_FEEDS,
  CURRENCY_KEYWORDS,
  SCORE_WEIGHTS,
  OANDA,
  FRED,
  GROQ,
  MONGO_URI,
};
