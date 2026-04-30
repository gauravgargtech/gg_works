const dotenv = require("dotenv");
const path = require("path");
// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
const env = process.env.NODE_ENV || "dev";

// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
const Sentry = require("@sentry/node");

const envFileMap = {
  dev: ".env.dev",
  prod: ".env.prod",
};

const envPath = path.resolve(__dirname, envFileMap[env] || ".env.dev");

dotenv.config({ path: envPath, quiet: true });

console.log(`Loaded env file: ${envPath}`);

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: "production",
  integrations: [
    // send console.log, console.warn, and console.error calls as logs to Sentry
    Sentry.consoleLoggingIntegration({ levels: ["log", "warn", "error"] }),
  ],
  // Enable logs to be sent to Sentry
  enableLogs: true,
  // Setting this option to true will send default PII data to Sentry.
  // For example, automatic IP address collection on events
  sendDefaultPii: true,
  tracesSampleRate: 0.1, //  Capture 100% of the transactions
});

process.on("uncaughtException", async (err) => {
  Sentry.captureException(err);
  await Sentry.flush(2000); // wait up to 2s
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  Sentry.captureException(reason);
  await Sentry.flush(2000);
  process.exit(1);
});

module.exports = {
  env,
  isProd: env === "prod",
  isDev: env === "dev",
};
