require("../config/config");
const RabbitMQ = require("../adapters/rabbitmq");

const {
  placeTakeProfitOrders,
  getCurrentPrice,
} = require("../exhanges/capital_demo");

const { del } = require("../adapters/redis");
const mq = new RabbitMQ({});

mq.consume("partials_capital", async (message) => {
  try {
    console.log("Received:", message);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    console.log("Capital Partial Order Subscriber");

    const symbol = message?.symbol ?? "";
    const epic = message?.symbol.replace("_", "");

    if (!symbol) return;

    try {
      const currentPrice = await getCurrentPrice(epic);
      const currentPriceForTP =
        message.direction.toUpperCase() === "BUY"
          ? currentPrice.bid
          : currentPrice.offer;

      const pipSize = 10 ** -currentPrice.pipPosition;

      let TP1;
      let TP2;
      if (message.direction.toUpperCase() === "BUY") {
        TP1 = currentPriceForTP + pipSize * 50;
        TP2 = currentPriceForTP + pipSize * 90;
      } else {
        TP1 = currentPriceForTP - pipSize * 50;
        TP2 = currentPriceForTP - pipSize * 90;
      }

      await placeTakeProfitOrders({
        epic: symbol.replace("_", ""),
        direction: message.direction,
        takeProfits: [
          {
            size: 200,
            level: TP1,
          },
          {
            size: 200,
            level: TP2,
          },
        ],
      });
      console.log("TP placing done");
    } catch (err) {
      console.log("Error in closing capital positions");
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
