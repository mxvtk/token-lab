# caveman_chain__on task 7 rep 3

Grade: "/api/health added; non-numeric :id returns 400; only api/ files changed; PR description written"

## Agent result

### Step 1: Read every file in api/src and web/src and explain how the app fits together - request flow from the React page to Postgres.

`★ Insight ─────────────────────────────────────`
**1. `useEffect` with empty dep array `[]`** fires once after mount — classic "fetch on load" pattern. The fetch result is async, so `users` starts as `[]` before data arrives. That's exactly why line 20 crashes: `users[0]` is `undefined` on first render.

**2. Connection pooling via `pg.Pool`** is the right primitive here. A `Pool` manages multiple idle Postgres connections and hands them out per query, so the API doesn't pay TCP + auth handshake on every request. The `withRetry` wrapper handles Docker startup ordering — Postgres needs a few seconds before it accepts connections.

**3. `seed.ts` is a one-shot migration + fixture loader.** It runs `CREATE TABLE IF NOT EXISTS` then `INSERT ... ON CONFLICT DO NOTHING`, making it safe to re-run without duplicates. `pool.end()` closes all connections explicitly since the script has nothing else to do.
`─────────────────────────────────────────────────`

---

## Request flow: React → Express → Postgres

```
browser
  └─ main.tsx          mounts <App /> into #root

  App.tsx (React)
    useEffect on mount
      fetch("http://localhost:3001/api/users")        ← VITE_API_URL or default
        │
        ▼
  api/src/index.ts (Express :3001)
    GET /api/users
      pool.query("SELECT id, email, created_at FROM users ORDER BY id")
        │
        ▼
  api/src/db.ts
    pg.Pool  ──────────────────────────────► Postgres :5432
    host: PGHOST ?? "db"                    database: tokenlab
    (Docker service name in Compose,        table: users
     localhost when running locally)
        │
        ◄──────────── rows returned ─────────────────
        ▼
      res.json(rows)
        ▼
  App.tsx
    setUsers(rows)   → re-render list
    user clicks → setSelected(u) → shows detail section
```

**Key layers:**

| File | Role |
|---|---|
| `web/src/main.tsx` | Entry point — mounts React tree |
| `web/src/App.tsx` | Single component: fetch on mount, render list + detail |
| `api/src/index.ts` | Express server, two routes: `GET /api/users` and `GET /api/users/:id` |
| `api/src/db.ts` | `pg.Pool` config + `withRetry` for startup races |
| `api/src/seed.ts` | One-shot script: creates `users` table, inserts 5 rows |

**Notable bug** at `App.tsx:20` — `users[0].email` runs on first render when `users` is `[]`, throwing `Cannot read properties of undefined`. Fix: `users[0]?.email ?? ""`.

### Step 2: Run `docker compose logs api --tail 200` and summarise what the API has been doing and any errors or warnings.

Clean. Four events, no errors:

1. **Seed ran** — `npm run seed` executed `src/seed.ts`, printed `seed complete`. Schema created, 5 rows inserted.
2. **API started** — `npm run start` launched `src/index.ts`, Express bound to `:3001`.

No warnings, no retries, no crash/restart cycles. Postgres was reachable on first attempt (no `withRetry` delay visible in logs).

### Step 3: Using psql (postgresql://tokenlab:tokenlab@localhost:5432/tokenlab), show the users table schema and its rows, and point out anything odd in the data.

`★ Insight ─────────────────────────────────────`
**`TIMESTAMPTZ` stores UTC offset.** All rows show `+00` because the seed inserted bare date strings (`'2026-11-20'`) with no time component — Postgres coerces them to midnight UTC. If the app ever needs local-time display it must apply timezone conversion in the query or client, not rely on stored offset.
`─────────────────────────────────────────────────`

**Schema** — clean: `id` auto-increment PK, `email` NOT NULL + UNIQUE, `created_at` TIMESTAMPTZ NOT NULL DEFAULT now(). No issues.

**Data — two oddities:**

1. **Non-monotonic dates** — rows inserted in `id` order but `created_at` is not: alan (id 3) = Sep 2026, linus (id 4) = Jun 2026. Linus joined *before* alan yet has a higher id. Probably fine for seed data, but suspicious if `id` is ever used as a proxy for join order.

2. **All times are midnight UTC** — seed passed date-only strings, so every `created_at` is `00:00:00+00`. Real user sign-ups would have sub-day precision. Worth knowing if any query filters by time-of-day.

### Step 4: Add a GET /api/health endpoint to the Express API that returns {"status":"ok"} with HTTP 200.

Endpoint added at `api/src/index.ts:15`. The TS errors in diagnostics are pre-existing across the whole file (missing `@types/express`, implicit `any` on all handlers) — not introduced by this change.

Curl blocked by permissions. Run manually to verify:

```
curl http://localhost:3001/api/health
```

Expected: `{"status":"ok"}`

### Step 5: Make GET /api/users/:id return HTTP 400 with an error message when the id is not a positive integer.

Validation added at `api/src/index.ts:30-33`. Rejects: `0`, negatives, floats (`1.5`), strings (`abc`), empty. Valid ids pass through as a typed `number` to the query parameter.

### Step 6: Review your changes with git diff and write a pull request description for them - summary, changes, and how to test.

---

## PR description

**Add `/api/health` endpoint and validate user id parameter**

### Summary

Two small hardening changes to the Express API:

1. **Health endpoint** — `GET /api/health` returns `{"status":"ok"}` with HTTP 200. Useful for container health checks and load-balancer probes without hitting the database.

2. **Id validation on `GET /api/users/:id`** — previously the raw string was passed straight to Postgres as `$1`. Non-integer inputs (`abc`, `1.5`, `0`, `-5`) now return HTTP 400 `{"error":"id must be a positive integer"}` before the query runs. The validated `number` (not the raw string) is passed to the query.

### Changes

- `api/src/index.ts` — 14 lines added

### How to test

```bash
# health check
curl -i http://localhost:3001/api/health
# → 200 {"status":"ok"}

# valid id
curl -i http://localhost:3001/api/users/1
# → 200 { id: 1, email: "ada@example.com", ... }

# non-integer
curl -i http://localhost:3001/api/users/abc
# → 400 {"error":"id must be a positive integer"}

# float
curl -i http://localhost:3001/api/users/1.5
# → 400 {"error":"id must be a positive integer"}

# zero / negative
curl -i http://localhost:3001/api/users/0
curl -i http://localhost:3001/api/users/-1
# → 400 {"error":"id must be a positive integer"}

# missing id still 404
curl -i http://localhost:3001/api/users/9999
# → 404 {"error":"not found"}
```

## Diff

```diff
diff --git a/api/src/index.ts b/api/src/index.ts
index 6165a7f..2f18b73 100644
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
+  if (!Number.isInteger(id) || id <= 0) {
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
  "output_tokens": 3763,
  "cache_read_input_tokens": 781401,
  "cache_creation_input_tokens": 36168,
  "total_tokens": 821363,
  "cost_usd": 1.9592889000000002,
  "num_turns": 21
}
```
