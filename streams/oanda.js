const https = require("https");
require("../config/config");

const API_KEY = process.env.OANDA_API_KEY;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const { set } = require("../adapters/redis");
const INSTRUMENT = process.env.OANDA_SYMBOL;

const PRACTICE = true;
const BASE_URL = PRACTICE
  ? "stream-fxpractice.oanda.com"
  : "stream-fxtrade.oanda.com";

// OANDA streaming endpoint
const options = {
  hostname: BASE_URL, // use  for live
  path: `/v3/accounts/${ACCOUNT_ID}/pricing/stream?instruments=${INSTRUMENT}`,
  method: "GET",
  headers: {
    Authorization: `Bearer ${API_KEY}`,
  },
};

function startStream() {
  console.log("Connecting to OANDA price stream...");

  const req = https.request(options, (res) => {
    res.setEncoding("utf8");

    let buffer = "";

    res.on("data", async (chunk) => {
      buffer += chunk;

      // OANDA sends newline-delimited JSON
      let lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line

      for (let line of lines) {
        if (!line.trim()) continue;

        try {
          const data = JSON.parse(line);

          // Ignore heartbeats
          if (data.type === "HEARTBEAT") return;

          if (data.type === "PRICE") {
            const bid = parseFloat(data.bids?.[0]?.price);
            const ask = parseFloat(data.asks?.[0]?.price);
            const midPrice = parseFloat((bid + ask) / 2);

            await set(`${INSTRUMENT}_price`, midPrice, 30);

            console.log(
              `Bid: ${bid} Ask: ${ask} MidPrice: ${midPrice} Time: ${data.time}`,
            );
          }
        } catch (err) {
          console.error("Parse error:", err.message);
        }
      }
    });

    res.on("end", () => {
      console.log("Stream ended. Reconnecting...");
      setTimeout(startStream, 2000); // auto-reconnect
    });
  });

  req.on("error", (err) => {
    console.error("Connection error:", err.message);
    setTimeout(startStream, 2000);
  });

  req.end();
}

startStream();
