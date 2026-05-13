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

// Override console globally
process.on("uncaughtException", async (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

module.exports = {
  env,
  isProd: env === "prod",
  isDev: env === "dev",
};
