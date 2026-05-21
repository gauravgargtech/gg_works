const process = require("process");

global.BRISBANE_TZ = "Australia/Brisbane";

global.FOREX_PAIRS = [
  // ===== MAJORS (USD on one side) - Tightest spreads, highest liquidity =====
  "EUR_USD", // TIER1 | Spread: 0.1-0.5 | Session: All | Volatility: Low | Best for: Scalping, beginners
  "GBP_USD", // TIER1 | Spread: 0.5-1.0 | Session: London/NY | Volatility: Medium | Best for: Trend following
  "AUD_USD", // TIER1 | Spread: 0.3-0.8 | Session: Asia/London | Volatility: Medium | Correlation: Gold, Iron ore
  "NZD_USD", // TIER1 | Spread: 0.5-1.2 | Session: Asia/NY | Volatility: Medium | Correlation: Dairy, weaker AUD cousin
  "USD_JPY", // TIER1 | Spread: 0.1-0.4 | Session: Asia/London | Volatility: Low | Best for: Risk sentiment, BoJ policy
  "USD_CHF", // TIER1 | Spread: 0.5-1.5 | Session: London/NY | Volatility: Low | Correlation: Inverse EUR/USD, safe haven
  "USD_CAD", // TIER1 | Spread: 0.5-1.2 | Session: NY | Volatility: Medium | Correlation: Oil price (WTI)

  // ===== CROSSES with JPY (High volatility, larger ranges) =====
  "EUR_JPY", // TIER2 | Spread: 0.8-1.8 | Session: London/NY | Volatility: High | Best for: Breakout strategies
  "GBP_JPY", // TIER2 | Spread: 1.0-2.5 | Session: London/NY | Volatility: Very High | Best for: Momentum, "The Beast"
  "AUD_JPY", // TIER2 | Spread: 0.8-1.8 | Session: Asia/London | Volatility: High | Correlation: Equities (risk barometer)
  "CHF_JPY", // TIER2 | Spread: 1.0-2.0 | Session: Asia/London | Volatility: High | Best for: Mean reversion (safe vs risk)
  "CAD_JPY", // TIER2 | Spread: 1.0-2.2 | Session: Asia/NY | Volatility: High | Correlation: Oil + risk sentiment
  "NZD_JPY", // TIER3 | Spread: 1.2-2.5 | Session: Asia | Volatility: High | Correlation: Carry trade favorite

  // ===== CROSSES without JPY (Slower, choppier, wider spreads) =====
  "EUR_GBP", // NOT IN LIST | Spread: 0.5-1.0 | Session: London | Volatility: Low | Best for: Range trading, mean reversion

  // ===== MINOR CROSSES (Widest spreads, trade only with experience) =====
  "AUD_CAD", // TIER3 | Spread: 1.5-3.0 | Session: Asia/NY | Volatility: Medium | Correlation: Commodity currencies
  "AUD_CHF", // TIER3 | Spread: 1.8-3.5 | Session: Asia/London | Volatility: Medium | Best for: Risk-off hedging
  "AUD_NZD", // TIER3 | Spread: 1.5-3.0 | Session: Asia | Volatility: Low-Medium | Correlation: Trans-Tasman, tight range
  "CAD_CHF", // TIER3 | Spread: 2.0-4.0 | Session: NY/London | Volatility: Medium | Best for: Oil vs safe haven
  "EUR_AUD", // TIER3 | Spread: 1.5-3.0 | Session: London/Asia | Volatility: Medium | Best for: Euro vs commodity
  "EUR_CAD", // TIER3 | Spread: 1.8-3.5 | Session: London/NY | Volatility: Medium | Correlation: Euro vs oil
  "EUR_CHF", // TIER3 | Spread: 1.5-2.5 | Session: London | Volatility: Low | Best for: SNB intervention plays
  "EUR_NZD", // TIER3 | Spread: 2.0-4.0 | Session: London/Asia | Volatility: Medium-High | Best for: Euro vs commodity
  "GBP_AUD", // TIER3 | Spread: 2.0-4.0 | Session: London/Asia | Volatility: High | Best for: Pound vs commodity
  "GBP_CAD", // TIER3 | Spread: 2.0-4.0 | Session: London/NY | Volatility: High | Correlation: Pound vs oil
  "GBP_CHF", // TIER3 | Spread: 2.0-3.5 | Session: London | Volatility: Medium-High | Best for: Volatile cross
  "GBP_NZD", // TIER3 | Spread: 2.5-5.0 | Session: London/Asia | Volatility: High | Best for: Exotic-like movement
  "NZD_CAD", // TIER3 | Spread: 2.0-4.0 | Session: Asia/NY | Volatility: Medium | Correlation: Dairy vs oil
];

global.TRADING_ALLOWED_PAIRS = [
  "AUD_USD",
  "EUR_USD",
  "GBP_USD",
  "AUD_NZD",
  "USD_JPY",
  "NZD_USD",
  "USD_CAD",
  "AUD_CAD",
  "EUR_AUD",
  "EUR_CAD",
  "EUR_NZD",
  "GBP_AUD",
  "GBP_CAD",
  "GBP_NZD",
  "NZD_CAD",
  "AUD_JPY",
];

global.TRADING_ALLOWED_PAIRS_WEBMASTER = [
  "AUD_USD",
  "EUR_USD",
  "USD_CAD",
  "AUD_NZD",
  "GBP_USD",
  "USD_JPY",
  "NZD_USD",
];

global.FOREX_PAIRS_CONFIG = {
  AUD_USD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
  USD_CAD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
  EUR_USD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
  GBP_USD: {
    utKeyValue: 19,
    utAtrPeriod: 4,
    granularity: "M5",
  },
  USD_JPY: {
    utKeyValue: 19,
    utAtrPeriod: 4,
    granularity: "M5",
  },
  AUD_NZD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
  XAU_USD: {
    utKeyValue: 40,
    utAtrPeriod: 10,
    granularity: "M15",
  },
  WHEAT_USD: {
    utKeyValue: 40,
    utAtrPeriod: 5,
    granularity: "M15",
  },
  AUD_CAD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
  NZD_USD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
  EUR_AUD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
  EUR_CAD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
  EUR_NZD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
  GBP_AUD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
  GBP_CAD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
  GBP_NZD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
  NZD_CAD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
  AUD_HKD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
  AUD_JPY: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
};

global.TRADING_ALLOWED_PAIRS_CONFIG = {
  AUD_USD: {
    quantity: 600,
  },
  EUR_USD: {
    quantity: 600,
  },
  GBP_USD: {
    quantity: 600,
  },
  AUD_NZD: {
    quantity: 600,
  },
  USD_JPY: {
    quantity: 600,
  },
  USD_CAD: {
    quantity: 600,
  },
  NZD_USD: {
    quantity: 600,
  },
  EUR_AUD: {
    quantity: 600,
  },
  AUD_CAD: {
    quantity: 600,
  },
  EUR_CAD: {
    quantity: 600,
  },
  EUR_NZD: {
    quantity: 600,
  },
  GBP_AUD: {
    quantity: 600,
  },
  GBP_CAD: {
    quantity: 600,
  },
  GBP_NZD: {
    quantity: 400,
  },
  NZD_CAD: {
    quantity: 600,
  },
  AUD_JPY: {
    quantity: 600,
  },
};

global.LOT_SIZE = 600;
global.TP_PIPS = [13, 25, 35, 50];

global.exit = (whatever) => {
  console.log(whatever);
  process.exit(1);
};
