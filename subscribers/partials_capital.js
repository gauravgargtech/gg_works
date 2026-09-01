require("../config/config");
const RabbitMQ = require("../adapters/rabbitmq");

const {
  placeTakeProfitOrders,
  getCurrentPrice,
  deleteWorkingOrdersForEpic,
} = require("../exhanges/capital_demo");

const { del } = require("../adapters/redis");
const mq = new RabbitMQ({});

mq.consume("partials_capital", async (message) => {
  try {
    console.log("Received:", message);
    await new Promise((resolve) => setTimeout(resolve, 60000));

    console.log("Capital Partial Order Subscriber");

    const symbol = message?.symbol ?? "";
    const epic = message?.symbol.replace("_", "");

    if (!symbol) return;

    try {
      const workingOrders = await deleteWorkingOrdersForEpic(epic);
      console.log(`Closed these orders: ${workingOrders}`);
    } catch (err) {
      console.log("Error in closing capital working positions");
      throw err;
    }

    try {
      const currentPrice = await getCurrentPrice(epic);
      const currentPriceForTP =
        message.direction.toUpperCase() === "BUY"
          ? currentPrice.bid
          : currentPrice.offer;

      const pipSize = 10 ** -currentPrice.pipPosition;

      //let TP1 = message.tp1;
      //let TP2;

      let TP1At = 50;
      let TP2At = 80;
      if (symbol !== "GOLD") {
        let TP1At = 80;
        let TP2At = 140;
      }

      let TP1;

      if (message.direction.toUpperCase() === "BUY") {
        TP1 = currentPriceForTP + pipSize * TP1At;
        TP2 = currentPriceForTP + pipSize * TP2At;
      } else {
        TP1 = currentPriceForTP - pipSize * TP1At;
        TP2 = currentPriceForTP - pipSize * TP2At;
      }

      let theSize1 = 300;
      //let theSize2 = 200;

      if (symbol === "GOLD") {
        theSize1 = 0.2;
        //theSize2 = 0.1;
      }

      await placeTakeProfitOrders({
        epic: symbol.replace("_", ""),
        direction: message.direction,
        takeProfits: [
          {
            size: theSize1,
            level: TP1,
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
