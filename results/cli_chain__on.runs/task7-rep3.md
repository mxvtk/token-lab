# cli_chain__on task 7 rep 3

Grade: "/api/health added; non-numeric :id returns 400; only api/ files changed; PR description written"

## Agent result

### Step 1: Read every file in api/src and web/src and explain how the app fits together - request flow from the React page to Postgres.

Here's the complete picture:

---

## Request Flow: React → Express → Postgres

```
browser
  └─ main.tsx          mounts <App /> into #root
       └─ App.tsx       useEffect → fetch("/api/users")
                             │
                        HTTP GET (CORS allowed)
                             │
api/src/index.ts        app.get("/api/users")
  └─ pool.query(SQL)   ──────────────────────────▶  Postgres
  └─ res.json(rows)    ◀──────────────────────────  rows
                             │
                        setUsers(rows)
                        renders <ul> of buttons
```

### Layer by layer

**`web/src/main.tsx`** — the entry point. Calls `createRoot(...).render(<App />)`. Nothing else; it's just the React bootstrap.

**`web/src/App.tsx`** — the only component. On mount (`useEffect` with `[]`), it fires a plain `fetch` to `$VITE_API_URL/api/users` (defaults to `http://localhost:3001`). The result populates `users` state; clicking a list item populates `selected` state to show detail inline.

**`api/src/index.ts`** — an Express server on port 3001 (or `$PORT`). Two routes:
- `GET /api/users` — returns all users ordered by id
- `GET /api/users/:id` — returns one user or 404

CORS headers are set globally via inline middleware (not a library), which is intentional for a workshop: it allows `*` origins without ceremony.

The server only starts after `withRetry(() => pool.query("SELECT 1"))` succeeds — this blocks the listen until Postgres is actually ready.

**`api/src/db.ts`** — creates a `pg.Pool` from env vars with sane defaults (`host: "db"` matches the Docker Compose service name). Also exports `withRetry`, a simple polling loop with 1-second delays and 10 max attempts.

**`api/src/seed.ts`** — a one-shot script (not imported by the server). It creates the `users` table if it doesn't exist, then upserts five rows using `ON CONFLICT (email) DO NOTHING` so reruns are idempotent. It calls `pool.end()` to exit cleanly.

---

`★ Insight ─────────────────────────────────────`
- **`withRetry` is startup glue, not error handling.** It exists purely because Docker Compose starts the API and Postgres containers in parallel — Postgres isn't ready for connections the moment the API process starts. The retry loop bridges that race without requiring `depends_on: condition: service_healthy` in the Compose file.
- **`$1` parameterized queries in `pg`** pass values out-of-band from the SQL string, which is the Node `pg` driver's built-in SQL injection prevention. The seed script uses the same pattern even though the values are static literals — good habit.
- **`ON CONFLICT (email) DO NOTHING`** makes the seed script safe to run multiple times. Postgres will skip the insert if that email already exists, which is why there's no "clear table first" step.
`─────────────────────────────────────────────────`

### Step 2: Run `docker compose logs api --tail 200` and summarise what the API has been doing and any errors or warnings.

Clean slate — here's what happened in order:

1. **Seed ran** (`npm run seed` → `tsx src/seed.ts`) — created the `users` table (if absent) and upserted the five seed rows. Exited cleanly with `seed complete`.
2. **Server started** (`npm run start` → `tsx src/index.ts`) — connected to Postgres successfully (the `withRetry` probe passed) and is now listening on port 3001.

**No errors, no warnings.** The container hasn't served any HTTP requests yet (no access log lines), so it's idle and healthy since startup.

### Step 3: Using psql (postgresql://tokenlab:tokenlab@localhost:5432/tokenlab), show the users table schema and its rows, and point out anything odd in the data.

**Schema** — straightforward: `id` (auto-increment PK), `email` (text, NOT NULL, unique), `created_at` (timestamptz, NOT NULL, defaults to `now()`). Clean and minimal.

**Data — two things worth noting:**

1. **`created_at` times are all midnight UTC.** That's because `seed.ts` inserts date strings like `"2026-11-20"` without a time component. Postgres coerces `DATE`-looking strings to `TIMESTAMPTZ` at `00:00:00+00`. The values are technically valid, but they're synthetic — not real signup timestamps. If this were production data you'd expect spread-out times, not all exactly midnight.

2. **`alan` and `linus` are significantly older than the rest.** `alan@example.com` is from September 2026 and `linus@example.com` from June 2026, while the other three are from the last week of November. That gap looks intentional for the seed (probably for demo/sorting purposes), but would be odd in real data.

`★ Insight ─────────────────────────────────────`
- **`SERIAL` vs `GENERATED ALWAYS AS IDENTITY`** — the schema uses the older `SERIAL` shorthand (which creates a sequence via `nextval`). Since Postgres 10, the SQL-standard `id INTEGER GENERATED ALWAYS AS IDENTITY` is preferred; it attaches the sequence directly to the column rather than via a default expression, making it easier to introspect and transfer.
- **`text` for email with no CHECK constraint** — Postgres won't reject `"not-an-email"` as a value. A `CHECK (email ~* '^[^@]+@[^@]+\.[^@]+$')` or a domain type would enforce format at the DB layer rather than relying solely on the application.
`─────────────────────────────────────────────────`

### Step 4: Add a GET /api/health endpoint to the Express API that returns {"status":"ok"} with HTTP 200.

The edit is in place. The TypeScript diagnostics shown are all pre-existing — they affect every handler in the original file (the `express` types issue, implicit `any` on `req`/`res`/`next`), not anything introduced by this change. My new handler follows the identical pattern.

`★ Insight ─────────────────────────────────────`
- **Health endpoints are synchronous by design.** Unlike the user routes, this handler doesn't touch the database, so it's a pure, non-async function. That's intentional — a `/health` probe should tell you "is the process alive", not "is Postgres alive". If you want the latter, you'd add a separate `/api/ready` endpoint that runs `pool.query("SELECT 1")`.
- **Placement matters.** The endpoint is registered before the user routes, so it's matched first by Express's linear router. This avoids any (hypothetical) auth middleware added later accidentally guarding the health check.
`─────────────────────────────────────────────────`

The API container will pick up the change once restarted (`docker compose restart api`). You can then verify with `curl http://localhost:3001/api/health`.

### Step 5: Make GET /api/users/:id return HTTP 400 with an error message when the id is not a positive integer.

`★ Insight ─────────────────────────────────────`
- **`Number("abc")` → `NaN`, and `Number.isInteger(NaN)` → `false`**, so the same guard handles both non-numeric strings and floats like `"1.5"` without needing a separate regex. The `< 1` check then catches `0` and negatives.
- **Passing `id` (the parsed number) instead of `req.params.id` (the raw string) to the query** is a minor improvement: `pg` sends it as an integer wire type rather than a string, which avoids an implicit cast in Postgres and rules out any edge-case where a crafted string might behave differently after coercion.
`─────────────────────────────────────────────────`

The cases now covered: `GET /api/users/abc` → 400, `/api/users/0` → 400, `/api/users/-5` → 400, `/api/users/1.5` → 400, `/api/users/1` → 200 or 404 as before.

### Step 6: Review your changes with git diff and write a pull request description for them - summary, changes, and how to test.

Here's a pull request description for these changes:

---

**Title:** `api: add /api/health endpoint and validate user id param`

---

**Summary**

Two small hardening changes to the Express API:

1. **`GET /api/health`** — new liveness probe that returns `{"status":"ok"}` with HTTP 200. No database involvement, so it reliably reflects process health rather than Postgres health.

2. **Input validation on `GET /api/users/:id`** — returns HTTP 400 `{"error":"id must be a positive integer"}` when the `:id` segment is not a positive integer (e.g. `abc`, `0`, `-3`, `1.5`). Previously these would fall through to the SQL query, letting Postgres see an invalid or zero value. The parsed integer is also now passed to `pool.query` instead of the raw string, so the wire type is correct.

**Changes**

- `api/src/index.ts` — added `/api/health` route; added id validation guard before the `SELECT` query in `/api/users/:id`

**How to test**

```bash
# Restart the API to pick up the changes
docker compose restart api

# Health check
curl -i http://localhost:3001/api/health
# → HTTP 200  {"status":"ok"}

# Valid id
curl -i http://localhost:3001/api/users/1
# → HTTP 200  user object

# Non-existent but valid id
curl -i http://localhost:3001/api/users/999
# → HTTP 404  {"error":"not found"}

# Invalid ids → all should return 400
curl -i http://localhost:3001/api/users/abc
curl -i http://localhost:3001/api/users/0
curl -i http://localhost:3001/api/users/-1
curl -i http://localhost:3001/api/users/1.5
```

---

Want me to commit these changes and open the PR, or adjust the description first?

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

- Bash {"command":"curl -s http://localhost:3001/api/health","description":"Hit the new health endpoint to verify it responds"}

## Usage

```json
{
  "input_tokens": 29,
  "output_tokens": 4183,
  "cache_read_input_tokens": 574406,
  "cache_creation_input_tokens": 27811,
  "total_tokens": 606429,
  "cost_usd": 0.40201980000000004,
  "num_turns": 19,
  "permission_denials": 1
}
```
