require("../config/config");
const process = require("process");

const { MongoClient, ServerApiVersion } = require("mongodb");

const url = process.env.MONGO_URL;
const dbName = process.env.MONGO_DB_NAME;

let client = null;
let db = null;
let connecting = null; // prevents duplicate connections

async function connectDB() {
  if (db) return db;

  if (connecting) return connecting;

  connecting = (async () => {
    try {
      client = new MongoClient(url, {
        maxPoolSize: 3,
        serverSelectionTimeoutMS: 5000,
        retryWrites: true,

        serverApi: {
          version: ServerApiVersion.v1,
          strict: true,
          deprecationErrors: true,
        },

        readPreference: "primary",
        readConcern: { level: "local" },

        writeConcern: {
          w: "majority",
          j: true,
        },
      });
      await client.connect();
      db = client.db(dbName);

      await client.db("admin").command({ ping: 1 });
      console.log("MongoDB Connected");

      // Optional: listen for close events
      client.on("close", () => {
        console.warn("MongoDB connection closed. Resetting...");
        db = null;
        client = null;
      });

      return db;
    } catch (err) {
      connecting = null;
      console.error("MongoDB connection failed:", err);
      throw err;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

async function getDB() {
  if (db) return db;
  return await connectDB();
}

// Core retry wrapper
async function withRetry(fn, retries = 2) {
  try {
    const database = await getDB();
    return await fn(database);
  } catch (err) {
    if (retries > 0) {
      console.warn("Retrying DB operation...", err.message);

      // force reset
      db = null;
      client = null;

      return await withRetry(fn, retries - 1);
    }
    throw err;
  }
}

// Helper methods (safe to use anywhere)
async function insert(collection, doc) {
  return withRetry((db) => db.collection(collection).insertOne(doc));
}

async function find(collection, query) {
  return withRetry((db) => db.collection(collection).find(query).toArray());
}

async function findAndSort(collection, query, sortBy, limit = 0) {
  return withRetry((db) => {
    let cursor = db.collection(collection).find(query).sort(sortBy);

    if (limit > 0) {
      cursor = cursor.limit(limit);
    }

    return cursor.toArray();
  });
}

async function update(collection, query, update) {
  return withRetry((db) => db.collection(collection).updateMany(query, update));
}

async function remove(collection, query) {
  return withRetry((db) => db.collection(collection).deleteMany(query));
}

async function closeDB() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

module.exports = {
  connectDB,
  getDB,
  insert,
  find,
  update,
  remove,
  closeDB,
  findAndSort,
};
