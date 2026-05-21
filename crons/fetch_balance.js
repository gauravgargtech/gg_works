require("../config/config");

const { getBalance } = require("../exhanges/oanda");
const { insert } = require("../adapters/mongo");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const fetchBalance = async () => {
  const balance = await getBalance();
  const data = {
    account_type: "oanda",
    account_currency: balance.currency,
    balance: balance.balance,
    pl: balance.pl,
    created_at: dayjs().tz("Australia/Brisbane").format("YYYY-MM-DD HH:mm:ss"),
    timestamp: dayjs().tz("Australia/Brisbane").unix(),
  };

  await insert("account_balance", data);

  console.log(balance);
  return true;
};

module.exports = fetchBalance;
