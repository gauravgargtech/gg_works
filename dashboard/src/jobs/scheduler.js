require("dotenv").config();
const cron = require("node-cron");
const { run } = require("./fetchOanda");

// Default: every 6 hours, on the hour (00:00, 06:00, 12:00, 18:00).
const schedule = process.env.CRON_SCHEDULE || "0 */1 * * *";

console.log(`[scheduler] scheduling OANDA fetch with cron pattern "${schedule}"`);

cron.schedule(schedule, async () => {
  console.log(`[scheduler] running fetch job at ${new Date().toISOString()}`);
  try {
    await run();
  } catch (err) {
    console.error("[scheduler] job failed:", err.response?.data || err.message);
  }
});

// Also run once immediately on boot so the dashboard has data right away.
run().catch((err) => console.error("[scheduler] initial run failed:", err.response?.data || err.message));
