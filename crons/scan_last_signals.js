require("../config/config");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { insert, find } = require("../adapters/mongo");
const cron = require("node-cron");
const { sendEmail } = require("../common/email");

dayjs.extend(utc);
dayjs.extend(timezone);

const scanner = async () => {
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
    };
  });

  console.log(found);

  await sendEmail(
    `Forex - New signals found on ${dayjs().tz("Australia/Brisbane").format("YYYY-MM-DD hh:ii:ss")}`,
    JSON.stringify(found),
  );
  return;
};

cron.schedule("*/15 * * * *", async () => {
  console.log("Refresh Instruments Data every 15 minutes");
  await scanner();
});
