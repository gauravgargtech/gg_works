require("../config/config");

const { MongoClient } = require("mongodb");

const url = "mongodb://127.0.0.1:27017";
const dbName = "speaktomate";

let client = null;
let db = null;
let connecting = null; // prevents duplicate connections

async function connectDB() {
  if (db) return db;

  if (connecting) return connecting;

  connecting = (async () => {
    try {
      client = new MongoClient(url, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
      });

      await client.connect();
      db = client.db(dbName);

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
};
