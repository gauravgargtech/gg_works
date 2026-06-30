require("../config/config");
const mongo = require("./src/db/mongo");
const { startScheduler } = require("./src/scheduler");
const { runFullPipeline } = require("./src/pipeline");

async function main() {
  await mongo.connect();

  const runOnce = process.argv.includes("--once");

  /*
  if (runOnce) {
    await runFullPipeline();
    await mongo.disconnect();
    process.exit(0);
  }

  if ((process.env.RUN_ON_BOOT || "true") === "true") {
    runFullPipeline().catch((err) =>
      console.error("[boot] initial run failed:", err),
    );
  }
    */

  startScheduler();
  console.log("[main] forex-strength-system running. Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("[main] fatal error:", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  console.log("\n[main] shutting down...");
  await mongo.disconnect();
  process.exit(0);
});
