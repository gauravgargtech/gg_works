const dotenv = require("dotenv");
const path = require("path");
// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
const env = process.env.NODE_ENV || "dev";
require("./constants");
require("./logger");

const envFileMap = {
  dev: ".env.dev",
  prod: ".env.prod",
};

const envPath = path.resolve(__dirname, envFileMap[env] || ".env.dev");

dotenv.config({ path: envPath, quiet: true });

console.log(`Loaded env file: ${envPath}`);

require("./newrelic");

Error.stackTraceLimit = Infinity;

/*
process.on("uncaughtException", (err) => {
  console.error("========== UNCAUGHT EXCEPTION ==========");
  logError(err);

  // optional graceful shutdown
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("========== UNHANDLED REJECTION ==========");

  if (reason instanceof Error) {
    logError(reason);
  } else {
    console.error("Non-error rejection:", reason);
  }

  process.exit(1);
});

process.on("warning", (warning) => {
  console.error("========== NODE WARNING ==========");
  console.error(warning.stack);
});

function logError(err) {
  console.error("Name:", err?.name);
  console.error("Message:", err?.message);
  console.error("Stack:", err?.stack);

  console.error(
    "Full:",
    JSON.stringify(err, Object.getOwnPropertyNames(err), 2),
  );
}
*/

module.exports = {
  env,
  isProd: env === "prod",
  isDev: env === "dev",
};
