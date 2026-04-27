require("../config/config");
const process = require("process");

const Redis = require("ioredis");

const REDIS_URL = process.env.redis_url || "redis://127.0.0.1:6379";

let redis = null;
let connecting = null;

/**
 * Create / reuse Redis connection
 */
async function connectRedis() {
  if (redis && redis.status === "ready") return redis;

  if (connecting) return connecting;

  connecting = (async () => {
    try {
      redis = new Redis(REDIS_URL, {
        retryStrategy(times) {
          // exponential backoff (max ~2s)
          return Math.min(times * 50, 2000);
        },
        reconnectOnError(err) {
          console.warn("Redis reconnect triggered:", err.message);
          return true;
        },
      });

      redis.on("connect", () => {
        console.log("Redis connecting...");
      });

      redis.on("ready", () => {
        console.log("Redis ready");
      });

      redis.on("error", (err) => {
        console.error("Redis error:", err.message);
      });

      redis.on("end", () => {
        console.warn("Redis connection ended. Resetting...");
        redis = null;
      });

      return redis;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

/**
 * Get Redis safely (auto reconnect if needed)
 */
async function getRedis() {
  if (redis && redis.status === "ready") return redis;
  return await connectRedis();
}

/**
 * Generic retry wrapper for Redis commands
 */
async function withRetry(fn, retries = 2) {
  try {
    const client = await getRedis();
    return await fn(client);
  } catch (err) {
    if (retries > 0) {
      console.warn("Redis retrying operation:", err.message);

      // force reset connection
      if (redis) {
        redis.disconnect();
      }
      redis = null;

      return await withRetry(fn, retries - 1);
    }
    throw err;
  }
}

/**
 * Common Redis helpers
 */

// SET
async function set(key, value, ttlSeconds = null) {
  return withRetry(async (r) => {
    if (ttlSeconds) {
      return r.set(key, JSON.stringify(value), "EX", ttlSeconds);
    }
    return r.set(key, JSON.stringify(value));
  });
}

// GET
async function get(key) {
  return withRetry(async (r) => {
    const val = await r.get(key);
    return val ? JSON.parse(val) : null;
  });
}

// DEL
async function del(key) {
  return withRetry(async (r) => r.del(key));
}

// HASH SET
async function hset(key, field, value) {
  return withRetry(async (r) => r.hset(key, field, JSON.stringify(value)));
}

// HASH GET
async function hget(key, field) {
  return withRetry(async (r) => {
    const val = await r.hget(key, field);
    return val ? JSON.parse(val) : null;
  });
}

// LIST PUSH
async function lpush(key, value) {
  return withRetry(async (r) => r.lpush(key, JSON.stringify(value)));
}

// LIST POP
async function rpop(key) {
  return withRetry(async (r) => {
    const val = await r.rpop(key);
    return val ? JSON.parse(val) : null;
  });
}

// CLOSE
async function closeRedis() {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

module.exports = {
  connectRedis,
  getRedis,
  set,
  get,
  del,
  hset,
  hget,
  lpush,
  rpop,
  closeRedis,
};
