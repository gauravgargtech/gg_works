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
