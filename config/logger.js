const { createLogger, format, transports } = require("winston");
const { combine, timestamp, printf, colorize, align, errors } = format;

const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: "YYYY-MM-DD hh:mm:ss A" }),
  align(),
  errors({ stack: true }),
  printf((info) => {
    const { timestamp, level, message, stack, ...meta } = info;
    const metaStr = Object.keys(meta).length
      ? "\n" + JSON.stringify(meta, null, 2)
      : "";
    return `[${timestamp}] ${level}: ${message}${metaStr}${stack ? `\n${stack}` : ""}`;
  }),
);

const logger = createLogger({
  level: process.env.LOG_LEVEL || "debug",
  format: devFormat,
  transports: [new transports.Console()],
  exitOnError: false,
});

// ─── Override native console methods ────────────────────────────────────────

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function formatArgs(args) {
  return args
    .map((a) =>
      typeof a === "object" ? JSON.stringify(a, null, 2) : String(a),
    )
    .join(" ");
}

console.log = (...args) => logger.info(formatArgs(args));
console.info = (...args) => logger.info(formatArgs(args));
console.warn = (...args) => logger.warn(formatArgs(args));
console.error = (...args) => logger.error(formatArgs(args));
console.debug = (...args) => logger.debug(formatArgs(args));

// Escape hatch — use originalConsole.log(...) if you ever need raw output
module.exports = { logger, originalConsole };
