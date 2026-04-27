require("../config/config.js");
const { spawn } = require("child_process");
const http = require("http");
const https = require("https");

const SOURCE_TOKEN = process.env.BETTERSTACK_SOURCE_TOKEN;
const INGESTING_HOST = process.env.BETTERSTACK_INGESTING_HOST;

// Spawn PM2 log process
const pm2 = spawn("pm2", ["logs", "--raw", "--lines", "0"]);

pm2.stdout.on("data", (data) => {
  const logLine = data.toString().trim();
  if (!logLine) return;

  // Send to Better Stack
  const postData = JSON.stringify({
    message: logLine,
    service: "GG_Works",
    timestamp: new Date().toISOString(),
  });

  const options = {
    hostname: INGESTING_HOST,
    path: "/",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SOURCE_TOKEN}`,
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  const req = https.request(options);
  req.write(postData);
  req.end();
});

pm2.stderr.on("data", (data) => {
  // Forward stderr logs similarly
  console.error(data.toString());
});
