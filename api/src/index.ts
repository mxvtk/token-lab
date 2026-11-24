import express from "express";
import { pool, withRetry } from "./db.js";

const app = express();
app.use(express.json());

// Allow the Vite dev server to call the API during the workshop.
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  next();
});

// List all users.
app.get("/api/users", async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id, email, created_at FROM users ORDER BY id"
  );
  res.json(rows);
});

// Get a single user by id.
app.get("/api/users/:id", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, email, created_at FROM users WHERE id = $1",
    [req.params.id]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(rows[0]);
});

const port = Number(process.env.PORT ?? 3001);

withRetry(() => pool.query("SELECT 1")).then(() => {
  app.listen(port, () => {
    console.log(`api listening on :${port}`);
  });
});
