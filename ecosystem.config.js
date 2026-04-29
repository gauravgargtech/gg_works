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
      name: "logs",
      script: "./crons/pm2-betterstack-forwarder.js",
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
      script: "./experimental/ema_21_50_macd_histogram.js",
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
      script: "./experimental/oanda_ema_21_50_macd_histogram.js",
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
