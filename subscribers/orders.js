require("../config/config");
const RabbitMQ = require("../adapters/rabbitmq");
const {
  getInstruments,
  placeOrder,
  closePositions,
  getPositions,
} = require("../exhanges/oanda_demo");

const mq = new RabbitMQ({});

mq.consume("orders", async (message) => {
  try {
    console.log("Received:", message);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const symbol = message?.symbol ?? "";

    if (!symbol) return;

    const onlyClose = message?.onlyClose;
    const placeNew = message?.placeNew;

    try {
      const positions = await getPositions(symbol);
      if (positions.length > 0) {
        await closePositions(positions, symbol);
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
