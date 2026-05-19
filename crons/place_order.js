require("../config/config");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { sendSignalAlert } = require("../config/telegram_notify");
dayjs.extend(utc);
dayjs.extend(timezone);

const { findAndSort } = require("../adapters/mongo");

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const scanMongoAndFindSignals = async () => {
  const instruments = Object.keys(FOREX_PAIRS_CONFIG);

  const signals = [];

  await sleep(5);

  for (const inst of instruments) {
    console.log(`Fetching for ${inst}`);
    const data = await findAndSort(
      "signals",
      {
        instrument: inst,
      },
      { timestamp: -1 },
      1,
    );

    await sleep(1);
    if (data.length > 0) {
      signals.push(data[0]);
    }
  }

  if (signals.length === 0) {
    console.log("No signals found");
    return [];
  }

  const currentTime = dayjs().tz("Australia/Brisbane");
  for (const signal of signals) {
    const signalTime = dayjs.unix(signal.unixTimestamp).tz(BRISBANE_TZ);
    const now = dayjs().tz(BRISBANE_TZ);

    const timeDtff = now.diff(signalTime, "minute");

    console.log(
      `Diff for symbol ${signal.instrument} is ${timeDtff}, signal was at ${signal.timestamp}, at price ${signal.close}`,
    );

    if (timeDtff < 3) {
      await sendSignalAlert(signal.signal, signal.instrument, signal.close, {
        signal_time: signal.timestamp,
        source: "best_at_5_minute",
      });
    }
  }

  return true;
};

module.exports = scanMongoAndFindSignals;
