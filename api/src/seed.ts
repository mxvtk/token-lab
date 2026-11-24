import { pool, withRetry } from "./db.js";

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const seedRows = [
  ["ada@example.com", "2026-11-20"],
  ["grace@example.com", "2026-11-22"],
  ["alan@example.com", "2026-09-01"],
  ["linus@example.com", "2026-06-15"],
  ["margaret@example.com", "2026-11-23"],
];

async function main() {
  await withRetry(() => pool.query("SELECT 1"));
  await pool.query(schema);
  for (const [email, createdAt] of seedRows) {
    await pool.query(
      `INSERT INTO users (email, created_at)
       VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING`,
      [email, createdAt]
    );
  }
  console.log("seed complete");
  await pool.end();
}

main();
