require("../config/config");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { insert, find } = require("../adapters/mongo");
const cron = require("node-cron");
const { sendEmail } = require("../common/email");
const redis = require("../adapters/redis");
const { sendSignalAlert } = require("../config/telegram_notify");

dayjs.extend(utc);
dayjs.extend(timezone);

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const scanSignalsAndSendNotis = async () => {
  const theTime = dayjs()
    .tz("Australia/Brisbane")
    .subtract(15, "minute")
    .format();
  console.log(theTime);

  const signals = await find("signals", {
    timestamp: {
      $gte: dayjs(theTime).unix(),
    },
  });

  if (signals.length === 0) {
    console.log("No signals found");
    return;
  }

  const found = signals.map((s) => {
    return {
      symbol: s.symbol,
      signal: s.label,
      time: s.time,
      price: s.close,
    };
  });

  console.log(found);

  try {
    await sendEmail(
      `Forex - New signals found on ${dayjs().tz("Australia/Brisbane").format("YYYY-MM-DD hh:ii:ss")}`,
      JSON.stringify(found),
    );
  } catch (error) {
    console.log(error);
  }
  for (const signal of found) {
    await sendSignalAlert(signal.symbol, signal.signal, signal.price, {
      time: signal.time,
      type: "scan_and_send",
    });
    await redis.del(`momentum_${signal.symbol}`);
    await sleep(1);
  }
  return found;
};

module.exports = scanSignalsAndSendNotis;
