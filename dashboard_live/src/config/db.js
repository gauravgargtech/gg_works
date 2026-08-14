const mongoose = require("mongoose");

let isConnected = false;

async function connectDB() {
  if (isConnected) return mongoose.connection;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set. Check your .env file.");
  }

  await mongoose.connect(uri, {
    dbName: "gg_works_live",
  });
  isConnected = true;
  console.log("[db] connected to MongoDB");
  return mongoose.connection;
}

module.exports = { connectDB };
