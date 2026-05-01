require("../config/config");
var { set } = require("../adapters/redis");
const { getInstruments } = require("../exhanges/oanda");
const cron = require("node-cron");

const getData = async () => {
  const instruments = await getInstruments();

  for (const inst of instruments) {
    const tickSize = parseFloat(`1e-${inst.displayPrecision}`);

    await set(inst.name, {
      symbol: inst.name, // "EUR_USD"
      displayDigits: inst.displayPrecision, // 5
      pipLocation: inst.pipLocation, // -4 (i.e. 4th decimal is the pip)
      tickSize, // 0.00001
      minTradeSize: inst.minimumTradeSize,
      marginRate: inst.marginRate,
    });
  }
  return;
};

cron.schedule("0 0 */4 * * *", async () => {
  console.log("Refresh Instruments Data every 4 hours");
  await getData();
});
