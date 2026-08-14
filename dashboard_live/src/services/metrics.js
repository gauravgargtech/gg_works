const Trade = require("../models/Trade");
const EquitySnapshot = require("../models/EquitySnapshot");

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function round(n, dp = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return 0;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function safeDiv(a, b) {
  return b === 0 ? 0 : a / b;
}

/** Longest win/loss streaks and the current one, in chronological order. */
function computeStreaks(tradesChronological) {
  let longestWin = 0;
  let longestLoss = 0;
  let currentWin = 0;
  let currentLoss = 0;

  for (const t of tradesChronological) {
    if (t.isWin) {
      currentWin += 1;
      currentLoss = 0;
    } else {
      currentLoss += 1;
      currentWin = 0;
    }
    longestWin = Math.max(longestWin, currentWin);
    longestLoss = Math.max(longestLoss, currentLoss);
  }

  const last = tradesChronological[tradesChronological.length - 1];
  const current = last
    ? { type: last.isWin ? "win" : "loss", count: last.isWin ? currentWin : currentLoss }
    : { type: null, count: 0 };

  return { longestWinStreak: longestWin, longestLossStreak: longestLoss, current };
}

/** Groups trades by a key function and returns per-group win rate / P&L. */
function groupBy(trades, keyFn) {
  const groups = new Map();
  for (const t of trades) {
    const key = keyFn(t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  return [...groups.entries()].map(([key, group]) => {
    const wins = group.filter((t) => t.isWin).length;
    const netPL = group.reduce((sum, t) => sum + t.realizedPL, 0);
    return {
      key,
      trades: group.length,
      wins,
      losses: group.length - wins,
      winRate: round(safeDiv(wins, group.length) * 100),
      netPL: round(netPL),
    };
  });
}

/** Max drawdown (absolute and %) from a chronological equity series. */
function computeMaxDrawdown(equitySeries) {
  let peak = -Infinity;
  let maxDD = 0;
  let maxDDPct = 0;

  for (const point of equitySeries) {
    peak = Math.max(peak, point.balance);
    const dd = peak - point.balance;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    maxDD = Math.max(maxDD, dd);
    maxDDPct = Math.max(maxDDPct, ddPct);
  }

  return { maxDrawdown: round(maxDD), maxDrawdownPct: round(maxDDPct) };
}

async function computeMetrics(accountId) {
  const trades = await Trade.find({ accountId, closeTime: { $exists: true } })
    .sort({ closeTime: 1 })
    .lean();

  const equitySnapshots = await EquitySnapshot.find({ accountId })
    .sort({ takenAt: 1 })
    .lean();

  if (trades.length === 0) {
    return { hasData: false };
  }

  const wins = trades.filter((t) => t.isWin);
  const losses = trades.filter((t) => !t.isWin);

  const grossProfit = wins.reduce((sum, t) => sum + t.realizedPL, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.realizedPL, 0));
  const netPL = grossProfit - grossLoss;

  const winRate = safeDiv(wins.length, trades.length) * 100;
  const lossRate = 100 - winRate;

  const avgWin = safeDiv(grossProfit, wins.length);
  const avgLoss = safeDiv(grossLoss, losses.length);
  const payoffRatio = safeDiv(avgWin, avgLoss);
  const profitFactor = safeDiv(grossProfit, grossLoss);

  // Expectancy: expected P&L per trade given the observed win rate and payoff.
  const expectancy = (winRate / 100) * avgWin - (lossRate / 100) * avgLoss;

  const totalFinancing = trades.reduce((sum, t) => sum + (t.financing || 0), 0);

  const winDurations = wins.filter((t) => t.durationMs).map((t) => t.durationMs);
  const lossDurations = losses.filter((t) => t.durationMs).map((t) => t.durationMs);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const avgDurationWinHrs = round(avg(winDurations) / 3_600_000);
  const avgDurationLossHrs = round(avg(lossDurations) / 3_600_000);

  const bestTrade = trades.reduce((best, t) => (t.realizedPL > (best?.realizedPL ?? -Infinity) ? t : best), null);
  const worstTrade = trades.reduce((worst, t) => (t.realizedPL < (worst?.realizedPL ?? Infinity) ? t : worst), null);

  const streaks = computeStreaks(trades);

  const byInstrument = groupBy(trades, (t) => t.instrument).sort((a, b) => b.trades - a.trades);
  const byDayOfWeek = groupBy(trades, (t) => DAY_NAMES[new Date(t.closeTime).getUTCDay()]).sort(
    (a, b) => DAY_NAMES.indexOf(a.key) - DAY_NAMES.indexOf(b.key)
  );
  const byHour = groupBy(trades, (t) => new Date(t.closeTime).getUTCHours()).sort((a, b) => a.key - b.key);

  const byMonth = groupBy(trades, (t) => {
    const d = new Date(t.closeTime);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }).sort((a, b) => (a.key > b.key ? 1 : -1));

  const equityCurve = equitySnapshots.map((s) => ({
    date: s.takenAt,
    balance: s.balance,
    nav: s.nav,
  }));

  const { maxDrawdown, maxDrawdownPct } = computeMaxDrawdown(equityCurve);

  return {
    hasData: true,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(winRate),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    netPL: round(netPL),
    avgWin: round(avgWin),
    avgLoss: round(avgLoss),
    payoffRatio: round(payoffRatio),
    profitFactor: round(profitFactor),
    expectancy: round(expectancy),
    totalFinancing: round(totalFinancing),
    avgDurationWinHrs,
    avgDurationLossHrs,
    bestTrade,
    worstTrade,
    longestWinStreak: streaks.longestWinStreak,
    longestLossStreak: streaks.longestLossStreak,
    currentStreak: streaks.current,
    byInstrument,
    byDayOfWeek,
    byHour,
    byMonth,
    equityCurve,
    maxDrawdown,
    maxDrawdownPct,
    latestSnapshot: equitySnapshots[equitySnapshots.length - 1] || null,
  };
}

module.exports = { computeMetrics };
