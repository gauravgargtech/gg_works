require("../config/config");
const RabbitMQ = require("../adapters/rabbitmq");

const {
  closeAllBTCPositions,
  placeOrderBTC,
  getAllActivePositions,
} = require("../exhanges/bybit_demo_10k");

const mq = new RabbitMQ({});

mq.consume("bybit_orders_10k_demo", async (message) => {
  try {
    console.log("Received:", message);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    console.log("Bybit Demo - Capital Orders Subscriber");

    const symbol = message?.symbol ?? "";

    const price = message?.price ?? "";

    if (price > 20) return;

    //if (price < 0.5) return;

    if (!symbol) return;

    const placeNew = message?.placeNew;

    try {
      const activePositions = await getAllActivePositions();
      if (activePositions && activePositions.length > 15) {
        console.log("Maximum number of active positions reached.");
        return;
      }
    } catch (err) {
      console.error("Error fetching active positions: ", err);
    }

    try {
      await closeAllBTCPositions(symbol);
    } catch (err) {
      console.log("Error in closing capital positions");
      throw err;
    }

    if (placeNew) {
      await placeOrderBTC(message.direction === "buy" ? "BUY" : "SELL", symbol);
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
