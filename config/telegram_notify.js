require("../config/config");
const process = require("process");
const TelegramBot = require("node-telegram-bot-api");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const badPairs = [
  "USD_THB",
  "USD_ZAR",
  "ZAR_JPY",
  "GBP_HKD",
  "AUD_HKD",
  "GBP_SGD",
  "NZD_SGD",
  "GBP_ZAR",
  "EUR_SGD",
  "USD_SGD",
  "USD_NOK",
];

/**
 * @param {'BUY' | 'SELL'} signal
 * @param {string} symbol  e.g. 'BTC/USDT'
 * @param {number} price
 * @param {object} extras  any extra fields you want included
 */
async function sendSignalAlert(signal, symbol, price, extras = {}) {
  if (badPairs.includes(symbol)) {
    return;
  }

  const env = process.env.NODE_ENV ?? "dev";

  if (env === "dev") {
    return;
  }

  const emoji = signal === "BUY" ? "🟢" : "🔴";
  const lines = [
    `${emoji} *${signal} Signal — ${symbol}*`,
    `💰 Price: \`${price}\``,
    `⏰ Time: ${extras?.time ? extras.time : new Date().toUTCString()}`,
  ];

  for (const [key, val] of Object.entries(extras)) {
    lines.push(`📊 ${key}: \`${val}\``);
  }

  const message = lines.join("\n");

  await bot.sendMessage(CHAT_ID, message, { parse_mode: "Markdown" });
}

module.exports = { sendSignalAlert };
