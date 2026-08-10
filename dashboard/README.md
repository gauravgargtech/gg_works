# OANDA Trading Dashboard

Fetches your closed OANDA trades + account summary on a schedule, stores them in
MongoDB, and serves a metrics dashboard (Express + EJS + Chart.js — MIT licensed,
loaded from cdnjs).

## Setup

```bash
npm install
cp .env.example .env
# edit .env: OANDA_API_TOKEN, OANDA_ACCOUNT_ID, OANDA_ENV, MONGODB_URI
```

Get an API token from OANDA: **My Account → Manage API Access** (practice tokens
come from the fxTrade Practice site, live tokens from the live site — they are
different tokens).

## Run

```bash
# one-off fetch (also good for testing your .env)
npm run fetch

# start the dashboard
npm start
# → http://localhost:3000
```

## Scheduling the fetch every 6 hours

Two options — pick one, not both:

**Option A — system cron (recommended for a server/VPS):**

```bash
crontab -e
# add:
0 */6 * * * cd /path/to/oanda-dashboard && /usr/bin/node src/jobs/fetchOanda.js >> /var/log/oanda-fetch.log 2>&1
```

**Option B — in-process scheduler (node-cron), if you'd rather not touch system cron:**

```bash
npm run cron
```

This runs one fetch immediately, then every 6 hours per `CRON_SCHEDULE` in `.env`.
Run it as a separate long-lived process (e.g. under `pm2` or a systemd service)
alongside `npm start` — keep ingestion and the web server as two processes so a
crash in one doesn't take down the other.

## How data flows

1. `src/jobs/fetchOanda.js` calls OANDA's `/v3/accounts/{id}/trades?state=CLOSED`
   (paginated) and `/v3/accounts/{id}/summary`.
2. Trades are upserted into MongoDB by OANDA's own trade `id`, so re-running the
   job is always safe/idempotent — no duplicate trades even if a run overlaps
   the previous one's data.
3. Each run also writes one `EquitySnapshot` document (balance/NAV/margin at
   that moment) — this is what powers the equity curve and drawdown numbers,
   since OANDA doesn't expose historical balance directly.
4. `src/services/metrics.js` reads everything back out of MongoDB and computes
   win rate, profit factor, expectancy, drawdown, streaks, and the
   instrument/day/month breakdowns.
5. The dashboard route (`src/routes/dashboard.js`) only ever reads from Mongo —
   it never calls OANDA live, so page loads are fast regardless of OANDA's
   rate limits.

## Extending it

- **Slippage**: pull `/v3/accounts/{id}/transactions` and diff
  `orderCreateTransaction.price` vs `orderFillTransaction.price` per trade.
- **R-multiples**: if you log your intended stop distance somewhere (OANDA
  doesn't store planned risk), join it against `Trade.realizedPL` to bucket
  trades by risk-adjusted outcome instead of raw P/L.
- **Sharpe/Sortino**: derive daily returns from `EquitySnapshot.balance` and
  add the calculation to `metrics.js`.
- **Multi-account**: the schema already scopes everything by `accountId`, so
  looping the fetch job over several account IDs and adding an account
  selector to the dashboard is a small change.
