const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "debug",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "YYYY-MM-DD hh:mm:ss A",
      ignore: "pid,hostname", // hides noisy default fields
      singleLine: false, // set true for one-line logs
      messageFormat: "{msg}",
    },
  },
});

function formatArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.message;
      if (typeof a === "object" && a !== null)
        return JSON.stringify(a, null, 2);
      return String(a);
    })
    .join(" ");
}

console.log = (...args) => logger.info(formatArgs(args));
console.info = (...args) => logger.info(formatArgs(args));
console.warn = (...args) => logger.warn(formatArgs(args));
console.error = (...args) => logger.error(formatArgs(args));
console.debug = (...args) => logger.debug(formatArgs(args));

module.exports = logger;
