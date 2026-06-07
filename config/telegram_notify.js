require("../config/config");
const process = require("process");
const TelegramBot = require("node-telegram-bot-api");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const axios = require("axios");

const { insert } = require("../adapters/mongo");

//const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
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
  "GBP_PLN",
  "EUR_CHF",
  "BTCUSDT",
];

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

function escapeMarkdownV2(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

const sendPushNotif = async (message) => {
  try {
    await insert("push_notif", {
      message,
      time: dayjs().tz("Australia/Brisbane").format("YYYY-MM-DD HH:mm:ss"),
      timestamp: dayjs().tz("Australia/Brisbane").unix(),
    });
  } catch (error) {
    console.error("Error saving signal alert:", error);
  }
  try {
    const resp = await axios.post("https://api.pushover.net/1/messages.json", {
      token: process.env.PUSHOVER_TOKEN,
      user: process.env.PUSHOVER_KEY,
      message: message,
      title: "GGWorks Bot",
    });
    console.log("Pushover response:");
    console.log(resp.data);
  } catch (error) {
    console.error("Error sending signal alert:", error);
  }
  return;
};

/**
 * @param {'BUY' | 'SELL'} signal
 * @param {string} symbol  e.g. 'BTC/USDT'
 * @param {number} price
 * @param {object} extras  any extra fields you want included
 */
async function sendSignalAlert(signal, symbol, price, extras = {}) {
  if (badPairs.includes(symbol)) {
    //return;
  }

  const env = process.env.NODE_ENV ?? "dev";

  if (env === "dev") {
    return;
  }

  console.log("Sending signal alert...");
  try {
    const emoji = signal.indexOf("BUY") !== -1 ? "🟢" : "🔴";
    const lines = [
      `${emoji} ${signal.replaceAll("_", "")} Signal — ${symbol.replaceAll("_", "")}`,
      `💰 Price: ${price}`,
    ];

    console.log(extras);
    console.log(lines);

    for (const [key, val] of Object.entries(extras)) {
      lines.push(`📊 ${key}: ${val}`);
    }

    const message = lines.join("\n");
    try {
      await sendPushNotif(message);
    } catch (error) {
      console.log("Error sending pushover", error);
    }

    console.log(message);

    await sleep(1);

    const resp = await bot.sendMessage(CHAT_ID, message, {
      parse_mode: "HTML",
    });

    console.log("Telegram response:");
    console.log(resp);
  } catch (error) {
    console.error("Error sending signal alert:", error);
  }
}

module.exports = { sendSignalAlert, sendPushNotif };
