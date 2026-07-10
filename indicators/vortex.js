function vortexIndicator(candles, period) {
  const n = candles.length;
  const out = [];

  // Per-bar components, aligned to candles[i] using candles[i-1]
  // trueRange[i], vmPlus[i], vmMinus[i] are undefined for i === 0
  const tr = new Array(n).fill(null);
  const vmp = new Array(n).fill(null);
  const vmm = new Array(n).fill(null);

  for (let i = 1; i < n; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];

    // True Range = ta.atr(1) equivalent (no smoothing)
    tr[i] = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );

    vmp[i] = Math.abs(cur.high - prev.low);
    vmm[i] = Math.abs(cur.low - prev.high);
  }

  // Rolling sums over `period`, first full window ends at index `period`
  // (since index 0 has no tr/vmp/vmm).
  for (let i = period; i < n; i++) {
    let sumTR = 0,
      sumVMP = 0,
      sumVMM = 0;
    for (let k = i - period + 1; k <= i; k++) {
      sumTR += tr[k];
      sumVMP += vmp[k];
      sumVMM += vmm[k];
    }
    out.push({
      time: candles[i].time,
      vip: sumVMP / sumTR,
      vim: sumVMM / sumTR,
    });
  }

  return out;
}

module.exports = vortexIndicator;
