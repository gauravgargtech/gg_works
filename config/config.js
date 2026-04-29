const dotenv = require("dotenv");
const path = require("path");
// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
const env = process.env.NODE_ENV || "dev";

const tracker = require("@middleware.io/node-apm");

const envFileMap = {
  dev: ".env.dev",
  prod: ".env.prod",
};

const envPath = path.resolve(__dirname, envFileMap[env] || ".env.dev");

dotenv.config({ path: envPath, quiet: true });

console.log(`Loaded env file: ${envPath}`);
tracker.track({
  serviceName: "gg_works",
  accessToken: process.env.MIDDLEWARE_TOKEN,
});

module.exports = {
  env,
  isProd: env === "prod",
  isDev: env === "dev",
};
