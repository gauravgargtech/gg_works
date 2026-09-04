require("../config/config");

const RabbitMQ = require("../adapters/rabbitmq");

const dayjs = require("dayjs");

const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const { sendPushNotif } = require("../config/telegram_notify");

const { getAllActivePositions } = require("../exhanges/bybit");

const { getOpenPositions } = require("../exhanges/capital_demo");

const marketCloser = async () => {
  const now = dayjs().tz("Australia/Brisbane");
  const day = now.day(); // 0 Sun - 6 Sat

  if (day !== 6) {
    return;
  }

  const rabbit = RabbitMQ.getInstance();

  try {
    const activePositions = await getAllActivePositions();
    for (const position of activePositions) {
      const symbol = position.symbol;

      await rabbit.publish("crypto_orders", {
        direction: position.side.toLowerCase(),
        symbol: symbol,
        price: 1,
        onlyClose: true,
        placeNew: false,
      });
    }
  } catch (error) {
    console.error("Error in marketCloser Crypto:", error);
    await sendPushNotif(`Error in marketCloser Crypto: ${error.message}`);
  }

  try {
    const activePositions = await getOpenPositions();
    for (const position of activePositions) {
      const symbol = position.symbol;

      await rabbit.publish("orders", {
        direction: position.side.toLowerCase(),
        symbol: symbol,
        price: 1,
        onlyClose: true,
        placeNew: false,
      });
    }
  } catch (error) {
    console.error("Error in marketCloser Capital:", error);
    await sendPushNotif(`Error in marketCloser Capital: ${error.message}`);
  }
};

module.exports = marketCloser;
