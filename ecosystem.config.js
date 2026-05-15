module.exports = {
  apps: [
    // MAIN API SERVER
    {
      name: "api",
      script: "app.js",
      node_args: "-r newrelic",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "prod",
      },
      watch: false,
      max_memory_restart: "300M",
    },

    // CRON 1
    {
      name: "cron_btc",
      script: "./crons/profits_btc.js",
      node_args: "-r newrelic",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "prod",
      },
      watch: false,
      autorestart: true,
    },

    // CRON 2
    {
      name: "cron_oanda",
      script: "./crons/profits_forex.js",
      node_args: "-r newrelic",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "prod",
      },
      watch: false,
      autorestart: true,
    },
    {
      name: "all_crons",
      script: "./crons/all_crons.js",
      node_args: "-r newrelic",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "prod",
      },
      watch: false,
      autorestart: true,
    },
  ],
};
