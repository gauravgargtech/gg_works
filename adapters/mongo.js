require("../config/config");
const process = require("process");
const { MongoClient, ServerApiVersion } = require("mongodb");

const url = process.env.MONGO_URL;
const dbName = process.env.MONGO_DB_NAME;

let client = null;
let db = null;
let connecting = null;

async function connectDB() {
  if (db) return db;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const newClient = new MongoClient(url, {
        maxPoolSize: 5,
        minPoolSize: 1,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        retryWrites: true,
        serverApi: {
          version: ServerApiVersion.v1,
          strict: true,
          deprecationErrors: true,
        },
        readPreference: "primary",
        readConcern: { level: "local" },
        writeConcern: { w: "majority", j: true },
      });

      await newClient.connect();
      await newClient.db("admin").command({ ping: 1 });

      client = newClient;
      db = client.db(dbName);
      console.log("MongoDB Connected");

      client.on("close", () => {
        console.warn("MongoDB connection closed. Resetting...");
        db = null;
        client = null;
        connecting = null; // ← allow reconnect
      });

      return db;
    } catch (err) {
      connecting = null; // ← allow retry on next call
      console.error("MongoDB connection failed:", err);
      throw err;
    }
  })();

  // Clear connecting ref after promise settles
  // so next call to connectDB() can re-evaluate
  connecting.finally(() => {
    connecting = null;
  });

  return connecting;
}

async function getDB() {
  if (db) return db;
  return await connectDB();
}

// ✅ Fixed: close old client before resetting
async function withRetry(fn, retries = 2) {
  try {
    const database = await getDB();
    return await fn(database);
  } catch (err) {
    if (retries > 0) {
      console.warn("Retrying DB operation...", err.message);

      // ✅ Properly close the old connection before resetting
      if (client) {
        try {
          await client.close();
        } catch (_) {}
      }

      db = null;
      client = null;
      connecting = null;

      return await withRetry(fn, retries - 1);
    }
    throw err;
  }
}

async function insert(collection, doc) {
  return withRetry((db) => db.collection(collection).insertOne(doc));
}

async function insertMany(collection, docs) {
  return withRetry((db) => db.collection(collection).insertMany(docs));
}

async function find(collection, query) {
  return withRetry((db) => db.collection(collection).find(query).toArray());
}

async function aggregate(collection, query) {
  return withRetry((db) =>
    db.collection(collection).aggregate(query).toArray(),
  );
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

// ✅ Graceful shutdown — call this on SIGINT/SIGTERM
async function closeDB() {
  if (client) {
    await client.close();
    db = null;
    client = null;
    connecting = null;
    console.log("MongoDB disconnected cleanly");
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
  insertMany,
  aggregate,
};
