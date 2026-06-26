# Forex Currency Strength System

Computes a per-currency strength score (USD, EUR, GBP, JPY, CHF, AUD, CAD, NZD) by blending:

1. **Technical** — price action across your OANDA pair basket (Currency Strength Index math)
2. **Fundamental** — central bank policy rates + 10Y yields, pulled free from FRED
3. **Sentiment** — Groq LLM scoring of free RSS news/central-bank headlines

Scores are written to MongoDB on a schedule so you build a strength history over time.

## Setup

```bash
npm install
cp .env.example .env
# fill in OANDA_API_KEY, OANDA_ACCOUNT_ID, FRED_API_KEY, GROQ_API_KEY, MONGODB_URI
```

Get free keys:
- OANDA: practice account token from your OANDA account dashboard (you already have this)
- FRED: https://fred.stlouisfed.org/docs/api/api_key.html (instant, free)
- Groq: https://console.groq.com (you already have this)
- MongoDB: local install, or a free Atlas cluster

## Run

```bash
npm run run-once   # single full pipeline run, then exits — good for testing
npm start           # starts the scheduler (technical every 15min, full pipeline every 4h by default)
```

## How the scoring actually works

**Technical (`src/services/csi.js`)**: for every pair BASE_QUOTE, its % price
change adds to BASE's running total and subtracts from QUOTE's. Average each
currency's total across every pair it appears in, then z-score so currencies
are comparable regardless of how volatile the basket was that hour. Done
across H1/H4/D and blended — short timeframe catches momentum, long timeframe
filters noise.

**Fundamental (`src/services/fred.js`)**: pulls latest policy rate + 10Y yield
per currency from FRED, z-scores each, blends 70/30 (rate matters more than
the slower-moving yield).

**Sentiment (`src/services/sentiment.js`)**: tags free RSS headlines by
currency via keyword matching, sends each currency's batch to Groq with a
strict JSON-only prompt, validates/clamps the response (never trusts the LLM
blindly — bad JSON or out-of-range values fall back to neutral), and
weights the result by the LLM's own stated confidence so vague headlines
don't inject noise.

**Composite (`src/services/composite.js`)**: weighted sum of the three layers
(default 50/30/20 — edit `SCORE_WEIGHTS` in `src/config.js`). **These weights
are a starting guess, not a backtested result — validate them against
historical data before trusting the ranking for real decisions.**

## Things worth knowing before you rely on this

- **FRED series IDs can be renamed/discontinued.** The US short-rate series
  this used to use was discontinued in 2022 (now uses FEDFUNDS instead).
  Check `src/config.js` comments — verify each series still resolves at
  `https://fred.stlouisfed.org/series/<ID>` periodically.
- **CAD's FRED series ID (`IRSTCI01CAM156N`) follows the same OECD naming
  pattern as the others but wasn't individually confirmed** — if the
  fundamental score for CAD comes back null in your logs, that's the series
  ID to check first.
- **Groq sentiment is noisy.** Low temperature helps, but don't treat one
  reading as gospel — that's why it's only 20% of the composite weight by
  default and confidence-weighted on top of that.
- **CHF is a safe-haven currency** — its sentiment/technical score often
  reflects global risk-off moves more than actual Swiss data. Don't be
  surprised if CHF strength correlates with equity selloffs more than with
  SNB headlines.
- This computes **levels and snapshots**, not rate-of-change in sentiment or
  policy stance — a genuinely "improving but still negative" currency won't
  show as strengthening here. That's a reasonable v2 addition (store deltas
  between consecutive snapshots).
- No backtesting is included. Before using this to inform real trades, pull
  the historical snapshots from MongoDB and check whether the composite
  ranking actually preceded real price moves, and tune `SCORE_WEIGHTS`
  accordingly.
