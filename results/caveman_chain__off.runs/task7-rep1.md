# caveman_chain__off task 7 rep 1

Grade: "/api/health added; non-numeric :id returns 400; only api/ files changed; PR description written"

## Agent result

### Step 1: Read every file in api/src and web/src and explain how the app fits together - request flow from the React page to Postgres.

`★ Insight ─────────────────────────────────────`
- **`import.meta.env.VITE_API_URL`** is Vite's way of injecting build-time env vars into the browser bundle — any `VITE_*` variable in `.env` is replaced at bundle time, so the API base URL can differ between dev (`localhost:3001`) and production without changing source code.
- **`$1` parameterized queries** in `pg` prevent SQL injection by keeping the value out of the SQL string — the driver sends them as separate protocol-level parameters, never string-interpolated.
- **`withRetry`** exists because Docker Compose starts all containers simultaneously; the Node process often boots before Postgres is ready to accept connections, so the API needs to poll until the DB is live.
`─────────────────────────────────────────────────`

---

## Request flow: React → Express → pg → Postgres

Here is the full path for the user list fetch:

```
browser
  └─ main.tsx          mounts <App /> into #root
      └─ App.tsx
          useEffect on mount
          └─ fetch("http://localhost:3001/api/users")
                │
                │  HTTP GET  (plain fetch, no library)
                ▼
api/src/index.ts   Express router
  app.get("/api/users", ...)
  └─ pool.query("SELECT id, email, created_at FROM users ORDER BY id")
        │
        │  wire protocol (TCP, port 5432)
        ▼
  api/src/db.ts   pg.Pool
        │  connection pooled; env vars → host/user/pass/db
        ▼
  Postgres container   "tokenlab" database
        └─ users table (created by seed.ts at startup)
```

### Layer by layer

| File | Role |
|---|---|
| `web/src/main.tsx` | Entry point — calls `createRoot` and renders `<App />` inside `React.StrictMode`. |
| `web/src/App.tsx` | Single-page UI. `useEffect` fires once on mount, `fetch`es `/api/users`, stores rows in `useState`. Clicking a row fetches nothing extra — it just sets `selected` from the already-loaded list. |
| `api/src/index.ts` | Express server on port 3001. Two routes: `GET /api/users` (all rows) and `GET /api/users/:id` (one row). Manual CORS headers let the Vite dev server (port 5173) call it. Waits for DB via `withRetry` before binding. |
| `api/src/db.ts` | Exports a `pg.Pool` configured from env vars with safe defaults matching the Docker Compose service name `db`. Also exports `withRetry` — a simple 10-attempt, 1 s delay polling loop. |
| `api/src/seed.ts` | A one-shot script (not imported by the server). Runs `CREATE TABLE IF NOT EXISTS`, then upserts five hard-coded rows using `ON CONFLICT (email) DO NOTHING` so reruns are idempotent. |

### One thing worth noting

`App.tsx` line 20 has a deliberate bug — `users[0].email` crashes before the fetch resolves because `users` starts as `[]`. The comment marks it as eval task 2, so it's an intentional exercise left for workshop participants to fix (guard with `users[0]?.email ?? ''` or by checking array length first).

### Step 2: Run `docker compose logs api --tail 200` and summarise what the API has been doing and any errors or warnings.

Clean logs — here's the summary:

**Startup sequence (normal, no errors)**

1. **Seed ran first** — `npm run seed` executed `src/seed.ts`, connected to Postgres, applied the schema and upserted the five seed rows, then exited cleanly (`seed complete`).
2. **Server started** — `npm run start` launched `src/index.ts` and Express bound successfully to port 3001 (`api listening on :3001`).

**No errors, no warnings.** The `withRetry` loop in `db.ts` didn't need to log anything, which means Postgres was already accepting connections by the time both scripts reached their `pool.query("SELECT 1")` probe — Docker Compose timing was fine this run.

The API has received no HTTP requests since it started (no access log lines), so it's sitting idle and healthy.

### Step 3: Using psql (postgresql://tokenlab:tokenlab@localhost:5432/tokenlab), show the users table schema and its rows, and point out anything odd in the data.

`★ Insight ─────────────────────────────────────`
- **`SERIAL` vs `BIGSERIAL`**: the `id` column is `integer` (max ~2.1 billion). For a production users table that could grow large, `BIGSERIAL` / `bigint` is safer — it costs nothing at this scale but avoids a painful migration later.
- **`TIMESTAMPTZ` is the right choice**: storing timestamps with timezone (`timestamp with time zone`) means Postgres normalises everything to UTC internally and renders it in the session timezone on output — far safer than `timestamp` (no-tz) which silently drops offset info.
- **Midnight timestamps signal hand-entered dates**: every `created_at` is exactly `00:00:00+00`, which means they came from the seed script's date strings (`"2026-11-20"` etc.), not from `DEFAULT now()` at real insert time.
`─────────────────────────────────────────────────`

---

**Schema** — straightforward: `id` (auto-increment PK), `email` (non-null, unique), `created_at` (timestamptz, default `now()`).

**Data** — 5 seed rows, all healthy. Two things worth noting:

1. **All timestamps are midnight UTC** (`00:00:00+00`) — these are date-only strings coerced to timestamps by the seed script, not real wall-clock insert times. If `created_at` is meant to record when an account was actually created, it won't be accurate for seeded rows.

2. **`created_at` ordering doesn't match `id` ordering** — ids 3 and 4 (alan, linus) have significantly older dates (September and June 2026) while ids 1, 2, 5 are from November 2026. That's fine for seed data but would look strange in a UI that implies "recently joined" ordering by `id`.

Everything else is clean — no nulls, no duplicate emails, constraints are intact.

### Step 4: Add a GET /api/health endpoint to the Express API that returns {"status":"ok"} with HTTP 200.

The curl needs your approval to run — please allow it if you'd like to verify live. The endpoint was added successfully.

`★ Insight ─────────────────────────────────────`
- The TypeScript diagnostics shown are **pre-existing** — `Cannot find module 'express'` and the implicit `any` parameter errors were already present on every route before this change. My new handler follows the identical pattern as the existing ones, so it introduces no new type issues.
- A synchronous route handler (no `async`, no DB call) is correct here — health checks should be **fast and dependency-free** so a load balancer gets an immediate `200` even if the event loop is busy. Hitting the DB in a health check can cause false negatives under load.
`─────────────────────────────────────────────────`

The added code in `api/src/index.ts`:

```ts
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});
```

It sits before the user routes and returns `{"status":"ok"}` with HTTP 200. No restart needed — `tsx` watches the file and will reload automatically if the container is running in watch mode.

### Step 5: Make GET /api/users/:id return HTTP 400 with an error message when the id is not a positive integer.

The guard is in place. Here's what it covers:

| Input | `Number(x)` | `isInteger` | `>= 1` | Result |
|---|---|---|---|---|
| `"42"` | `42` | ✓ | ✓ | proceeds to DB |
| `"0"` | `0` | ✓ | ✗ | 400 |
| `"-5"` | `-5` | ✓ | ✗ | 400 |
| `"abc"` | `NaN` | ✗ | — | 400 |
| `"3.5"` | `3.5` | ✗ | — | 400 |
| `"3abc"` | `NaN` | ✗ | — | 400 |

The validated `id` (a JS number) is also passed to `pool.query` instead of the raw string, keeping the types consistent with what the query expects.

### Step 6: Review your changes with git diff and write a pull request description for them - summary, changes, and how to test.

`★ Insight ─────────────────────────────────────`
- The diff shows the working tree contains many unrelated changes (eval runner, scoreboard rewrite, README, results files). A focused PR should cover only the two API changes — keeping scope tight makes review faster and rollback safer.
- The `api/src/index.ts` changes are small and self-contained: 4 lines added for the health route, 5 lines for the id guard. Both changes have zero dependencies on the larger eval refactor.
`─────────────────────────────────────────────────`

---

Here is the PR description for the two `api/src/index.ts` changes:

---

**Add `/api/health` endpoint and input validation for `/api/users/:id`**

## Summary

Two small hardening changes to the Express API:

- `GET /api/health` gives load balancers and uptime monitors a cheap, dependency-free liveness signal.
- `GET /api/users/:id` now rejects non-positive-integer ids with a clear `400` before the query reaches Postgres, preventing type coercion surprises and unnecessary DB round-trips.

## Changes

**`api/src/index.ts`**

| Change | Detail |
|---|---|
| `GET /api/health` | Synchronous handler; returns `{"status":"ok"}` with `200`. No DB call — intentional, so it stays fast under load. |
| Input guard on `GET /api/users/:id` | Converts `req.params.id` (always a string) to a number with `Number()`, then rejects with `400` if `!Number.isInteger(id) \|\| id < 1`. Covers `"abc"`, `"3.5"`, `"0"`, `"-5"`, and `"3abc"` (which `parseInt` would silently accept as `3`). The validated number is passed to `pool.query` instead of the raw string. |

## How to test

**Health endpoint**
```bash
curl -i http://localhost:3001/api/health
# expect: HTTP/1.1 200 OK
# body:   {"status":"ok"}
```

**Valid user id**
```bash
curl -i http://localhost:3001/api/users/1
# expect: 200 with user object
```

**Bad ids → 400**
```bash
curl -i http://localhost:3001/api/users/abc
curl -i http://localhost:3001/api/users/0
curl -i http://localhost:3001/api/users/-1
curl -i http://localhost:3001/api/users/3.5
# all expect: HTTP/1.1 400 Bad Request
# body:        {"error":"id must be a positive integer"}
```

**Non-existent valid id → 404 (unchanged)**
```bash
curl -i http://localhost:3001/api/users/9999
# expect: HTTP/1.1 404
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

## Usage

```json
{
  "input_tokens": 30,
  "output_tokens": 5130,
  "cache_read_input_tokens": 690726,
  "cache_creation_input_tokens": 49123,
  "total_tokens": 745009,
  "cost_usd": 1.9466427,
  "num_turns": 20
}
```
