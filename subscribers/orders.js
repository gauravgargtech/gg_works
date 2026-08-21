require("../config/config");
const RabbitMQ = require("../adapters/rabbitmq");
const {
  getInstruments,
  placeOrder,
  closePositions,
  getPositions,
} = require("../exhanges/oanda_demo");

const {
  placeOrder: placeCapitalOrder,
  closePositions: closeCapitalPositions,
} = require("../exhanges/capital_demo");

const { del } = require("../adapters/redis");
const mq = new RabbitMQ({});

mq.consume("orders", async (message) => {
  try {
    console.log("Received:", message);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const symbol = message?.symbol ?? "";

    if (!symbol) return;

    await del(`is_first_25_taken_for_${symbol}`);
    await del(`is_first_50_taken_for_${symbol}`);

    const onlyClose = message?.onlyClose;
    const placeNew = message?.placeNew;

    try {
      const positions = await getPositions(symbol);
      if (positions.length > 0) {
        await closePositions(positions, symbol, true);
      }
    } catch (err) {
      console.log("Error in closing positions");
      throw err;
    }
    try {
      if (placeNew) {
        await placeOrder(message.direction, symbol, 500);
      }
    } catch (err) {
      throw err;
    }

    try {
      await closeCapitalPositions({
        epic: symbol.replace("_", ""),
        full: true,
      });
    } catch (err) {
      console.log("Error in closing capital positions");
      throw err;
    }
    try {
      if (placeNew) {
        await placeCapitalOrder({
          epic: symbol.replace("_", ""),
          direction: message.direction === "buy" ? "BUY" : "SELL",
          size: 500,
        });
      }
    } catch (err) {
      throw err;
    }
  } catch (error) {
    console.error("Error processing message:", error);
    throw error;
  }
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down subscriber...");
  await mq.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await mq.close();
  process.exit(0);
});
