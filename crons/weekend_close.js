require("../config/config");
const { closePositions, getPositions } = require("../exhanges/oanda");
const { closeAllBTCPositions } = require("../exhanges/bybit");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

const { set } = require("../adapters/redis");

dayjs.extend(utc);
dayjs.extend(timezone);

const sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const weekendClose = async () => {
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

  // Monday before 4am
  if (day === 1 && hour < 9) {
    isWeekend = true;
  }
  if (isWeekend) {
    for (const smb of TRADING_ALLOWED_PAIRS) {
      try {
        const positions = await getPositions(smb);
        console.log(`-lets check positions for ${smb}`);
        console.log(positions.length);
        if (positions.length > 0) {
          console.log("--lets close positions");
          console.log(positions);
          await closePositions(positions);
        }
      } catch (err) {
        console.log("Error closing Oanda positions");
        console.log(err);
      }
      await sleep(1);
    }

    for (const daSymbol of TRADING_ALLOWED_PAIRS_WEBMASTER) {
      const mainSymbol = daSymbol.replace("_", "") + ".";
      await set(`mt5:pending_command:${mainSymbol}`, {
        action: "closeall",
        mainSymbol,
      });
      await sleep(5);
    }
    try {
      //await closeAllBTCPositions();
    } catch (e) {
      console.log("Error closing Bybit positions");
      console.log(e);
    }
  }
};

module.exports = weekendClose;
