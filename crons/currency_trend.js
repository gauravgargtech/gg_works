require("../config/config");

const { findAndSort, insert, remove } = require("../adapters/mongo");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

async function getSnapshots(hours) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const docs = await findAndSort(
    "currency_strength_snapshots",
    { timestamp: { $gte: since } },
    {
      timestamp: 1,
    },
  );

  return docs;
}

function linregSlope(points) {
  // points: [{x, y}] -> returns slope (y change per unit x)
  const n = points.length;
  if (n < 2) return 0;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

function buildTimeSeries(docs) {
  const series = {}; // currency -> [{t, score, rank}]
  for (const doc of docs) {
    const t = new Date(doc.timestamp).getTime();
    for (const s of doc.scores) {
      if (!series[s.currency]) series[s.currency] = [];
      series[s.currency].push({ t, score: s.compositeScore, rank: s.rank });
    }
  }
  return series;
}

function analyze(series) {
  const allPoints = Object.values(series).flat();
  const t0 = Math.min(...allPoints.map((p) => p.t));

  return Object.entries(series)
    .filter(([, pts]) => pts.length >= 2)
    .map(([ccy, pts]) => {
      const first = pts[0];
      const last = pts[pts.length - 1];
      const regPts = pts.map((p) => ({ x: (p.t - t0) / 3.6e6, y: p.score })); // x in hours
      return {
        currency: ccy,
        startScore: +first.score.toFixed(4),
        endScore: +last.score.toFixed(4),
        deltaScore: +(last.score - first.score).toFixed(4),
        startRank: first.rank,
        endRank: last.rank,
        deltaRank: first.rank - last.rank, // positive = moved toward #1
        slopePerHour: +linregSlope(regPts).toFixed(4),
        snapshots: pts.length,
      };
    });
}

function classify(results) {
  // Adaptive threshold: z-score of deltaScore relative to this run's spread
  const deltas = results.map((r) => r.deltaScore);
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const variance =
    deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length;
  const std = Math.sqrt(variance) || 0.0001;

  return results
    .map((r) => {
      const z = (r.deltaScore - mean) / std;
      let signal = "neutral";
      if (z > 0.75 && r.slopePerHour > 0) signal = "rising";
      else if (z < -0.75 && r.slopePerHour < 0) signal = "declining";
      return { ...r, zScore: +z.toFixed(2), signal };
    })
    .sort((a, b) => b.deltaScore - a.deltaScore);
}

function formatTable(rows) {
  const headers = ["Currency", "Signal", "Δ Score", "Slope/hr", "Rank", "Z"];
  const data = rows.map((r) => [
    r.currency,
    r.signal.toUpperCase(),
    r.deltaScore.toFixed(4),
    r.slopePerHour.toFixed(4),
    `${r.startRank}->${r.endRank}`,
    r.zScore.toFixed(2),
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => String(row[i]).length)),
  );

  const pad = (str, w) => String(str).padEnd(w, " ");
  const line = (chars) => widths.map((w) => chars.repeat(w + 2)).join("+");

  const headerRow =
    "| " + headers.map((h, i) => pad(h, widths[i])).join(" | ") + " |";
  const dataRows = data.map(
    (row) => "| " + row.map((c, i) => pad(c, widths[i])).join(" | ") + " |",
  );

  return [
    "+" + line("-") + "+",
    headerRow,
    "+" + line("-") + "+",
    ...dataRows,
    "+" + line("-") + "+",
  ].join("\n");
}

function parseHoursArg() {
  const idx = process.argv.indexOf("--hours");
  if (idx !== -1 && process.argv[idx + 1]) return Number(process.argv[idx + 1]);
  const eq = process.argv.find((a) => a.startsWith("--hours="));
  return eq ? Number(eq.split("=")[1]) : 24;
}

async function currencyTrend() {
  const hours = parseHoursArg();
  const docs = await getSnapshots(hours);

  if (docs.length < 2) {
    console.log(
      `Not enough snapshots in the last ${hours}h (found ${docs.length}). Need >= 2.`,
    );
    return;
  }

  const results = classify(analyze(buildTimeSeries(docs)));

  for (const res of results) {
    await remove("currency_trend", { currency: res.currency });
    res.thetime = dayjs()
      .tz("Australia/Brisbane")
      .format("YYYY-MM-DD HH:mm:ss");
    res.unix = dayjs().tz("Australia/Brisbane").unix();
    await insert("currency_trend", res);
  }

  return results;
}

module.exports = currencyTrend;
