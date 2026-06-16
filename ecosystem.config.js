module.exports = {
  apps: [
    {
      name: "crons",
      script: "./crons/all_crons.js",
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
