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
    },
    {
      name: "populate_oanda_instruments",
      script: "./crons/populate_data.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "prod",
      },
      watch: false,
      autorestart: true,
    },
    {
      name: "log_signals_in_mongo",
      script: "./crons/log_signals_in_mongo.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "prod",
      },
      watch: false,
      autorestart: true,
    },
    {
      name: "scan_last_signals",
      script: "./crons/scan_last_signals.js",
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
