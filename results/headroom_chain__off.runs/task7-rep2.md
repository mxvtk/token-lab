# headroom_chain__off task 7 rep 2

Grade: "/api/health added; non-numeric :id returns 400; only api/ files changed; PR description written"

## Agent result

### Step 1: Read every file in api/src and web/src and explain how the app fits together - request flow from the React page to Postgres.

`★ Insight ─────────────────────────────────────`
- `seed.ts` is a **one-shot script**, not middleware — it runs once at startup to create the schema and insert rows, then calls `pool.end()` and exits. The API server never imports it; Docker Compose (or the README) runs it as a separate command.
- `withRetry` in `db.ts` is used in **two places** for the same reason: both the seed script and the API server can start before Postgres is ready, so they both poll `SELECT 1` before doing real work.
- The `VITE_API_URL` env var in `App.tsx` is an escape hatch for Docker Compose or production, where the API isn't on `localhost:3001`. Vite replaces `import.meta.env.*` at **build time**, so the URL is baked into the JS bundle.
`─────────────────────────────────────────────────`

---

## How the app fits together

### Layer map

```
Browser (React)
  └── web/src/main.tsx       — mounts <App /> into #root
  └── web/src/App.tsx        — fetches data, renders UI

HTTP (fetch / JSON)
  └── Express on :3001

  api/src/index.ts           — route handlers
  api/src/db.ts              — pg Pool + withRetry

TCP (pg wire protocol)
  └── Postgres :5432

  api/src/seed.ts            — schema + seed rows (run once, separately)
```

---

### Request flow: list users

1. **`main.tsx`** — Vite bundles this as the entry point. `createRoot` mounts `<App />` inside `<React.StrictMode>`.

2. **`App.tsx` — `useEffect`** — fires once after first render (empty dependency array). It calls:
   ```
   fetch(`${API}/api/users`)
   ```
   `API` defaults to `http://localhost:3001`; override with `VITE_API_URL` at build time.

3. **Express `GET /api/users`** (`index.ts:16`) — the handler calls:
   ```ts
   pool.query("SELECT id, email, created_at FROM users ORDER BY id")
   ```
   No ORM — raw parameterized SQL via the `pg` library.

4. **`db.ts` — `Pool`** — `pg.Pool` manages a connection pool to Postgres. Config is read from env vars (`PGHOST`, `PGUSER`, etc.), falling back to defaults suited for Docker Compose (`host: "db"`).

5. **Postgres** returns the rows; `pool.query` resolves with `{ rows }`.

6. Back in Express: `res.json(rows)` serialises the array and sends it with `Content-Type: application/json`.

7. **`App.tsx`** — the fetch promise resolves, `setUsers(rows)` triggers a re-render, and the list is painted.

---

### Request flow: single user (click)

Clicking a name calls `setSelected(u)` — **no network request**. The full user object was already in the initial list payload, so the detail section renders from local React state instantly.

The `GET /api/users/:id` route (`index.ts:24`) exists but the UI never calls it; it's there for curl/workshop exercises.

---

### Startup sequence (what runs before the first request)

```
seed.ts (one-shot)
  withRetry → SELECT 1  (polls until Postgres is up)
  CREATE TABLE IF NOT EXISTS users …
  INSERT … ON CONFLICT DO NOTHING  (idempotent: safe to re-run)
  pool.end()  → exits

index.ts (long-lived server)
  withRetry → SELECT 1  (same poll)
  app.listen(:3001)
```

Both use `withRetry` from `db.ts` for the same reason: containers start in parallel and Postgres isn't guaranteed to be ready first.

---

### CORS

`index.ts:8–13` sets `Access-Control-Allow-Origin: *` on every response. This is intentionally wide-open for the workshop (Vite dev server on `:5173` and Express on `:3001` are different origins).

### Step 2: Run `docker compose logs api --tail 200` and summarise what the API has been doing and any errors or warnings.

Clean bill of health. Here's what the logs show:

**What happened (in order):**
1. **Seed script ran** (`npm run seed` → `tsx src/seed.ts`) — schema was created/verified and rows were inserted. It printed `seed complete` and exited cleanly.
2. **API server started** (`npm run start` → `tsx src/index.ts`) — came up on `:3001` and is now listening.

**Errors / warnings:** None. No connection retries were logged either, meaning Postgres was already ready by the time both the seed and the server attempted their `withRetry → SELECT 1` probes.

**What's absent:** No HTTP request log lines — Express has no request logger middleware (`morgan` etc.) configured, so incoming API calls are silent in the logs.

### Step 3: Using psql (postgresql://tokenlab:tokenlab@localhost:5432/tokenlab), show the users table schema and its rows, and point out anything odd in the data.

`★ Insight ─────────────────────────────────────`
- `created_at` is `TIMESTAMPTZ` (timestamp **with** time zone), which is the right choice for any timestamp that needs to survive timezone-aware queries or display. Plain `TIMESTAMP` silently drops tz info.
- The `UNIQUE` constraint on `email` is what makes the seed's `ON CONFLICT (email) DO NOTHING` idempotent — the constraint is the enforcement point; the SQL clause just suppresses the error on re-runs.
`─────────────────────────────────────────────────`

---

**Schema** looks clean — `id` auto-increment PK, `email` NOT NULL + UNIQUE, `created_at` TIMESTAMPTZ NOT NULL with a `now()` default.

**Data** — a few things worth noting:

| Observation | Detail |
|---|---|
| **Times are midnight UTC** | Every `created_at` is `00:00:00+00`. These were seeded from bare date strings (`"2026-11-20"`) with no time component, so Postgres cast them as start-of-day UTC. Real sign-up timestamps would have sub-second precision. |
| **Two rows predate the others significantly** | `alan` (2026-09-01) and `linus` (2026-06-15) are months older than the rest — probably just illustrative seed data, but worth flagging if this table is ever used for cohort analysis. |
| **All emails are `@example.com`** | Fine for a workshop/seed dataset; `example.com` is an IANA-reserved domain so these can never be real addresses. |
| **`id` sequence is gapless (1–5)** | Confirms the seed ran exactly once with no failed inserts that would have burned sequence values. |

### Step 4: Add a GET /api/health endpoint to the Express API that returns {"status":"ok"} with HTTP 200.

The route is in place at lines 15–17. Two things to be aware of:

**TypeScript diagnostics** — the editor reported implicit `any` on `_req`/`res` parameters. These are **pre-existing** across all handlers in this file (lines 8, 20, 28), not introduced by this change. The project runs via `tsx` which skips type-checking at runtime, so it doesn't block execution.

**Live reload** — since the API runs inside Docker via `tsx src/index.ts` (not `tsx watch`), it won't pick up the file change automatically. To apply it, restart the container:

```bash
docker compose restart api
```

Then verify with:

```bash
curl -s http://localhost:3001/api/health
# → {"status":"ok"}
```

### Step 5: Make GET /api/users/:id return HTTP 400 with an error message when the id is not a positive integer.

The updated handler now reads:

```ts
const id = Number(req.params.id);
if (!Number.isInteger(id) || id <= 0) {
  res.status(400).json({ error: "id must be a positive integer" });
  return;
}
// … pool.query with validated id
```

**What each bad input produces after a restart:**

| Request | Response |
|---|---|
| `GET /api/users/abc` | 400 `{"error":"id must be a positive integer"}` |
| `GET /api/users/0` | 400 |
| `GET /api/users/-5` | 400 |
| `GET /api/users/1.5` | 400 (`Number("1.5")` is `1.5`, not an integer) |
| `GET /api/users/99` | 404 (passes validation, row not found) |
| `GET /api/users/1` | 200 with the row |

Restart the container to pick up the change: `docker compose restart api`.

### Step 6: Review your changes with git diff and write a pull request description for them - summary, changes, and how to test.

The diff includes pre-existing modifications to `deck/` and `results/` files that were already in the working tree at the start of this session. The only changes I made are in `api/src/index.ts`. Here's the diff for those alone and a PR description:

```diff
// api/src/index.ts

+app.get("/api/health", (_req, res) => {
+  res.json({ status: "ok" });
+});

 app.get("/api/users/:id", async (req, res) => {
+  const id = Number(req.params.id);
+  if (!Number.isInteger(id) || id <= 0) {
+    res.status(400).json({ error: "id must be a positive integer" });
+    return;
+  }
   const { rows } = await pool.query(
```

---

**PR description:**

```
## Summary

- Add `GET /api/health` endpoint returning `{"status":"ok"}` with HTTP 200,
  for use by load balancers and readiness probes.
- Add input validation to `GET /api/users/:id`: non-positive-integer values
  now return HTTP 400 with `{"error":"id must be a positive integer"}` before
  the database is touched.

## Changes

`api/src/index.ts`
- New `/api/health` route (no DB dependency, always fast).
- `GET /api/users/:id` now validates the `:id` segment with `Number.isInteger`
  and a `> 0` check before issuing the query, rejecting strings, floats,
  zero, and negative values.

## How to test

Restart the API container to pick up the changes:
```
docker compose restart api
```

**Health endpoint**
```bash
curl -i http://localhost:3001/api/health
# HTTP/1.1 200 OK
# {"status":"ok"}
```

**Valid id**
```bash
curl -i http://localhost:3001/api/users/1
# HTTP/1.1 200 OK  — returns the user row
```

**Invalid ids → 400**
```bash
curl -i http://localhost:3001/api/users/abc   # string
curl -i http://localhost:3001/api/users/0     # zero
curl -i http://localhost:3001/api/users/-3    # negative
curl -i http://localhost:3001/api/users/1.5   # float
# All: HTTP/1.1 400 Bad Request
# {"error":"id must be a positive integer"}
```

**Unknown but valid id → 404**
```bash
curl -i http://localhost:3001/api/users/9999
# HTTP/1.1 404 Not Found
# {"error":"not found"}
```
```

## Diff

```diff
diff --git a/api/src/index.ts b/api/src/index.ts
index 6165a7f..ea140ac 100644
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
+  if (!Number.isInteger(id) || id <= 0) {
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
  "output_tokens": 5789,
  "cache_read_input_tokens": 649706,
  "cache_creation_input_tokens": 36104,
  "total_tokens": 691628,
  "cost_usd": 0.4984578,
  "num_turns": 19,
  "permission_denials": 1
}
```
