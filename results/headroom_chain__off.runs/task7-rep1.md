# headroom_chain__off task 7 rep 1

Grade: "/api/health added; non-numeric :id returns 400; only api/ files changed; PR description written"

## Agent result

### Step 1: Read every file in api/src and web/src and explain how the app fits together - request flow from the React page to Postgres.

Here's a complete picture of how the app fits together.

---

## Request flow: React → Express → Postgres

### 1. Browser bootstrap (`web/src/main.tsx`)

`createRoot` mounts `<App />` into `#root`. Nothing fancy — this is the standard React 18 entry point. `React.StrictMode` causes every effect to run twice in dev, which is worth knowing when you're watching network calls.

### 2. Data fetch (`web/src/App.tsx:12-17`)

On first render, `useEffect` fires a single `fetch` to `GET /api/users`. The API base URL is wired through a Vite env variable (`VITE_API_URL`), falling back to `http://localhost:3001` — so the same build artifact works in any environment just by injecting that variable at build time.

The response type is `User[]`:
```ts
type User = { id: number; email: string; created_at: string }
```

The component holds three pieces of state: the user list, an error string, and a `selected` user. Clicking a user button populates `selected` from the already-fetched list (no second network call).

`★ Insight ─────────────────────────────────────`
- The `fetch` chain uses `r.ok ? r.json() : Promise.reject(...)` — a clean pattern because `fetch` only rejects on network failure, not on 4xx/5xx HTTP errors. Without that guard, a 500 from the API would silently look like a successful empty response.
- There's a **single fetch on mount**, no React Query or SWR. The detail view is purely client-side selection — no `/api/users/:id` call is made from the UI at all (even though that endpoint exists on the server).
`─────────────────────────────────────────────────`

### 3. Express server (`api/src/index.ts`)

Two routes:

| Route | SQL |
|---|---|
| `GET /api/users` | `SELECT id, email, created_at FROM users ORDER BY id` |
| `GET /api/users/:id` | `SELECT id, email, created_at FROM users WHERE id = $1` |

CORS is opened wide (`*`) — intentional for the workshop context (comment says so). The server waits for Postgres to be ready via `withRetry(() => pool.query("SELECT 1"))` before calling `app.listen`, so it won't accept connections until the DB is reachable.

### 4. Database connection (`api/src/db.ts`)

A `pg.Pool` is created from environment variables, defaulting to service-name-based hostnames (`host: "db"`) — the Docker Compose service name. `withRetry` retries any async function up to 10 times with 1-second delays, used both here on startup and in `seed.ts`.

`★ Insight ─────────────────────────────────────`
- The pool default host is `"db"` (the Docker Compose service name), not `"localhost"`. This is a common gotcha: running the API outside Docker requires explicitly setting `PGHOST=localhost`. The fallback order is: env var → Docker service name.
- Parameterized queries (`$1`, `$2`) throughout — no string concatenation, so no SQL injection risk even though this is a workshop app.
`─────────────────────────────────────────────────`

### 5. Schema + seed (`api/src/seed.ts`)

A standalone script (not part of the server process) that:
1. Waits for Postgres with `withRetry`
2. Creates the `users` table (`CREATE TABLE IF NOT EXISTS`)
3. Inserts 5 rows using `ON CONFLICT (email) DO NOTHING` (idempotent — safe to re-run)
4. Closes the pool with `pool.end()`

---

## Full request path in one diagram

```
Browser
  └─ main.tsx: createRoot → <App />
       └─ App.tsx useEffect: fetch GET /api/users
            └─ Express index.ts: GET /api/users handler
                 └─ db.ts pool.query("SELECT id, email, created_at FROM users")
                      └─ Postgres: users table (created by seed.ts)
                           ↑
                      seed.ts: CREATE TABLE + INSERT (run once at startup)
```

The app is intentionally minimal — no auth, no mutations, no pagination. It's a clean skeleton for a workshop: one table, two read endpoints, one React page.

### Step 2: Run `docker compose logs api --tail 200` and summarise what the API has been doing and any errors or warnings.

Clean bill of health. Here's what happened:

1. **Seed ran successfully** — `npm run seed` executed `src/seed.ts`, which waited for Postgres, created the `users` table (if absent), inserted the 5 seed rows idempotently, and exited with `seed complete`.

2. **Server started cleanly** — `npm run start` launched `src/index.ts` and the API is now listening on `:3001`.

3. **No errors or warnings** — no DB connection retries, no crashes, no unhandled rejections. The `withRetry` probe against Postgres succeeded on the first attempt both times (no retry noise in the logs).

The API has received no HTTP requests since startup — the logs only show the init sequence, nothing from `/api/users` calls yet.

### Step 3: Using psql (postgresql://tokenlab:tokenlab@localhost:5432/tokenlab), show the users table schema and its rows, and point out anything odd in the data.

### Schema

Clean and minimal:

| Column | Type | Notes |
|---|---|---|
| `id` | `integer` | PK, auto-increment via sequence |
| `email` | `text` | `NOT NULL`, unique constraint |
| `created_at` | `timestamptz` | `NOT NULL`, defaults to `now()` |

### Data

5 rows, all healthy — no nulls, no duplicates. Two things worth noting:

**1. `created_at` times are midnight UTC on every row.**
The seed script passes bare date strings (`"2026-11-20"`, `"2026-06-15"`, etc.) as the `created_at` value. Postgres coerces a date string to `timestamptz` as midnight in the session timezone (UTC here), which is why every timestamp is `00:00:00+00`. In a real app these would be actual signup timestamps — worth knowing when you write queries or display relative times.

**2. The dates are not in chronological order by `id`.**
`id 3` (alan) has `created_at 2026-09-01` and `id 4` (linus) has `2026-06-15` — both earlier than ids 1 and 2. The seed inserts rows in the order they appear in the array, so `id` sequence reflects insertion order, not signup date. If you ever sort by `id` expecting chronological order, you'll get a misleading result. The API's `ORDER BY id` query (`api/src/index.ts:17`) does exactly this — ada comes first by `id`, but linus actually "signed up" earliest.

`★ Insight ─────────────────────────────────────`
- `text` for `email` rather than `varchar(n)` is idiomatic in Postgres — there's no performance difference, and you avoid the `varchar` length-check overhead. The `UNIQUE` index enforces uniqueness at the storage level, not via application logic.
- `TIMESTAMPTZ` (timestamp with time zone) is the right choice over plain `TIMESTAMP` — it stores UTC internally and converts on read, so it stays correct across timezone changes. Plain `TIMESTAMP` would silently store whatever string you give it with no zone awareness.
`─────────────────────────────────────────────────`

### Step 4: Add a GET /api/health endpoint to the Express API that returns {"status":"ok"} with HTTP 200.

The `curl` needs your approval to run — please allow it if you'd like me to verify the endpoint live. The TypeScript diagnostics shown are all pre-existing (missing `express` type declarations and implicit `any` on handler params) — none were introduced by this change.

The added code is at `api/src/index.ts:16-18`:

```ts
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});
```

Once approved, you can also test it manually with:
```
curl http://localhost:3001/api/health
```

Note: the server uses `tsx` (which watches/reloads on file changes in dev), but if it doesn't auto-reload you may need to restart the container with `docker compose restart api`.

### Step 5: Make GET /api/users/:id return HTTP 400 with an error message when the id is not a positive integer.

The validation logic:

- `Number("abc")` → `NaN`, `Number.isInteger(NaN)` → `false` → **400**
- `Number("1.5")` → `1.5`, `Number.isInteger(1.5)` → `false` → **400**
- `Number("0")` → `0`, `0 < 1` → `true` → **400**
- `Number("-3")` → `-3`, `-3 < 1` → `true` → **400**
- `Number("2")` → `2`, passes → query runs → **200** or **404**

The TS diagnostics in the output are all pre-existing (missing `express` types, implicit `any` on handler params) — none were introduced here.

### Step 6: Review your changes with git diff and write a pull request description for them - summary, changes, and how to test.

The diff also contains pre-existing changes to `deck/` and `results/` files that were already modified before this session — those are unrelated to the API work. Here's the PR description scoped to what I changed:

---

## Add `/api/health` endpoint and input validation for user ID

### Summary

Two small hardening changes to the Express API:

- **Health endpoint** (`GET /api/health`) — returns `{"status":"ok"}` with HTTP 200. Placed before the user routes so it's reachable without any auth or middleware interference, making it suitable for container health checks and load-balancer probes.
- **User ID validation** (`GET /api/users/:id`) — validates that `:id` is a positive integer before hitting the database. Non-integers, floats, zero, and negative values now return HTTP 400 with `{"error":"id must be a positive integer"}` instead of letting a malformed value reach the query.

### Changes

**`api/src/index.ts`**

| What | Before | After |
|---|---|---|
| `GET /api/health` | did not exist | returns `{"status":"ok"}` with 200 |
| `GET /api/users/:id` — invalid id | passed raw string to `pool.query` | returns 400 before querying |
| `GET /api/users/:id` — valid id | passed `req.params.id` (string) to `$1` | passes validated `id` (number) to `$1` |

### How to test

```bash
# Health check
curl -i http://localhost:3001/api/health
# → 200 {"status":"ok"}

# Valid id
curl -i http://localhost:3001/api/users/1
# → 200 {id:1, email:"ada@example.com", ...}

# Non-existent but valid id
curl -i http://localhost:3001/api/users/999
# → 404 {"error":"not found"}

# Invalid: non-integer
curl -i http://localhost:3001/api/users/abc
# → 400 {"error":"id must be a positive integer"}

# Invalid: float
curl -i http://localhost:3001/api/users/1.5
# → 400 {"error":"id must be a positive integer"}

# Invalid: zero / negative
curl -i http://localhost:3001/api/users/0
curl -i http://localhost:3001/api/users/-1
# → 400 {"error":"id must be a positive integer"}
```

---

The deck/results files in the working tree are pre-existing modifications unrelated to this change and should be excluded from (or committed separately before) this PR.

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

- Bash {"command":"curl -s http://localhost:3001/api/health","description":"Hit the health endpoint on the running API"}

## Usage

```json
{
  "input_tokens": 30,
  "output_tokens": 5620,
  "cache_read_input_tokens": 709520,
  "cache_creation_input_tokens": 36591,
  "total_tokens": 751761,
  "cost_usd": 0.516792,
  "num_turns": 20,
  "permission_denials": 1
}
```
