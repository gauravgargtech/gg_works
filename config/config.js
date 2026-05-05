const dotenv = require("dotenv");
const path = require("path");
// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
const env = process.env.NODE_ENV || "dev";

const { Logtail } = require("@logtail/node");
const { LogtailTransport } = require("@logtail/winston");
const winston = require("winston");

const envFileMap = {
  dev: ".env.dev",
  prod: ".env.prod",
};

const envPath = path.resolve(__dirname, envFileMap[env] || ".env.dev");

dotenv.config({ path: envPath, quiet: true });

console.log(`Loaded env file: ${envPath}`);
const logtail = new Logtail(process.env.BETTERSTACK_SOURCE_TOKEN);

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
    new LogtailTransport(logtail), // sends to Better Stack
  ],
});

const safeStringify = (value) => {
  if (typeof value !== "object" || value === null) return String(value);
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (key, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    });
  } catch {
    return String(value);
  }
};

const serialize = (args) => args.map(safeStringify).join(" ");

if (env !== "dev") {
  console.log = (...args) => logger.info(serialize(args));
  console.info = (...args) => logger.info(serialize(args));
  console.warn = (...args) => logger.warn(serialize(args));
  console.error = (...args) => logger.error(serialize(args));
}

// Override console globally
process.on("uncaughtException", async (err) => {
  console.error("Uncaught exception:", err);
  await logtail.flush(); // flush before PM2 restarts
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  console.error("Unhandled rejection:", reason);
  await logtail.flush();
  process.exit(1);
});

module.exports = {
  env,
  isProd: env === "prod",
  isDev: env === "dev",
};
