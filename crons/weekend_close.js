require("../config/config");
const { closePositions } = require("../exhanges/oanda");
const { closeAllBTCPositions } = require("../exhanges/bybit");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

setInterval(() => {
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
    try {
      closePositions();
    } catch (e) {
      console.log("Error closing Oanda positions");
      console.log(e);
    }
    try {
      closeAllBTCPositions();
    } catch (e) {
      console.log("Error closing Bybit positions");
      console.log(e);
    }
  }
}, 300000);
