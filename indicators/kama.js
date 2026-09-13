require("../config/config");
const { insert, remove } = require("../adapters/mongo");
const { PineTS, Provider } = require("pinets");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

const calculatePKAMA = async (candles, length = 50) => {
  const pineTS = new PineTS(candles);

  const PKAMA_SCRIPT = `
  //@version=5
indicator("Powered Kaufman Adaptive Moving Average", shorttitle="P-KAMA", overlay=true)

length = input.int(${length}, title="Length")
factor = input.float(3.0, title="Factor")
src    = input.source(close, title="Source")
sp     = input.bool(false, title="Self Powered")

//----
er  = math.abs(ta.change(close, length)) / math.sum(math.abs(ta.change(close)), length)
pow = sp ? 1 / er : factor
per = math.pow(math.abs(ta.change(close, length)) / math.sum(math.abs(ta.change(close)), length), pow)

//----
a = 0.0
a := per * src + (1 - per) * nz(a[1], src)

//----
plot(a, title="P-KAMA", color=color.new(#f57f17, 0), linewidth=2)
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
