# headroom_chain__on task 7 rep 1

Grade: "/api/health added; non-numeric :id returns 400; only api/ files changed; PR description written"

## Agent result

### Step 1: Read every file in api/src and web/src and explain how the app fits together - request flow from the React page to Postgres.

`★ Insight ─────────────────────────────────────`
**Before diving in:** A few architecture patterns worth noticing upfront:
1. `withRetry` in `db.ts` is used both in the API server startup *and* in `seed.ts` — it's the only mechanism guarding against Docker container race conditions (db not ready yet). No ORM, no migration tool, just raw SQL in `seed.ts`.
2. The CORS middleware in `index.ts` is a blanket wildcard (`*`), deliberate for a workshop where participants run the Vite dev server independently from the API.
`─────────────────────────────────────────────────`

Here's the full request flow, layer by layer:

---

## App Architecture: React → Express → `pg` → Postgres

### 1. Entry point — `web/src/main.tsx`
React's standard bootstrapper. Mounts `<App />` into the `#root` div via `createRoot`. Nothing unusual.

### 2. Data fetching — `web/src/App.tsx`
On mount, a `useEffect` fires a plain `fetch` to `$VITE_API_URL/api/users` (defaults to `http://localhost:3001`). The URL is baked in at Vite build time via `import.meta.env.VITE_API_URL`. The component holds three state variables:

| State | Purpose |
|---|---|
| `users` | The list from the API (null = loading) |
| `error` | Surfaced if the fetch fails |
| `selected` | Tracks which row was clicked for the detail view |

### 3. API server — `api/src/index.ts`
A minimal Express app with two routes:

- `GET /api/users` → `SELECT id, email, created_at FROM users ORDER BY id`
- `GET /api/users/:id` → same but filtered by `$1` (parameterized, so safe from SQL injection), returns 404 if no row

The server only starts *after* `withRetry(() => pool.query("SELECT 1"))` resolves — meaning it waits for Postgres to be reachable before accepting connections.

### 4. Connection pool — `api/src/db.ts`
Creates a `pg.Pool` reading config from env vars, with safe defaults (`db:5432`, user/pass/db all `tokenlab`). The `withRetry` helper runs up to 10 attempts with 1-second pauses between them — a simple resilience pattern for Docker Compose startup ordering.

### 5. Schema + seed — `api/src/seed.ts`
A standalone script (not part of the Express app) that:
1. Waits for Postgres via `withRetry`
2. Creates the `users` table with `CREATE TABLE IF NOT EXISTS` (idempotent)
3. Inserts 5 rows using `ON CONFLICT (email) DO NOTHING` (also idempotent — safe to re-run)
4. Closes the pool and exits

---

## Full request path in one diagram

```
Browser (React)
  │  useEffect → fetch("http://localhost:3001/api/users")
  │
  ▼
Express (index.ts :3001)
  │  CORS headers added for Vite dev server
  │  GET /api/users handler
  │
  ▼
pg.Pool (db.ts)
  │  pool.query("SELECT id, email, created_at FROM users ORDER BY id")
  │  parameterized query → no injection surface
  │
  ▼
Postgres (Docker: host "db", port 5432, db "tokenlab")
  │  returns rows
  │
  ◄──── rows as JSON back up the chain ────
  │
React setState(users) → re-render list
```

`★ Insight ─────────────────────────────────────`
**After reading:** The app deliberately keeps the stack thin and dependency-free for workshop purposes — no React Query, no Axios, no ORM, no migration framework. Each layer does exactly one thing, which makes it easy to instrument or modify during the token-spend experiments (e.g., adding Headroom compression at the API boundary or measuring how fetch roundtrips affect token usage).
`─────────────────────────────────────────────────`

### Step 2: Run `docker compose logs api --tail 200` and summarise what the API has been doing and any errors or warnings.

The API container is clean — here's the full picture:

**What it did (startup sequence):**
1. Ran `npm run seed` → `tsx src/seed.ts` — connected to Postgres, created the `users` table (idempotent), inserted the 5 seed rows, exited cleanly (`seed complete`).
2. Ran `npm run start` → `tsx src/index.ts` — connected to Postgres via `withRetry`, then bound to `:3001` (`api listening on :3001`).

**Errors / warnings:** None. Zero. The container came up without any retries or connection failures.

**Notably absent:** No HTTP request logs. Express has no access-log middleware configured, so individual `GET /api/users` calls leave no trace — the logs only capture startup lifecycle events.

### Step 3: Using psql (postgresql://tokenlab:tokenlab@localhost:5432/tokenlab), show the users table schema and its rows, and point out anything odd in the data.

**Schema** — straightforward and clean:
- `id`: auto-incrementing integer PK
- `email`: `TEXT NOT NULL UNIQUE` (enforced by both `NOT NULL` and a unique index)
- `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()` — timezone-aware, good practice

---

**Data — two things worth noting:**

1. **`created_at` times are all midnight UTC (`00:00:00+00`).** The seed inserted these as plain date strings (`"2026-11-20"` etc.) without a time component, so Postgres cast them to midnight. That's fine for seed data, but it means the column loses its usefulness as a "joined at" timestamp for the seed rows — real signups would have sub-day precision.

2. **`alan` and `linus` are significantly older than the rest.** Alan was created 2026-09-01 and Linus on 2026-06-15, while the other three are all from late November 2026 (within a 3-day window). This is probably intentional seed variety, but if you're using `created_at` to simulate realistic user growth patterns in workshop demos, the gap is quite large and somewhat arbitrary.

No structural issues — no nulls, no duplicate emails, no sequence gaps.

### Step 4: Add a GET /api/health endpoint to the Express API that returns {"status":"ok"} with HTTP 200.

The curl needs approval — the endpoint is live once you allow it. The TypeScript diagnostics shown are all pre-existing (they cover lines 1, 8, 15, 20, 28 — the Express import and the original routes, none of which I changed). `tsx` transpiles and ignores type errors at runtime, so the container is unaffected.

`★ Insight ─────────────────────────────────────`
Those `implicit any` warnings exist because the project has no `@types/express` installed. `tsx` runs the code fine regardless — TypeScript type errors don't prevent execution, they only matter if you run `tsc --noEmit` as a check step. The pattern `(_req, res)` I used for the health handler matches the convention already in the file for unused request params.
`─────────────────────────────────────────────────`

The change is a single `app.get` added before the users routes:

```ts
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});
```

Once curl is approved (or you test manually), `GET http://localhost:3001/api/health` will return `{"status":"ok"}` with HTTP 200.

### Step 5: Make GET /api/users/:id return HTTP 400 with an error message when the id is not a positive integer.

`★ Insight ─────────────────────────────────────`
`Number("1.5")` → `1.5` (not an integer, caught). `Number("1abc")` → `NaN` (not an integer, caught). `Number("0")` → `0` (< 1, caught). `Number("-3")` → `--3` (< 1, caught). `Number("2")` → `2` ✓. This covers all the edge cases that `parseInt` would silently mishandle.

We also pass the parsed `id` number (not the raw string) into the parameterized query — a minor hygiene win since it removes any ambiguity about type coercion inside `pg`.
`─────────────────────────────────────────────────`

The validation logic:

```ts
const id = Number(req.params.id);
if (!Number.isInteger(id) || id < 1) {
  res.status(400).json({ error: "id must be a positive integer" });
  return;
}
```

Cases covered: `abc` → `NaN`, `1.5` → non-integer, `0` / `-3` → below 1, empty string → `NaN`. All return 400. Valid integer strings like `"3"` pass through unchanged.

### Step 6: Review your changes with git diff and write a pull request description for them - summary, changes, and how to test.

Here's the pull request description:

---

## Add health endpoint and input validation for user ID

### Summary

- Adds `GET /api/health` for liveness checks
- Validates the `:id` param on `GET /api/users/:id`, returning 400 on bad input instead of passing garbage to Postgres

### Changes

**`api/src/index.ts`**

- **New route `GET /api/health`** — returns `{"status":"ok"}` with HTTP 200. Placed before all data routes so future auth middleware can't accidentally block it.

- **Input validation on `GET /api/users/:id`** — parses the raw string param with `Number()` (not `parseInt`, which silently ignores trailing non-digits like `"3abc" → 3`), then rejects with HTTP 400 if the result is not a positive integer. The parsed number is also passed to the SQL query in place of the raw string, removing any type ambiguity in `pg`.

### How to test

```bash
# Health check
curl -i http://localhost:3001/api/health
# → 200 {"status":"ok"}

# Valid ID
curl -i http://localhost:3001/api/users/1
# → 200 user object

# Non-existent but valid ID
curl -i http://localhost:3001/api/users/999
# → 404 {"error":"not found"}

# Invalid inputs — all should return 400
curl -i http://localhost:3001/api/users/abc
curl -i http://localhost:3001/api/users/1.5
curl -i http://localhost:3001/api/users/0
curl -i http://localhost:3001/api/users/-1
curl -i "http://localhost:3001/api/users/1abc"
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

- Bash {"command":"curl -s -w \"\\nHTTP %{http_code}\" http://localhost:3001/api/health","description":"Test the new health endpoint"}

## Usage

```json
{
  "input_tokens": 29,
  "output_tokens": 4749,
  "cache_read_input_tokens": 622706,
  "cache_creation_input_tokens": 64740,
  "total_tokens": 692224,
  "cost_usd": 0.6465738,
  "num_turns": 19,
  "permission_denials": 1
}
```
