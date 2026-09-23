require("../config/config");
const { compile, Engine, ArrayFeed } = require("@heyphat/piner");

async function powerKama(candles, length, symbol, timeframe) {
  const factor = 3;
  const selfPowered = true;

  const pineSource = compile(`
//@version=5
indicator("Powered Kaufman Adaptive Moving Average", shorttitle="P-KAMA", overlay=true)

length = input.int(${length}, title="Length")
factor = input.float(${factor}, title="Factor")
src    = input.source(close, title="Source")
sp     = input.bool(${selfPowered}, title="Self Powered")

er  = math.abs(ta.change(close, length)) / math.sum(math.abs(ta.change(close)), length)
pw  = sp ? 1 / er : factor
per = math.pow(math.abs(ta.change(close, length)) / math.sum(math.abs(ta.change(close)), length), pw)

var float a = 0.0
a := per * src + (1 - per) * nz(a[1], src)

c  = src >= a ? color.lime : color.red
p1 = plot(a, title="P-KAMA", color=c, linewidth=2)
p2 = plot(src, title="P-KAMA (src)", color=color.new(c, 100), linewidth=1)
fill(p1, p2, color=color.new(c, 90))
`);

  const engine = new Engine(pineSource, new ArrayFeed(candles)); // backend: 'js' (default) | 'interp'
  await engine.run({ symbol: symbol, timeframe: timeframe });
  const result = engine.outputs.plots.get(0); // → { id, title, data: number[] }

  return result.data;
}

module.exports = powerKama;
