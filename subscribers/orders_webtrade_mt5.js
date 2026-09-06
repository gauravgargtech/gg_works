require("../config/config");
const RabbitMQ = require("../adapters/rabbitmq");

const { set } = require("../adapters/redis");
const mq = new RabbitMQ({});

mq.consume("orders_webtrade_mt5", async (message) => {
  try {
    console.log("Received:", message);
    await new Promise((resolve) => setTimeout(resolve, 10000));

    console.log("Capital Orders Subscriber");

    const symbol = message?.symbol ?? "";

    if (!symbol) return;
    if (symbol.toLowerCase() === "gold") return;

    //|  Model: Redis/Express holds DESIRED STATE per pair                |
    //|         (BUY / SELL / CLOSE / NONE). This EA compares desired      |
    //|         state to actual open position and acts only on mismatch.  |
    //|         This makes BUY/SELL idempotent (safe to repeat every 3s)  |
    //|         and "replace/flip" happens automatically: if desired=BUY  |
    //|         and a SHORT is open, it closes the short then opens long. |

    const onlyClose = message?.onlyClose;
    const placeNew = message?.placeNew;

    let action = "NONE";
    if (placeNew) {
      action = message.direction === "buy" ? "BUY" : "SELL";
    } else {
      action = "CLOSE";
    }

    const signals = [];

    for (const s of FOREX_PAIRS) {
      if (s === symbol) {
        signals.push({
          symbol: s.replace("_", "") + ".",
          action: action,
          lots: 0,
          sl: 0,
          tp: 0,
        });
      } else {
        signals.push({
          symbol: s.replace("_", "") + ".",
          action: "NONE",
          lots: 0,
          sl: 0,
          tp: 0,
        });
      }
    }

    await set("forex_signals_webtrade_mt5", JSON.stringify(signals), 5);

    console.log("Redis set is done");
    return;
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
