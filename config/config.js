const dotenv = require("dotenv");
const path = require("path");
// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
require("newrelic");
const env = process.env.NODE_ENV || "dev";

const envFileMap = {
  dev: ".env.dev",
  prod: ".env.prod",
};

const envPath = path.resolve(__dirname, envFileMap[env] || ".env.dev");

dotenv.config({ path: envPath, quiet: true });

console.log(`Loaded env file: ${envPath}`);

module.exports = {
  env,
  isProd: env === "prod",
  isDev: env === "dev",
};
