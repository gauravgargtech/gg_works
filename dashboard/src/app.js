require("dotenv").config();
const path = require("path");
const express = require("express");
const { connectDB } = require("./config/db");
const dashboardRouter = require("./routes/dashboard");

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

app.use("/", dashboardRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(`<pre>${err.stack}</pre>`);
});

const PORT = process.env.PORT || 3005;

connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`[app] dashboard running at http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("[app] failed to start:", err.message);
    process.exit(1);
  });
