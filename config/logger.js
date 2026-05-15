// logger.js

const pino = require("pino");

// Create logger
const logger = pino({
  level: process.env.LOG_LEVEL || "info",

  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      timezone: "Australia/Brisbane",
      ignore: "pid,hostname",
      singleLine: false,
    },
  },
});

// Helper to safely log anything
function formatArgs(args) {
  return args.map((arg) => {
    if (arg instanceof Error) {
      return {
        message: arg.message,
        stack: arg.stack,
        name: arg.name,
      };
    }

    return arg;
  });
}

// Override console methods
console.log = (...args) => {
  logger.info(formatArgs(args));
};

console.info = (...args) => {
  logger.info(formatArgs(args));
};

console.warn = (...args) => {
  logger.warn(formatArgs(args));
};

console.error = (...args) => {
  logger.error(formatArgs(args));
};

// Capture uncaught exceptions
process.on("uncaughtException", (err) => {
  logger.fatal({
    type: "uncaughtException",
    message: err.message,
    stack: err.stack,
  });

  // Optional:
  // process.exit(1);
});

// Capture unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  logger.fatal({
    type: "unhandledRejection",
    reason:
      reason instanceof Error
        ? {
            message: reason.message,
            stack: reason.stack,
          }
        : reason,
  });
});

// Optional extra process error handlers
process.on("warning", (warning) => {
  logger.warn({
    type: "processWarning",
    name: warning.name,
    message: warning.message,
    stack: warning.stack,
  });
});

// Export logger if needed elsewhere
module.exports = logger;
