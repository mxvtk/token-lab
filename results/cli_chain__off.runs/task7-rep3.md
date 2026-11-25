# cli_chain__off task 7 rep 3

Grade: "/api/health added; non-numeric :id returns 400; only api/ files changed; PR description written"

## Agent result

### Step 1: Read every file in api/src and web/src and explain how the app fits together - request flow from the React page to Postgres.

Here's the full request flow from the React page to Postgres:

---

## Architecture Overview

The app is a minimal full-stack: **Vite/React** → **Express API** → **node-postgres** → **Postgres**.

---

### 1. Browser boot (`web/src/main.tsx`)

```
document#root → React.StrictMode → <App />
```

`main.tsx` is the entry point. It mounts `<App>` into the DOM once — no router, no context providers. The simplest possible React bootstrap.

---

### 2. Data fetch (`web/src/App.tsx`)

On first render, `useEffect` fires a `fetch` to `GET /api/users`:

```
VITE_API_URL (env var, default http://localhost:3001)
  → fetch(`${API}/api/users`)
  → setUsers(rows) | setError(message)
```

`★ Insight ─────────────────────────────────────`
- `import.meta.env.VITE_API_URL` is Vite's typed env-var mechanism — anything prefixed `VITE_` is inlined at build time. At runtime this is just a string constant, not a live lookup. The fallback `?? "http://localhost:3001"` only applies in dev when the var is unset.
- The component has three render states gated by null-checks: loading (`users === null`), error (`error !== null`), and data. This is the classic React data-fetching state machine. `selected` is a fourth, additive state for the detail panel.
`─────────────────────────────────────────────────`

---

### 3. HTTP routing (`api/src/index.ts`)

Express listens on `PORT` (default 3001). Two routes:

| Route | SQL |
|---|---|
| `GET /api/users` | `SELECT id, email, created_at FROM users ORDER BY id` |
| `GET /api/users/:id` | `SELECT … WHERE id = $1` |

The CORS middleware (`Access-Control-Allow-Origin: *`) is a development convenience so the Vite dev server on a different port can call the API without being blocked by the browser's same-origin policy.

Startup uses `withRetry` to poll `SELECT 1` before `app.listen`, so the Express process won't start accepting traffic until Postgres is ready.

---

### 4. Database layer (`api/src/db.ts`)

```
pg.Pool  ←  env vars (PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE)
             defaults: host=db, port=5432, user/pass/db=tokenlab
```

`withRetry` wraps any `() => Promise<T>` in a retry loop — 10 attempts, 1 s apart. Used both at startup (health check) and in `seed.ts` before schema creation.

`★ Insight ─────────────────────────────────────`
- `pg.Pool` maintains a pool of persistent TCP connections to Postgres so each HTTP request doesn't pay TCP + TLS handshake overhead. The pool is module-level (singleton), so it's shared across all route handlers.
- The `$1` placeholder in queries is PostgreSQL's parameterized query syntax (not `?` like MySQL/SQLite). `node-postgres` sends the query and parameters separately, so the driver — not your code — handles escaping. This eliminates SQL injection at the driver level.
`─────────────────────────────────────────────────`

---

### 5. Schema & seed (`api/src/seed.ts`)

A one-shot script (not part of the Express server) that:
1. Waits for Postgres via `withRetry`
2. `CREATE TABLE IF NOT EXISTS users (id SERIAL, email TEXT UNIQUE, created_at TIMESTAMPTZ)`
3. Inserts 5 rows with `ON CONFLICT (email) DO NOTHING` — idempotent, safe to re-run

---

### Full request trace

```
Browser
  useEffect → fetch GET /api/users
    ↓ HTTP (port 3001)
Express (api/src/index.ts)
  app.get("/api/users", handler)
    ↓ pool.query(SQL)
node-postgres Pool (api/src/db.ts)
    ↓ TCP (port 5432, host "db")
Postgres
  SELECT id, email, created_at FROM users ORDER BY id
    ↑ rows[]
Express → res.json(rows)
    ↑ HTTP 200 JSON
React → setUsers(rows) → re-render list
```

The whole stack is about as thin as it gets — no ORM, no state manager, no router. The seeder (`seed.ts`) is the only place schema lives; there's no migration framework.

### Step 2: Run `docker compose logs api --tail 200` and summarise what the API has been doing and any errors or warnings.

Clean run, nothing alarming. Here's what happened:

1. **Seed script ran first** (`npm run seed` → `tsx src/seed.ts`) — connected to Postgres, created the `users` table (if missing), inserted the 5 seed rows, and exited cleanly with `seed complete`.
2. **Express server started** (`npm run start` → `tsx src/index.ts`) — came up on port 3001 without errors.

**No errors, no warnings.** The API is healthy and idle — it hasn't logged any inbound HTTP requests yet (Express only logs what you explicitly `console.log`, and the route handlers don't).

### Step 3: Using psql (postgresql://tokenlab:tokenlab@localhost:5432/tokenlab), show the users table schema and its rows, and point out anything odd in the data.

### Schema

| Column | Type | Notes |
|---|---|---|
| `id` | `integer` | PK, auto-increment via sequence |
| `email` | `text` | NOT NULL, UNIQUE index |
| `created_at` | `timestamptz` | NOT NULL, defaults to `now()` |

Indexes: primary key on `id`, unique constraint on `email`.

### Data

5 seed rows — ada, grace, alan, linus, margaret (the computing pioneers theme is deliberate).

### Oddities worth noting

1. **`created_at` times are all midnight UTC (`00:00:00+00`).** This is because the seed inserts a plain date string (`"2026-11-20"`) rather than a full timestamp. Postgres casts it to `timestamptz` by assuming midnight UTC. Real signup timestamps would have a time component, so this is a quick tell that a row was seeded rather than organically created.

2. **Dates are out of chronological order relative to id.** Alan (id 3) signed up `2026-09-01` and Linus (id 4) on `2026-06-15` — both earlier than Ada (id 1, `2026-11-20`). The id sequence reflects insertion order (the seed script), not signup date. If you ever sort by `id` expecting chronological order, you'll get the wrong result.

3. **`email` column is plain `text` with no format constraint.** There's no `CHECK` constraint validating it looks like an email address — the database would happily accept `"not-an-email"`. Fine for a workshop, but worth flagging for production use.

`★ Insight ─────────────────────────────────────`
- `timestamptz` (timestamp with time zone) stores the instant in UTC internally and converts on output based on the session's `timezone` setting. The `+00` suffix here means the session is running in UTC. If your app server were in a different timezone, the display would shift — but the stored value is always the same absolute instant.
- `SERIAL` is syntactic sugar for `integer NOT NULL DEFAULT nextval(...)` — Postgres creates the sequence `users_id_seq` automatically. Gaps in the sequence (from rolled-back inserts) are normal and expected; don't use id values to infer row count.
`─────────────────────────────────────────────────`

### Step 4: Add a GET /api/health endpoint to the Express API that returns {"status":"ok"} with HTTP 200.

The endpoint has been added. The TypeScript diagnostics shown are pre-existing — they affect all the original route handlers too (implicit `any` on Express params from missing `@types/express`) and aren't introduced by this change.

The curl to verify needs your approval. Once you allow it, it should return:

```json
{"status":"ok"}
```

`★ Insight ─────────────────────────────────────`
- Health endpoints are conventionally placed before authenticated/resource routes so load balancers and container orchestrators (Kubernetes liveness/readiness probes, Docker healthcheck) can reach them without any middleware or auth logic running. Here it sits above the CORS middleware for the same reason — though in this setup that doesn't matter since CORS is applied via `app.use` before any route is registered.
- Returning `{"status":"ok"}` rather than a bare `200 OK` lets HTTP clients that only inspect the body (some monitoring tools) also confirm the API is alive without parsing status codes.
`─────────────────────────────────────────────────`

### Step 5: Make GET /api/users/:id return HTTP 400 with an error message when the id is not a positive integer.

The guard works as follows:

- `Number("abc")` → `NaN`, `Number.isInteger(NaN)` → `false` → **400**
- `Number("0")` → `0`, `0 < 1` → **400**
- `Number("-3")` → `-3`, `-3 < 1` → **400**
- `Number("1.5")` → `1.5`, `Number.isInteger(1.5)` → `false` → **400**
- `Number("2")` → `2`, passes → query runs → **200** or **404**

The validated `id` (now a JS `number`) also replaces the raw string in the `$1` binding, so node-postgres sends a typed integer to Postgres rather than a string it has to coerce.

### Step 6: Review your changes with git diff and write a pull request description for them - summary, changes, and how to test.

Here's a pull request description for these changes:

---

**Add health endpoint and validate user ID parameter**

## Summary

- Adds `GET /api/health` for liveness checks
- Validates the `:id` path parameter on `GET /api/users/:id`, returning HTTP 400 for non-positive-integer values instead of leaking a Postgres error or silently returning 404

## Changes

**`api/src/index.ts`**

- New `GET /api/health` route — returns `{"status":"ok"}` with HTTP 200. Placed before resource routes so it's reachable without any middleware dependencies (useful for load-balancer probes).
- In `GET /api/users/:id`: parse `req.params.id` with `Number()` and reject with 400 if the result is not a whole number ≥ 1. The parsed integer (not the raw string) is now passed to the `$1` binding, so node-postgres sends a typed value to Postgres.

## How to test

```bash
# Health check
curl -i http://localhost:3001/api/health
# → 200 {"status":"ok"}

# Valid id
curl -i http://localhost:3001/api/users/1
# → 200 {id, email, created_at}

# Non-existent but valid id
curl -i http://localhost:3001/api/users/9999
# → 404 {"error":"not found"}

# Invalid inputs — all should return 400
curl -i http://localhost:3001/api/users/abc
curl -i http://localhost:3001/api/users/0
curl -i http://localhost:3001/api/users/-5
curl -i http://localhost:3001/api/users/1.5
# → 400 {"error":"id must be a positive integer"}
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

- Bash {"command":"curl -s http://localhost:3001/api/health","description":"Test the health endpoint"}

## Usage

```json
{
  "input_tokens": 29,
  "output_tokens": 4788,
  "cache_read_input_tokens": 583565,
  "cache_creation_input_tokens": 28816,
  "total_tokens": 617198,
  "cost_usd": 0.4198725,
  "num_turns": 19,
  "permission_denials": 1
}
```
