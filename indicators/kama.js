require("../config/config");
const { insert, remove } = require("../adapters/mongo");
const { PineTS, Provider } = require("pinets");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const calculatePKAMA = async (candles) => {
  const pineTS = new PineTS(candles);

  const PKAMA_SCRIPT = `
//@version=5
indicator("Powered Kaufman Adaptive Moving Average", shorttitle="P-KAMA", overlay=true)
length = input.int(50)
factor = input.float(3.0)
src = input(close)
sp = input(true, title="Self Powered")
er = math.abs(ta.change(close, length)) / math.sum(math.abs(ta.change(close)), length)
powExp = sp ? 1/er : factor
per = math.pow(math.abs(ta.change(close, length)) / math.sum(math.abs(ta.change(close)), length), powExp)
var a = 0.0
a := per*src + (1-per)*nz(a[1], src)
c = src >= a ? color.lime : color.red
p1 = plot(a, title="P-KAMA", color=c, linewidth=2)
p2 = plot(src, title="src", color=c, linewidth=1)
`;

  const result = await pineTS.run(PKAMA_SCRIPT);

  const pkamaSeries = result.plots["P-KAMA"].data; // [{ time, value, options: { color } }, ...]
  const latest = pkamaSeries[pkamaSeries.length - 1];

  const response = [];
  for (const data of pkamaSeries) {
    response.push(data.value);
  }

  return response;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = calculatePKAMA;
