const process = require("process");

global.BRISBANE_TZ = "Australia/Brisbane";

global.FOREX_PAIRS_GOOD = ["XAU_USD", "BTC_USD"];

global.FOREX_PAIRS_EXT = [
  // ===== MAJORS (USD on one side) =====
  "EUR_USD", // TIER1 | Tight spread | High liquidity | Best overall
  "GBP_USD", // TIER1 | London/NY | Medium-High volatility | Strong trends
  "AUD_USD", // TIER1 | Asia/London | Medium volatility | Commodity correlation
  //  "NZD_USD", // TIER1 | Asia/NY | BAD, very choppy
  "USD_JPY", // TIER1 | Asia/London/NY | High liquidity | Risk sentiment
  //"USD_CHF", // TIER1 | London/NY | Safe haven | USD/CHF inverse EUR exposure
  "USD_CAD", // TIER1 | NY | Medium volatility | Oil correlation

  // ===== JPY CROSSES (Higher volatility) =====
  "EUR_JPY", // TIER2 | London/NY | High volatility | Good momentum
  "GBP_JPY", // TIER2 | London/NY | Very High volatility | Excellent momentum
  "AUD_JPY", // TIER2 | Asia/London | High volatility | Risk-on/risk-off
  "NZD_JPY", // TIER2 | Asia/London | High volatility | Carry/risk sentiment

  // ===== HIGH-VOLATILITY CROSSES =====
  //"GBP_AUD", // TIER2 | London/Asia | High volatility | Strong momentum
  "GBP_CAD", // TIER2 | London/NY | High volatility | GBP vs oil-sensitive CAD
  "GBP_NZD", // TIER2 | London/Asia | High volatility | Large ATR movements

  // ===== COMMODITIES =====
  "GOLD", // GOLD | High volatility | Strong trend potential | Safe haven
  //"XAG_USD", // SILVER | High volatility | More volatile than gold | Commodity

  // ===== CRYPTO =====
  "BTCUSD", // CRYPTO | Very High volatility | 24/7 | Strong momentum

  // ===== LOWER PRIORITY / WATCHLIST =====
  //"EUR_GBP", // Lower volatility | London | Better for range/mean-reversion
  "CHF_JPY", // Higher volatility | Safe haven vs risk
  "CAD_JPY", // Oil + JPY/risk sentiment
  //"AUD_NZD", // Low-Medium volatility | Often range-bound
];

global.FOREX_PAIRS = [
  // ===== MAJORS (USD on one side) =====
  "EUR_USD", // TIER1 | Tight spread | High liquidity | Best overall
  "GBP_USD", // TIER1 | London/NY | Medium-High volatility | Strong trends
  "AUD_USD", // TIER1 | Asia/London | Medium volatility | Commodity correlation
  //  "NZD_USD", // TIER1 | Asia/NY | BAD, very choppy
  "USD_JPY", // TIER1 | Asia/London/NY | High liquidity | Risk sentiment
  //"USD_CHF", // TIER1 | London/NY | Safe haven | USD/CHF inverse EUR exposure
  "USD_CAD", // TIER1 | NY | Medium volatility | Oil correlation

  // ===== JPY CROSSES (Higher volatility) =====
  "EUR_JPY", // TIER2 | London/NY | High volatility | Good momentum
  "GBP_JPY", // TIER2 | London/NY | Very High volatility | Excellent momentum
  "AUD_JPY", // TIER2 | Asia/London | High volatility | Risk-on/risk-off
  "NZD_JPY", // TIER2 | Asia/London | High volatility | Carry/risk sentiment

  // ===== HIGH-VOLATILITY CROSSES =====
  //"GBP_AUD", // TIER2 | London/Asia | High volatility | Strong momentum
  "GBP_CAD", // TIER2 | London/NY | High volatility | GBP vs oil-sensitive CAD
  "GBP_NZD", // TIER2 | London/Asia | High volatility | Large ATR movements

  // ===== COMMODITIES =====
  //"XAU_USD", // GOLD | High volatility | Strong trend potential | Safe haven
  //"XAG_USD", // SILVER | High volatility | More volatile than gold | Commodity

  // ===== CRYPTO =====
  //"BTC_USD", // CRYPTO | Very High volatility | 24/7 | Strong momentum

  // ===== LOWER PRIORITY / WATCHLIST =====
  //"EUR_GBP", // Lower volatility | London | Better for range/mean-reversion
  "CHF_JPY", // Higher volatility | Safe haven vs risk
  "CAD_JPY", // Oil + JPY/risk sentiment
  //"AUD_NZD", // Low-Medium volatility | Often range-bound
];

global.TRADING_ALLOWED_PAIRS = [
  "NZD_USD",
  "USD_JPY",
  "USD_CAD",
  "AUD_USD",
  "GBP_USD",
];

global.TRADING_ALLOWED_PAIRS_WEBMASTER = [
  "AUD_USD",
  "USD_CAD",
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
  BCO_USD: {
    utKeyValue: 19,
    utAtrPeriod: 3,
    granularity: "M5",
  },
};

global.TRADING_ALLOWED_PAIRS_CONFIG = {
  AUD_USD: {
    quantity: 1000,
  },
  EUR_USD: {
    quantity: 1000,
  },
  GBP_USD: {
    quantity: 1000,
  },
  AUD_NZD: {
    quantity: 1000,
  },
  USD_JPY: {
    quantity: 1000,
  },
  USD_CAD: {
    quantity: 1000,
  },
  NZD_USD: {
    quantity: 1000,
  },
  EUR_AUD: {
    quantity: 1000,
  },
  AUD_CAD: {
    quantity: 1000,
  },
  EUR_CAD: {
    quantity: 1000,
  },
  EUR_NZD: {
    quantity: 1000,
  },
  GBP_AUD: {
    quantity: 1000,
  },
  GBP_CAD: {
    quantity: 1000,
  },
  GBP_NZD: {
    quantity: 700,
  },
  NZD_CAD: {
    quantity: 1000,
  },
  AUD_JPY: {
    quantity: 1000,
  },
};

global.LOT_SIZE = 1000;
global.TP_PIPS = [13, 25, 35, 50];

//Brisbane time
const ORB_CONFIG = {
  NZD_USD: { start: "08:00", end: "08:15" },
  AUD_USD: { start: "08:00", end: "08:15" },
  AUD_NZD: { start: "08:00", end: "08:15" },

  EUR_USD: { start: "17:00", end: "17:15" },
  GBP_USD: { start: "17:00", end: "17:15" },

  USD_JPY: { start: "10:00", end: "10:15" },

  USD_CAD: { start: "23:30", end: "23:45" },
};

global.exit = (whatever) => {
  console.log(whatever);
  process.exit(1);
};

global.CRYPTO_PAIRS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "TRXUSDT",
  "TONUSDT",
  "AVAXUSDT",

  "LINKUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "ATOMUSDT",
  "NEARUSDT",
  "FILUSDT",
  "ICPUSDT",
  "ETCUSDT",
  "APTUSDT",

  "ARBUSDT",
  "OPUSDT",
  "SUIUSDT",
  "SEIUSDT",
  "INJUSDT",
  "TAOUSDT",
  "IMXUSDT",
  "STXUSDT",
  "GRTUSDT",

  "AAVEUSDT",
  "SNXUSDT",
  "COMPUSDT",
  "LDOUSDT",
  "SUSHIUSDT",
  "DYDXUSDT",
  "UNIUSDT",
  "1INCHUSDT",

  "GMXUSDT",
  "RUNEUSDT",
  "FLUXUSDT",
  "JUPUSDT",
  "WIFUSDT",

  "AKTUSDT",
  "NMRUSDT",

  "MANAUSDT",
  "SANDUSDT",
  "GALAUSDT",
  "ENJUSDT",
  "ILVUSDT",
  "BLURUSDT",

  "BRETTUSDT",
  "MEWUSDT",

  "WLDUSDT",
  "PYTHUSDT",
  "JTOUSDT",
  "STRKUSDT",
  "TIAUSDT",
  "ONDOUSDT",
  "ZKUSDT",
  "ALTUSDT",
  "MEMEUSDT",
];
