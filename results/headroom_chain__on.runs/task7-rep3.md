# headroom_chain__on task 7 rep 3

Grade: "/api/health added; non-numeric :id returns 400; only api/ files changed; PR description written"

## Agent result

### Step 1: Read every file in api/src and web/src and explain how the app fits together - request flow from the React page to Postgres.

`★ Insight ─────────────────────────────────────`
- **`import.meta.env.VITE_API_URL`** is Vite's way of injecting build-time env vars into the browser bundle — anything prefixed `VITE_` becomes statically replaced at bundle time, while un-prefixed vars stay server-side-only.
- **`withRetry`** in `db.ts` exists because Docker Compose brings containers up in parallel; Postgres isn't guaranteed to accept connections before the Node process starts, so retrying `SELECT 1` every second is a cheap health-gate that removes the need for a separate `wait-for-it.sh` script.
- **`ON CONFLICT (email) DO NOTHING`** in `seed.ts` makes the seed idempotent — you can re-run it on every container start without duplicating rows.
`─────────────────────────────────────────────────`

Here's the full request flow, layer by layer:

---

## App Architecture: React → Express → Postgres

```
Browser (Vite dev server :5173)
  └── web/src/main.tsx        entry point, mounts <App /> into #root
        └── web/src/App.tsx   the whole UI; fires one fetch on mount
              │
              │  GET http://localhost:3001/api/users
              ▼
Express server (:3001)
  └── api/src/index.ts        registers GET /api/users and GET /api/users/:id
        └── api/src/db.ts     exports `pool` (pg.Pool) and `withRetry`
              │
              │  SQL: SELECT id, email, created_at FROM users ORDER BY id
              ▼
Postgres (:5432)
  └── users table             created and seeded by api/src/seed.ts
```

---

### Layer 1 — `web/src/main.tsx`
Pure bootstrap: creates a React root on `#root` and renders `<App />` inside `StrictMode`. Nothing application-specific lives here.

### Layer 2 — `web/src/App.tsx`
The entire frontend is one component. On mount (`useEffect` with `[]`), it fires:
```
GET {VITE_API_URL}/api/users
```
`VITE_API_URL` defaults to `http://localhost:3001`. The response (`User[]`) is stored in state. Clicking a user row stores it in `selected` and renders a detail section — no second fetch; the full object is already in memory from the list call.

### Layer 3 — `api/src/index.ts`
An Express app with two routes:

| Route | Query |
|---|---|
| `GET /api/users` | `SELECT id, email, created_at FROM users ORDER BY id` |
| `GET /api/users/:id` | `SELECT … WHERE id = $1` (returns 404 if missing) |

A CORS wildcard header (`Access-Control-Allow-Origin: *`) is set on every response so the Vite dev server on port 5173 can call the API on port 3001 without browser blocking.

Startup is gated: `withRetry(() => pool.query("SELECT 1"))` polls until Postgres is ready, then `app.listen` runs. This tolerates the Docker Compose race.

### Layer 4 — `api/src/db.ts`
Creates a `pg.Pool` with connection settings read from environment variables (`PGHOST`, `PGPORT`, etc.), defaulting to the `db` hostname (the Docker Compose service name) and the `tokenlab` database. `withRetry` is a generic 10-attempt retry wrapper reused by both `index.ts` and `seed.ts`.

### Layer 5 — `api/src/seed.ts` (startup utility, not in the request path)
Runs once at container init. Creates the `users` table if it doesn't exist, then inserts 5 rows idempotently with `ON CONFLICT (email) DO NOTHING`. It reuses the same `pool`/`withRetry` from `db.ts`, then calls `pool.end()` to exit cleanly.

---

**In one sentence**: the React app fires a single `fetch` on mount, Express translates it to a parameterized SQL query via `pg.Pool`, and Postgres returns rows that are rendered directly as a list — no ORM, no state management library, no routing layer.

### Step 2: Run `docker compose logs api --tail 200` and summarise what the API has been doing and any errors or warnings.

Clean slate — the logs are short and healthy:

| Step | What happened |
|---|---|
| `seed complete` | `src/seed.ts` ran (`npm run seed`), created the `users` table if absent, inserted the 5 seed rows, and exited cleanly. |
| `api listening on :3001` | `src/index.ts` started, `withRetry` confirmed Postgres was reachable, and Express bound to port 3001. |

**No errors, no warnings.** The container has started exactly once and is currently sitting idle waiting for HTTP requests. There's no inbound traffic recorded in these logs because Express doesn't log requests by default (there's no morgan/winston middleware wired up).

### Step 3: Using psql (postgresql://tokenlab:tokenlab@localhost:5432/tokenlab), show the users table schema and its rows, and point out anything odd in the data.

### Schema

| Column | Type | Constraints |
|---|---|---|
| `id` | `integer` | PK, auto-increment (`SERIAL`) |
| `email` | `text` | `NOT NULL`, `UNIQUE` |
| `created_at` | `timestamptz` | `NOT NULL`, default `now()` |

Indexes: primary key on `id`, unique B-tree on `email`.

### Rows

| id | email | created_at |
|---|---|---|
| 1 | ada@example.com | 2026-11-20 |
| 2 | grace@example.com | 2026-11-22 |
| 3 | alan@example.com | 2026-09-01 |
| 4 | linus@example.com | 2026-06-15 |
| 5 | margaret@example.com | 2026-11-23 |

### Oddities worth noting

1. **`created_at` times are all exactly midnight UTC (`00:00:00+00`)** — this is because `seed.ts` inserts date strings (`"2026-11-20"`) without a time component, so Postgres casts them to `timestamptz` as midnight. Real signup timestamps would have sub-second precision.

2. **Two rows are out of chronological order by id** — ids 3 (`alan`, Sep 1) and 4 (`linus`, Jun 15) have `created_at` values months earlier than ids 1–2, meaning the seed data isn't ordered by signup date. If anything queries `ORDER BY id` and assumes that's also chronological order, it will get a misleading result.

3. **All five rows are still in the future** relative to today (2026-11-25 is today, and three rows have dates of Nov 20–23 — so those are recent but past; however ids 3 and 4 are from earlier in 2026, which is consistent). No real anomaly here beyond the seed being fictional data.

The schema itself is clean — no missing indexes for the query patterns the API uses, and the `UNIQUE` constraint on `email` correctly backs the `ON CONFLICT` upsert in `seed.ts`.

### Step 4: Add a GET /api/health endpoint to the Express API that returns {"status":"ok"} with HTTP 200.

The curl was blocked by permissions — you can verify it yourself with:

```bash
curl -s http://localhost:3001/api/health
```

**Note on the TypeScript diagnostics**: all the errors shown (`implicit any`, `Cannot find module 'express'`) are pre-existing across the whole file — they appear on lines 1, 8, 15, 20, 28, none of which I changed. They're a type-declaration environment issue, not runtime problems (`tsx` runs the code fine regardless). My addition on the new line follows the exact same pattern as the existing routes.

`★ Insight ─────────────────────────────────────`
- The TypeScript errors are likely because `@types/express` isn't installed or the `tsconfig` doesn't include `node_modules/@types`. Since the project runs via `tsx` (which transpiles without type-checking), these are latent linting issues rather than runtime blockers.
- The `_req` naming convention (underscore prefix) already used in the file signals to TypeScript that the parameter is intentionally unused — which is exactly the right pattern for a health endpoint that ignores the request entirely.
`─────────────────────────────────────────────────`

The route is in place. Once the container hot-reloads (or restarts), `GET /api/health` will return `{"status":"ok"}` with HTTP 200.

### Step 5: Make GET /api/users/:id return HTTP 400 with an error message when the id is not a positive integer.

Done. The guard runs before the DB query:

- `GET /api/users/abc` → `Number("abc")` is `NaN`, fails the integer check → **400** `{"error":"id must be a positive integer"}`
- `GET /api/users/0` → `0 < 1` → **400**
- `GET /api/users/-5` → `-5 < 1` → **400**
- `GET /api/users/1.5` → `Number("1.5")` is `1.5`, not an integer → **400**
- `GET /api/users/3` → passes, proceeds to the existing DB query and 404/200 logic

### Step 6: Review your changes with git diff and write a pull request description for them - summary, changes, and how to test.

---

## Pull Request: API health endpoint and input validation for user lookup

### Summary

Two small additions to `api/src/index.ts`:

1. **`GET /api/health`** — a lightweight liveness endpoint for load balancers, Docker health checks, and uptime monitors. Returns `{"status":"ok"}` with HTTP 200. No auth, no DB hit.

2. **Input validation on `GET /api/users/:id`** — before the SQL query runs, the `:id` param is checked to be a positive integer. Invalid values (strings, floats, zero, negatives) now return HTTP 400 with `{"error":"id must be a positive integer"}` instead of leaking a Postgres cast error as a 500.

### Changes

| File | Change |
|---|---|
| `api/src/index.ts` | Add `GET /api/health` route (+3 lines) |
| `api/src/index.ts` | Add `id` guard in `GET /api/users/:id` (+5 lines) |

### How to test

**Health endpoint**
```bash
curl -i http://localhost:3001/api/health
# expect: HTTP/1.1 200 OK
# body:   {"status":"ok"}
```

**Valid user lookup (unchanged behaviour)**
```bash
curl -i http://localhost:3001/api/users/1   # 200 + user object
curl -i http://localhost:3001/api/users/999 # 404 {"error":"not found"}
```

**Invalid id — now 400 instead of 500**
```bash
curl -i http://localhost:3001/api/users/abc  # 400 {"error":"id must be a positive integer"}
curl -i http://localhost:3001/api/users/0    # 400
curl -i http://localhost:3001/api/users/-1   # 400
curl -i http://localhost:3001/api/users/1.5  # 400
```

## Diff

```diff
diff --git a/api/src/index.ts b/api/src/index.ts
index 6165a7f..c724102 100644
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
@@ -22,6 +26,11 @@ app.get("/api/users", async (_req, res) => {
 
 // Get a single user by id.
 app.get("/api/users/:id", async (req, res) => {
+  const id = Number(req.params.id);
+  if (!Number.isInteger(id) || id < 1) {
+    res.status(400).json({ error: "id must be a positive integer" });
+    return;
+  }
   const { rows } = await pool.query(
     "SELECT id, email, created_at FROM users WHERE id = $1",
     [req.params.id]
```

## Denied by permissions

- Bash {"command":"curl -s http://localhost:3001/api/health","description":"Hit the new health endpoint"}

## Usage

```json
{
  "input_tokens": 29,
  "output_tokens": 4841,
  "cache_read_input_tokens": 624306,
  "cache_creation_input_tokens": 64875,
  "total_tokens": 694051,
  "cost_usd": 0.6492437999999999,
  "num_turns": 19,
  "permission_denials": 1
}
```
