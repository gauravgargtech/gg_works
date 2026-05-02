require("../config/config");

const { get } = require("../adapters/redis");
const { fetchSignals } = require("./forex_ema_macd");

const startBenchMark = async () => {
  const allSymbols = await fetchSignals();
  for (const currency of allSymbols) {
    const fromCache = await get(`${currency}_signals`);
    calcuateProfitLoss(currency, JSON.parse(fromCache));
  }
};

const calcuateProfitLoss = (currency, signals) => {
  let capital = 1;

  for (let i = 0; i < signals.length - 1; i++) {
    const current = signals[i];
    const next = signals[i + 1];

    const entry = parseFloat(current.close);
    const exit = parseFloat(next.close);

    let ret = 0;

    if (current.label === "BUY") {
      ret = (exit - entry) / entry; // long
    } else if (current.label === "SELL") {
      ret = (entry - exit) / entry; // short
    }

    capital *= 1 + ret;
  }

  console.log(`Capital for Currency ${currency} is : ${capital}`);
};

startBenchMark();
