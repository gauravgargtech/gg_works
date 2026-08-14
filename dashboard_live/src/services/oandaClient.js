const axios = require("axios");

const BASE_URLS = {
  practice: "https://api-fxpractice.oanda.com",
  live: "https://api-fxtrade.oanda.com",
};

function getClient() {
  const env = process.env.OANDA_ENV === "live" ? "live" : "practice";
  const token = process.env.OANDA_API_TOKEN;

  if (!token) {
    throw new Error("OANDA_API_TOKEN is not set. Check your .env file.");
  }

  return axios.create({
    baseURL: BASE_URLS[env],
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
}

/**
 * Fetch ALL closed trades for the account, paginating with the `beforeID`
 * cursor. OANDA returns trades newest-first, so we keep asking for trades
 * older than the smallest id we've seen until a page comes back short of
 * the page size (meaning we've hit the end).
 */
async function fetchClosedTrades(accountId, { pageSize = 500 } = {}) {
  const client = getClient();
  const allTrades = [];
  let beforeID;

  // Safety cap so a bug can't loop forever against a live API.
  for (let page = 0; page < 200; page++) {
    const params = { state: "CLOSED", count: pageSize };
    if (beforeID) params.beforeID = beforeID;

    const { data } = await client.get(`/v3/accounts/${accountId}/trades`, { params });
    const trades = data.trades || [];
    allTrades.push(...trades);

    if (trades.length < pageSize) break; // last page

    // trade ids are numeric strings; the oldest id in this page becomes
    // the cursor for the next (older) page.
    const oldestId = trades.reduce(
      (min, t) => (Number(t.id) < Number(min) ? t.id : min),
      trades[0].id
    );
    beforeID = oldestId;
  }

  return allTrades;
}

/** GET /v3/accounts/{id}/summary — current balance, NAV, margin, etc. */
async function fetchAccountSummary(accountId) {
  const client = getClient();
  const { data } = await client.get(`/v3/accounts/${accountId}/summary`);
  return data.account;
}

module.exports = { fetchClosedTrades, fetchAccountSummary };
