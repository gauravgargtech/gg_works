"use strict";
require("newrelic");

exports.config = {
  app_name: process.env.NEW_RELIC_APP_NAME,
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  logging: {
    level: "info",
  },
  allow_all_headers: true,
  attributes: {
    enabled: true, // ✅ add this
    exclude: ["request.headers.cookie", "request.headers.authorization"],
  },
  transaction_tracer: {
    enabled: true,
    record_sql: "obfuscated",
  },
  distributed_tracing: {
    enabled: true, // ✅ add this — links traces to transactions
  },
};
