require("../config/config");
const RabbitMQ = require("../adapters/rabbitmq");

const {
  placeOrder: placeCapitalOrder,
  closePositions: closeCapitalPositions,
  getPositionsByEpic,
  placeTakeProfitOrders,
  getCurrentPrice,
  getWorkingOrders,
  deleteWorkingOrdersForEpic,
} = require("../exhanges/capital_demo");

const { del } = require("../adapters/redis");
const mq = new RabbitMQ({});

mq.consume("orders_capital", async (message) => {
  try {
    console.log("Received:", message);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    console.log("Capital Orders Subscriber");

    const symbol = message?.symbol ?? "";

    if (!symbol) return;

    const epic = symbol.replace("_", "");

    const onlyClose = message?.onlyClose;
    const placeNew = message?.placeNew;

    try {
      await closeCapitalPositions({
        epic: epic,
        full: true,
      });
    } catch (err) {
      console.log("Error in closing capital positions");
      throw err;
    }

    try {
      const workingOrders = await deleteWorkingOrdersForEpic(epic);
      console.log(`Closed these orders: ${workingOrders}`);
    } catch (err) {
      console.log("Error in closing capital working positions");
      throw err;
    }
    try {
      let theSize = 600;
      if (symbol === "GOLD") {
        theSize = 0.4;
      }
      if (placeNew) {
        await placeCapitalOrder({
          epic: epic,
          direction: message.direction === "buy" ? "BUY" : "SELL",
          size: theSize,
        });

        await mq.publish("partials", {
          direction: message.direction === "buy" ? "BUY" : "SELL",
          symbol: symbol.replace("_", ""),
        });
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
