const cron = require("node-cron");
const { runTechnicalOnly, runFullPipeline } = require("./pipeline");

function startScheduler() {
  const technicalCron = process.env.TECHNICAL_CRON || "*/15 * * * *";
  const fullCron = process.env.FULL_PIPELINE_CRON || "0 */4 * * *";

  console.log(
    `[scheduler] technical-only: "${technicalCron}" | full pipeline: "${fullCron}"`,
  );

  cron.schedule(technicalCron, () => {
    runTechnicalOnly().catch((err) =>
      console.error("[scheduler] technical run failed:", err),
    );
  });

  cron.schedule(fullCron, () => {
    runFullPipeline().catch((err) =>
      console.error("[scheduler] full pipeline run failed:", err),
    );
  });
}

module.exports = { startScheduler };
