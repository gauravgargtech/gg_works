const dotenv = require("dotenv");
const path = require("path");

const env = process.env.NODE_ENV || "dev";

const envFileMap = {
  dev: ".env.dev",
  prod: ".env.prod",
};

const envPath = path.resolve(__dirname, envFileMap[env] || ".env.dev");

dotenv.config({ path: envPath });

console.log(`Loaded env file: ${envPath}`);

module.exports = {
  env,
  isProd: env === "prod",
  isDev: env === "dev",
};
