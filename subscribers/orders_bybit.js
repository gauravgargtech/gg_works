require("../config/config");
const RabbitMQ = require("../adapters/rabbitmq");

const { closeAllBTCPositions, placeOrderBTC } = require("../exhanges/bybit");

const { del } = require("../adapters/redis");
const mq = new RabbitMQ({});

mq.consume("bybit_orders", async (message) => {
  try {
    console.log("Received:", message);
    //await new Promise((resolve) => setTimeout(resolve, 10000));

    console.log("Capital Orders Subscriber");

    const symbol = message?.symbol ?? "";

    const price = message?.price ?? "";

    if (price > 10) return;

    if (price < 0.5) return;

    if (!symbol) return;

    const onlyClose = message?.onlyClose;
    const placeNew = message?.placeNew;

    try {
      await closeAllBTCPositions(symbol);
    } catch (err) {
      console.log("Error in closing capital positions");
      throw err;
    }

    try {
      if (placeNew) {
        await placeOrderBTC(
          message.direction === "buy" ? "BUY" : "SELL",
          symbol,
        );
      }
    } catch (err) {
      throw err;
    }
    console.log("Order place is done");
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
