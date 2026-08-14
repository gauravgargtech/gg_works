require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const { fetchClosedTrades, fetchAccountSummary } = require("../services/oandaClient");
const Trade = require("../models/Trade");
const EquitySnapshot = require("../models/EquitySnapshot");

function toTradeDoc(accountId, raw) {
  const initialUnits = Number(raw.initialUnits);
  const openTime = new Date(raw.openTime);
  const closeTime = raw.closeTime ? new Date(raw.closeTime) : undefined;
  const realizedPL = Number(raw.realizedPL);

  return {
    tradeId: raw.id,
    accountId,
    instrument: raw.instrument,
    direction: initialUnits >= 0 ? "long" : "short",
    initialUnits,
    openPrice: Number(raw.price),
    averageClosePrice: raw.averageClosePrice ? Number(raw.averageClosePrice) : undefined,
    openTime,
    closeTime,
    realizedPL,
    financing: Number(raw.financing || 0),
    durationMs: closeTime ? closeTime.getTime() - openTime.getTime() : undefined,
    isWin: realizedPL > 0,
    raw,
  };
}

async function run() {
  const accountId = process.env.OANDA_ACCOUNT_ID;
  if (!accountId) throw new Error("OANDA_ACCOUNT_ID is not set. Check your .env file.");

  await connectDB();

  console.log("[fetchOanda] fetching closed trades...");
  const rawTrades = await fetchClosedTrades(accountId);
  console.log(`[fetchOanda] received ${rawTrades.length} closed trades from OANDA`);

  const ops = rawTrades.map((raw) => ({
    updateOne: {
      filter: { tradeId: raw.id },
      update: { $set: toTradeDoc(accountId, raw) },
      upsert: true,
    },
  }));

  if (ops.length) {
    const result = await Trade.bulkWrite(ops, { ordered: false });
    console.log(
      `[fetchOanda] upserted trades — matched: ${result.matchedCount}, ` +
        `modified: ${result.modifiedCount}, inserted: ${result.upsertedCount}`
    );
  }

  console.log("[fetchOanda] fetching account summary for equity snapshot...");
  const account = await fetchAccountSummary(accountId);
  await EquitySnapshot.create({
    accountId,
    takenAt: new Date(),
    balance: Number(account.balance),
    nav: Number(account.NAV),
    unrealizedPL: Number(account.unrealizedPL || 0),
    marginUsed: Number(account.marginUsed || 0),
    openTradeCount: Number(account.openTradeCount || 0),
  });
  console.log("[fetchOanda] equity snapshot saved");
}

// Allow `node src/jobs/fetchOanda.js` to run standalone (e.g. from a system cron).
if (require.main === module) {
  run()
    .then(() => mongoose.connection.close())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[fetchOanda] failed:", err.response?.data || err.message);
      process.exit(1);
    });
}

module.exports = { run };
