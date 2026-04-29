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

console.log = (...args) => {
  tracker.info(formatArgs(args));
};

console.info = (...args) => {
  tracker.info(formatArgs(args));
};

console.warn = (...args) => {
  tracker.warn(formatArgs(args));
};

console.error = (...args) => {
  tracker.error(formatArgs(args));
};

console.debug = (...args) => {
  tracker.debug(formatArgs(args));
};

function formatArgs(args) {
  return args
    .map((a) => (typeof a === "object" ? JSON.stringify(a, null, 2) : a))
    .join(" ");
}

module.exports = {
  env,
  isProd: env === "prod",
  isDev: env === "dev",
};
