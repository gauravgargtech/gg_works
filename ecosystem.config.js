module.exports = {
  apps: [
    {
      name: "crons",
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
