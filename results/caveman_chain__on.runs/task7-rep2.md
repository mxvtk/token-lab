# caveman_chain__on task 7 rep 2

Grade: "/api/health added; non-numeric :id returns 400; only api/ files changed; PR description written"

## Agent result

### Step 1: Read every file in api/src and web/src and explain how the app fits together - request flow from the React page to Postgres.

`★ Insight ─────────────────────────────────────`
**1. `withRetry` as startup synchronization** — `api/src/index.ts:38` and `seed.ts:20` both call `withRetry(() => pool.query("SELECT 1"))` before proceeding. This is a Docker-compose pattern: Postgres starts slow, so the server polls every 1s for up to 10 tries before binding the port or running migrations. The same utility doubles as a readiness probe and a migration gate.

**2. `VITE_API_URL` env var for environment switching** — `App.tsx:3` reads `import.meta.env.VITE_API_URL`. Vite only exposes env vars prefixed `VITE_` to the browser bundle. Set it at build time to point at prod; in dev it falls back to `localhost:3001`. This is the standard Vite pattern for env-aware API roots without a build-time constant.
`─────────────────────────────────────────────────`

---

## Request flow: React → Express → Postgres

```
browser
  └─ main.tsx          createRoot → mounts <App>
       └─ App.tsx
            useEffect  → fetch("http://localhost:3001/api/users")
            setUsers   ← JSON array

api/src/index.ts
  GET /api/users        pool.query("SELECT id, email, created_at FROM users ORDER BY id")
  GET /api/users/:id    pool.query("... WHERE id = $1", [req.params.id])

api/src/db.ts
  Pool                  connects to Postgres (host=db / PGHOST env)
  withRetry             startup poll until DB ready

Postgres (Docker service "db")
  table: users          id SERIAL PK, email TEXT UNIQUE, created_at TIMESTAMPTZ
  seeded by seed.ts     5 rows, idempotent via ON CONFLICT DO NOTHING
```

**Detail by layer:**

| File | Role |
|---|---|
| `web/src/main.tsx` | Entry point — mounts React tree |
| `web/src/App.tsx` | Single component: fetches `/api/users` on mount, renders list + detail on click |
| `api/src/index.ts` | Express server on port 3001, two routes: list + get-by-id |
| `api/src/db.ts` | `pg.Pool` singleton + `withRetry` startup helper |
| `api/src/seed.ts` | One-shot script: creates `users` table + inserts 5 rows idempotently |

**Notable bug in `App.tsx:20`:** `users[0].email` runs before data arrives — `users` starts as `[]`, so `users[0]` is `undefined` and `.email` throws. The comment in the file flags this as eval task 2.

### Step 2: Run `docker compose logs api --tail 200` and summarise what the API has been doing and any errors or warnings.

Clean. No errors or warnings.

- Seed ran (`tsx src/seed.ts`) and completed successfully.
- Server started (`tsx src/index.ts`) and bound port 3001.
- No failed DB connections, no retries, no request errors in this window.

### Step 3: Using psql (postgresql://tokenlab:tokenlab@localhost:5432/tokenlab), show the users table schema and its rows, and point out anything odd in the data.

**Schema** — clean: `id` SERIAL PK, `email` TEXT NOT NULL UNIQUE, `created_at` TIMESTAMPTZ NOT NULL DEFAULT now(). Two indexes (PK + unique email).

**Data oddities:**

1. **`created_at` times are all midnight UTC** (`00:00:00+00`). Seed inserts date strings (`"2026-11-20"`) without a time component, so Postgres casts them to midnight. Real signups would have actual timestamps.

2. **Non-monotonic dates** — rows 3 and 4 (alan, linus) were created months earlier (Sep and Jun 2026) but have lower IDs than rows 1–2 (Nov 2026). The `id` sequence implies insertion order, but the `created_at` values suggest these users are older. This is an artifact of the seed order in `seed.ts`, not real data.

3. **All `example.com` emails** — expected for seed data, but worth flagging if real user import was intended.

### Step 4: Add a GET /api/health endpoint to the Express API that returns {"status":"ok"} with HTTP 200.

Curl blocked by permissions — you can verify manually: `curl http://localhost:3001/api/health`

**TS diagnostics** shown are all pre-existing — `express` types not found + implicit `any` on route params. My change didn't introduce them (they appear on `index.ts:8` and `index.ts:15`, which are the CORS middleware and existing routes unchanged). The API runs fine via `tsx` regardless (transpiles at runtime, skips type errors).

Note: if the API container doesn't hot-reload on file changes, restart it with `docker compose restart api` to pick up the new route.

### Step 5: Make GET /api/users/:id return HTTP 400 with an error message when the id is not a positive integer.

Done. Behavior now:

| Input | Response |
|---|---|
| `/api/users/abc` | 400 `{"error":"id must be a positive integer"}` |
| `/api/users/0` | 400 same |
| `/api/users/-5` | 400 same |
| `/api/users/1.5` | 400 same (`Number("1.5")` is not an integer) |
| `/api/users/3` | 200 or 404 as before |

The query also now receives the coerced `number` rather than a raw string, which lets `pg` bind it as an integer instead of a text literal.

### Step 6: Review your changes with git diff and write a pull request description for them - summary, changes, and how to test.

---

## PR description

**Title:** `feat(api): add /api/health endpoint and validate user id parameter`

---

### Summary

Two small hardening changes to the Express API:

1. **Health endpoint** — `GET /api/health` returns `{"status":"ok"}` with HTTP 200. No DB hit, safe for load balancer probes.
2. **User id validation** — `GET /api/users/:id` now rejects non-positive-integer ids with HTTP 400 before touching the database, and passes the coerced number to the query instead of a raw string.

---

### Changes

- `api/src/index.ts` — added `/api/health` route; added id validation guard in `/api/users/:id`

---

### How to test

```bash
# Health check
curl -i http://localhost:3001/api/health
# → 200 {"status":"ok"}

# Valid id
curl -i http://localhost:3001/api/users/1
# → 200 user object

# Non-numeric
curl -i http://localhost:3001/api/users/abc
# → 400 {"error":"id must be a positive integer"}

# Zero / negative
curl -i http://localhost:3001/api/users/0
curl -i http://localhost:3001/api/users/-1
# → 400 same

# Float
curl -i http://localhost:3001/api/users/1.5
# → 400 same

# Missing id (still 404)
curl -i http://localhost:3001/api/users/9999
# → 404 {"error":"not found"}
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
  "input_tokens": 31,
  "output_tokens": 4344,
  "cache_read_input_tokens": 774445,
  "cache_creation_input_tokens": 36804,
  "total_tokens": 815624,
  "cost_usd": 1.9583589000000001,
  "num_turns": 21
}
```
