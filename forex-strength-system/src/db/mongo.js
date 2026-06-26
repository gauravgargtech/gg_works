const mongoose = require("mongoose");
const { MONGO_URI } = require("../config");

async function connect() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(MONGO_URI, {
    dbName: "gg_works",
  });
  console.log("[mongo] connected:", MONGO_URI);
}

async function disconnect() {
  await mongoose.disconnect();
}

module.exports = { connect, disconnect };
