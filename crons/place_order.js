require("../config/config");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { sendSignalAlert, sendPushNotif } = require("../config/telegram_notify");
dayjs.extend(utc);
dayjs.extend(timezone);

const { findAndSort } = require("../adapters/mongo");
const { del, set } = require("../adapters/redis");

const {
  getPositions,
  placeOrder,
  closePositions,
} = require("../exhanges/oanda");

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const scanMongoAndFindSignals = async () => {
  try {
    const instruments = Object.keys(FOREX_PAIRS_CONFIG);

    const now = dayjs().tz("Australia/Brisbane");
    const day = now.day(); // 0 Sun - 6 Sat
    const hour = now.hour();
    console.log(`Day is ${day} and hour is ${hour}`);

    let isWeekend = false;
    // Saturday after 4am
    if (day === 6 && hour >= 4) {
      isWeekend = true;
    }
    // Sunday full day
    if (day === 0) {
      isWeekend = true;
    }
    // Monday before 11am Brisbane Time
    if (day === 1 && hour < 11) {
      isWeekend = true;
    }

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
      await sleep(1);
      const signalTime = dayjs.unix(signal.unixTimestamp).tz(BRISBANE_TZ);
      const now = dayjs().tz(BRISBANE_TZ);

      const timeDtff = now.diff(signalTime, "minute");

      console.log(
        `Diff for symbol ${signal.instrument} is ${timeDtff}, signal was at ${signal.timestamp}, at price ${signal.close}`,
      );

      if (timeDtff > 0 && timeDtff < 3) {
        await sendSignalAlert(signal.signal, signal.instrument, signal.close, {
          signal_time: signal.timestamp,
          source: "best_at_5_minute",
        });

        if (isWeekend) {
          console.log("Weekend detected, cant place orders !!!");
          continue;
        }

        if (
          TRADING_ALLOWED_PAIRS.includes(signal.instrument) &&
          signal.compressed === false
        ) {
          await sleep(1);

          await del(`${signal.instrument}_limit_orders`);

          const positions = await getPositions(signal.instrument);
          console.log("--lets check positions");
          console.log(positions.length);

          if (positions.length > 0) {
            console.log("--lets close positions");
            console.log(positions);
            await closePositions(positions, signal.instrument);
          }

          const mt5Symbol = signal.instrument.replace("_", "") + ".";

          console.log("MT5 symbol:", mt5Symbol);

          if (signal.signal === "BUY" || signal.signal === "LONG") {
            await set(`mt5:pending_command:${mt5Symbol}`, {
              action: "replace",
              direction: "buy",
              symbol: mt5Symbol,
            });
            await placeOrder("buy", signal.instrument);
          } else if (signal.signal === "SELL" || signal.signal === "SHORT") {
            await set(`mt5:pending_command:${mt5Symbol}`, {
              action: "replace",
              direction: "sell",
              symbol: mt5Symbol,
            });
            await placeOrder("short", signal.instrument);
          }

          await sendPushNotif("Order placed for " + signal.instrument);
        } else if (
          TRADING_ALLOWED_PAIRS.includes(signal.instrument) &&
          signal.compressed === true
        ) {
          const mt5Symbol = signal.instrument.replace("_", "") + ".";

          await set(`mt5:pending_command:${mainSymbol}`, {
            action: "closeall",
            mainSymbol,
          });
          await sendPushNotif(
            `Compressed signal detected for ${signal.instrument}, closing its orders `,
          );
        } else {
          await sendPushNotif(
            `Signal detected for ${signal.instrument}, but not allowed to trade`,
          );
        }
      }
    }
  } catch (error) {
    console.error("Error in Placing order:", error.message);
    console.error("Error in Placing order:", error);
    await sendPushNotif("Error in Placing Order: " + error.message);
  }

  return true;
};

module.exports = scanMongoAndFindSignals;
