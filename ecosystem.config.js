module.exports = {
  apps: [
    // MAIN API SERVER
    {
      name: "api",
      script: "app.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "prod",
      },
      node_args: "-r newrelic",
      watch: false,
      max_memory_restart: "300M",
    },

    // CRON 1
    {
      name: "cron_btc",
      script: "./crons/profits_btc.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "prod",
      },
      watch: false,
      autorestart: true,
      node_args: "-r newrelic",
    },

    // CRON 2
    {
      name: "cron_oanda",
      script: "./crons/profits_forex.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "prod",
      },
      watch: false,
      autorestart: true,
      node_args: "-r newrelic",
    },
    {
      name: "weekend_close",
      script: "./crons/weekend_close.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "prod",
      },
      watch: false,
      autorestart: true,
      node_args: "-r newrelic",
    },
    {
      name: "btc_signal_email",
      script: "./experiments/ema_21_50_macd_histogram.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "prod",
      },
      watch: false,
      autorestart: true,
      node_args: "-r newrelic",
    },
    {
      name: "oanda_signal_email",
      script: "./experiments/oanda_ema_21_50_macd_histogram.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "prod",
      },
      watch: false,
      autorestart: true,
      node_args: "-r newrelic",
    },
  ],
};
