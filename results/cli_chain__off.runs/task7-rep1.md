# cli_chain__off task 7 rep 1

Grade: "/api/health added; non-numeric :id returns 400; only api/ files changed; PR description written"

## Agent result

### Step 1: Read every file in api/src and web/src and explain how the app fits together - request flow from the React page to Postgres.

Here's the full request flow from the React page to Postgres:

---

## Architecture Overview

This is a minimal three-tier app: **React (Vite) → Express API → PostgreSQL**.

---

### 1. Browser boot — `web/src/main.tsx`

```
document.getElementById("root")  →  createRoot  →  <App />
```

Vite bundles the app and serves it. `main.tsx` is the entry point — it mounts `<App>` into the `#root` div inside `index.html`.

---

### 2. Data fetch — `web/src/App.tsx:12–17`

On first render, `useEffect` fires a `fetch` to `http://localhost:3001/api/users` (overridable via `VITE_API_URL`). This is a plain browser `fetch` — no library. The result drives three states: `null` (loading), an array of `User` objects (success), or an error string.

```
useEffect([], [])  →  fetch("/api/users")  →  setUsers(rows)
```

Clicking a user button calls `setSelected(u)` to show their details inline — no additional network request; all data was loaded upfront.

---

### 3. CORS middleware — `api/src/index.ts:8–13`

Every response gets `Access-Control-Allow-Origin: *` before any route runs. This is necessary because the Vite dev server (port 5173) and the Express API (port 3001) are different origins.

---

### 4. Route handlers — `api/src/index.ts:16–34`

| Route | Query |
|---|---|
| `GET /api/users` | `SELECT id, email, created_at FROM users ORDER BY id` |
| `GET /api/users/:id` | `SELECT … WHERE id = $1` (parameterized) |

The handlers call `pool.query()` directly — no ORM. The `$1` placeholder in the single-user route is **parameterized**, which prevents SQL injection.

---

### 5. Connection pool — `api/src/db.ts`

`pg.Pool` manages a pool of persistent TCP connections to Postgres. Configuration comes from environment variables with defaults pointing at the Docker service named `db`.

`withRetry` polls `SELECT 1` up to 10 times (1-second gaps) so the API container doesn't crash if it starts before Postgres is ready — a common Docker Compose timing issue.

---

### 6. Database schema — `api/src/seed.ts`

```sql
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

`seed.ts` is a one-shot script (not part of the API server) that creates the table and upserts 5 rows using `ON CONFLICT (email) DO NOTHING` — idempotent, safe to re-run.

---

`★ Insight ─────────────────────────────────────`
- **No ORM, raw `pg` driver**: The queries land as literal SQL strings on `pool.query()`. This keeps the stack minimal and makes the SQL visible, which is intentional for a teaching/workshop repo — but it means schema migrations are purely manual.
- **`withRetry` is a startup dependency gate**: Rather than a health-check script or Docker `depends_on: condition: service_healthy`, the API retries the DB connection in-process. This is pragmatic for a small dev setup but means failed DB connections during normal operation would surface as unhandled promise rejections (there's no per-request retry).
- **All user data is fetched once**: `App.tsx` loads all users on mount and stores them in React state. The detail panel re-uses that in-memory data (`setSelected(u)`) rather than fetching `GET /api/users/:id`. That route exists in the API but the current UI never calls it.
`─────────────────────────────────────────────────`

### Step 2: Run `docker compose logs api --tail 200` and summarise what the API has been doing and any errors or warnings.

Clean and uneventful. Here's the summary:

1. **Seed script ran first** (`npm run seed` → `tsx src/seed.ts`) — it connected to Postgres, created the `users` table if missing, upserted the 5 seed rows, and exited cleanly with `seed complete`.
2. **API server started** (`npm run start` → `tsx src/index.ts`) — connected to Postgres successfully (the `withRetry` loop didn't need to retry) and is now listening on port 3001.
3. **No errors, no warnings, no HTTP request logs.** The Express app doesn't add a request logger (no `morgan` or similar middleware), so individual `GET /api/users` calls are silent.

If you want to see per-request activity, you'd need to add a logging middleware like `morgan("dev")` to `api/src/index.ts`.

### Step 3: Using psql (postgresql://tokenlab:tokenlab@localhost:5432/tokenlab), show the users table schema and its rows, and point out anything odd in the data.

### Schema

The table is straightforward:
- `id` — auto-incrementing integer PK (`SERIAL` → `integer` + `users_id_seq`)
- `email` — `TEXT NOT NULL` with a `UNIQUE` constraint
- `created_at` — `TIMESTAMPTZ NOT NULL DEFAULT now()`

Two indexes: the primary key btree on `id`, and a unique btree on `email`.

---

### Data — two things worth noting

**1. `created_at` timestamps are date-only (midnight UTC), not real insertion times.**
Every row has `00:00:00+00`. These were seeded by passing bare date strings (`"2026-11-20"`) directly to the `INSERT` as `$2`, so Postgres cast them to `TIMESTAMPTZ` at midnight UTC. The column's `DEFAULT now()` is never used here — seed.ts always supplies the value explicitly.

**2. The dates are not in chronological order by `id`.**
| id | created_at |
|---|---|
| 3 (alan) | 2026-09-01 |
| 4 (linus) | 2026-06-15 |
| 1 (ada) | 2026-11-20 |
| 2 (grace) | 2026-11-22 |
| 5 (margaret) | 2026-11-23 |

Linus (#4) has the oldest `created_at` (June) but was inserted fourth. Alan (#3) is from September but inserted third. The IDs reflect insertion order from `seed.ts`, not signup chronology — so sorting `ORDER BY id` (what the API does) gives a different order than `ORDER BY created_at`. This is expected for seed data, but could surprise anyone who assumes `id` ≈ join date.

`★ Insight ─────────────────────────────────────`
- **`TIMESTAMPTZ` vs `TIMESTAMP`**: The column stores timezone-aware timestamps. When Postgres receives a bare date string like `'2026-11-20'`, it interprets it as `00:00:00` in the session's timezone (UTC here), producing the midnight values you see. If the app ever accepts user-supplied timestamps in local timezones, the stored offset will differ from row to row — which is usually the right behaviour, but can confuse `ORDER BY created_at` comparisons done in application code rather than SQL.
- **`TEXT` for email**: There's no `CHECK` constraint validating email format — anything non-empty passes. For a workshop repo that's fine, but in production you'd typically add `CHECK (email ~* '^[^@]+@[^@]+\.[^@]+$')` or enforce format at the application layer.
`─────────────────────────────────────────────────`

### Step 4: Add a GET /api/health endpoint to the Express API that returns {"status":"ok"} with HTTP 200.

Both commands need your approval. Here's what was added to `api/src/index.ts:16`:

```ts
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});
```

Once you approve the restart + curl, it should return `{"status":"ok"}` with HTTP 200. The route is intentionally placed before the user routes — not that order matters here, but health checks conventionally come first.

`★ Insight ─────────────────────────────────────`
- **Health endpoints live outside `/api/users`-style resource paths** but inside the same Express app — no DB call needed, so they respond even if Postgres is down. That makes them useful as a liveness probe (is the process alive?) distinct from a readiness probe (can it serve traffic?). If you wanted a readiness check you'd add `pool.query("SELECT 1")` here and return 503 on failure.
`─────────────────────────────────────────────────`

### Step 5: Make GET /api/users/:id return HTTP 400 with an error message when the id is not a positive integer.

The validation rejects anything `Number()` can't turn into a positive integer: strings like `"abc"` become `NaN` (fails `isInteger`), `"0"` and `"-1"` fail the `< 1` check, and `"1.5"` becomes `1.5` (fails `isInteger`).

`★ Insight ─────────────────────────────────────`
- **Why `Number()` + `Number.isInteger()` rather than `parseInt`**: `parseInt("1abc")` silently returns `1` (stops at the first non-digit), so `GET /api/users/1abc` would have hit the DB. `Number("1abc")` gives `NaN`, which fails the integer check immediately.
- **Passing the parsed `id` number to `$1`**: The original code passed `req.params.id` (a string) to the query. The `pg` driver coerces it correctly, but passing the already-validated number is more explicit about what we intend to send.
`─────────────────────────────────────────────────`

### Step 6: Review your changes with git diff and write a pull request description for them - summary, changes, and how to test.

Here's a pull request description for these changes:

---

## Add health endpoint and input validation for user lookup

### Summary

- Adds `GET /api/health` → `{"status":"ok"}` with HTTP 200, suitable as a liveness probe.
- Adds input validation on `GET /api/users/:id` — returns HTTP 400 when the id is not a positive integer, before any DB query is made.

### Changes

**`api/src/index.ts`**

- New `GET /api/health` route that returns `{"status":"ok"}`. No DB dependency — responds even if Postgres is unavailable.
- `GET /api/users/:id` now parses the id with `Number()` and rejects it with 400 if `!Number.isInteger(id) || id < 1`. This catches `NaN` (e.g. `"abc"`), floats (e.g. `"1.5"`), zero, and negatives. The validated number (not the raw string) is passed as the `$1` query parameter.

### How to test

**Health endpoint**
```bash
curl -i http://localhost:3001/api/health
# → HTTP 200  {"status":"ok"}
```

**Valid user lookup**
```bash
curl -i http://localhost:3001/api/users/1
# → HTTP 200  user object

curl -i http://localhost:3001/api/users/999
# → HTTP 404  {"error":"not found"}
```

**Invalid id — expect HTTP 400**
```bash
curl -i http://localhost:3001/api/users/abc
curl -i http://localhost:3001/api/users/0
curl -i http://localhost:3001/api/users/-5
curl -i http://localhost:3001/api/users/1.5
# all → HTTP 400  {"error":"id must be a positive integer"}
```

## Diff

```diff
diff --git a/api/src/index.ts b/api/src/index.ts
index 6165a7f..89d73c3 100644
--- a/api/src/index.ts
+++ b/api/src/index.ts
@@ -12,6 +12,10 @@ app.use((_req, res, next) => {
   next();
 });
 
+app.get("/api/health", (_req, res) => {
+  res.json({ status: "ok" });
+});
+
 // List all users.
 app.get("/api/users", async (_req, res) => {
   const { rows } = await pool.query(
@@ -22,9 +26,14 @@ app.get("/api/users", async (_req, res) => {
 
 // Get a single user by id.
 app.get("/api/users/:id", async (req, res) => {
+  const id = Number(req.params.id);
+  if (!Number.isInteger(id) || id < 1) {
+    res.status(400).json({ error: "id must be a positive integer" });
+    return;
+  }
   const { rows } = await pool.query(
     "SELECT id, email, created_at FROM users WHERE id = $1",
-    [req.params.id]
+    [id]
   );
   if (rows.length === 0) {
     res.status(404).json({ error: "not found" });
```

## Denied by permissions

- Bash {"command":"curl -s http://localhost:3001/api/health","description":"Hit the health endpoint"}
- Bash {"command":"docker compose restart api && sleep 2 && curl -s http://localhost:3001/api/health","description":"Restart API container and hit the health endpoint"}

## Usage

```json
{
  "input_tokens": 31,
  "output_tokens": 4755,
  "cache_read_input_tokens": 671791,
  "cache_creation_input_tokens": 28959,
  "total_tokens": 705536,
  "cost_usd": 0.44670930000000003,
  "num_turns": 21,
  "permission_denials": 2
}
```
