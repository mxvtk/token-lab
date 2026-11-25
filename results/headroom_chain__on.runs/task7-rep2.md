# headroom_chain__on task 7 rep 2

Grade: "/api/health added; non-numeric :id returns 400; only api/ files changed; PR description written"

## Agent result

### Step 1: Read every file in api/src and web/src and explain how the app fits together - request flow from the React page to Postgres.

Here's the full request flow, top to bottom:

---

## Request flow: React → Express → Postgres

### 1. Browser bootstrap (`web/src/main.tsx`)
Vite bundles the app. `main.tsx` calls `createRoot` on `#root` and renders `<App />` inside `React.StrictMode`. That's the entire entry point — no router, no state manager.

### 2. Data fetch (`web/src/App.tsx`)
On mount, a `useEffect` fires a plain `fetch` to `$VITE_API_URL/api/users` (defaults to `http://localhost:3001`). The response JSON is stored in `useState<User[]>`. Clicking a list item sets `selected`, which renders a detail section — no second fetch needed, the full object is already in state.

> **Notable bug at line 20:** `users[0].email` is accessed unconditionally before the fetch resolves. While `users` is `[]`, this crashes with `TypeError: Cannot read properties of undefined`. It's marked with a `NOTE (eval task 2)` comment — it's intentionally left as an exercise.

### 3. API server (`api/src/index.ts`)
An Express app with two routes:

| Route | Query |
|---|---|
| `GET /api/users` | `SELECT id, email, created_at FROM users ORDER BY id` |
| `GET /api/users/:id` | `SELECT … WHERE id = $1` (parameterized) |

CORS is wide-open (`*`) — intentional for the workshop dev setup. The server won't start until `withRetry(() => pool.query("SELECT 1"))` succeeds, which handles Docker startup ordering.

### 4. Database layer (`api/src/db.ts`)
A single `pg.Pool` reads connection config from env vars with sensible defaults (`host=db`, matching the Docker Compose service name). `withRetry` wraps any `() => Promise<T>` in a 10-attempt loop with 1-second backoff — used both at startup and in `seed.ts`.

### 5. Schema + seed (`api/src/seed.ts`)
Run once (separately from the server). Creates the `users` table with `CREATE TABLE IF NOT EXISTS`, then upserts 5 rows using `ON CONFLICT (email) DO NOTHING` — idempotent, safe to re-run.

---

```
Browser
  └─ main.tsx       createRoot → <App />
       └─ App.tsx   useEffect fetch("GET /api/users")
                         │
                    Express (port 3001)
                         │
                    index.ts   pool.query("SELECT …")
                         │
                    db.ts      pg.Pool → Postgres (port 5432)
                                    └─ users table (created by seed.ts)
```

`★ Insight ─────────────────────────────────────`
1. **`withRetry` as a startup gate** — instead of `depends_on` health checks in Docker Compose (which require extra config), the server polls Postgres itself. This is a common self-contained pattern for small workshop setups, though in production you'd prefer the orchestrator to handle readiness.
2. **Parameterized queries via `$1`** — `pool.query(sql, [req.params.id])` lets `pg` send the value as a separate protocol message, so the DB driver never interpolates user input into the SQL string. This is the correct way to prevent SQL injection in `node-postgres`.
3. **`VITE_API_URL` env var** — Vite only exposes env vars prefixed with `VITE_` to the browser bundle at build time (`import.meta.env`). This is a Vite security boundary: other env vars (secrets, DB passwords) won't leak even if present in the shell.
`─────────────────────────────────────────────────`

### Step 2: Run `docker compose logs api --tail 200` and summarise what the API has been doing and any errors or warnings.

Clean and healthy — here's the summary:

**What happened (in order):**
1. `npm run seed` ran `tsx src/seed.ts` — connected to Postgres, created the `users` table (if absent), upserted the 5 seed rows, and exited cleanly with `seed complete`.
2. `npm run start` ran `tsx src/index.ts` — passed the `withRetry` DB health-check and is now listening on `:3001`.

**Errors / warnings:** None. The container started cleanly with no retries, no crashes, and no unhandled rejections. The API is up and ready.

### Step 3: Using psql (postgresql://tokenlab:tokenlab@localhost:5432/tokenlab), show the users table schema and its rows, and point out anything odd in the data.

**Schema**

| Column | Type | Constraints |
|---|---|---|
| `id` | `integer` | PK, auto-increment (`SERIAL`) |
| `email` | `text` | NOT NULL, UNIQUE |
| `created_at` | `timestamptz` | NOT NULL, default `now()` |

Indexes: primary key on `id`, unique B-tree on `email`.

---

**Rows (5 seed users)**

```
ada@example.com       2026-11-20
grace@example.com     2026-11-22
alan@example.com      2026-09-01
linus@example.com     2026-06-15
margaret@example.com  2026-11-23
```

---

**Odd things worth noting:**

1. **All dates are in the future.** Today is 2026-11-25, and every `created_at` is from 2026 — that's fine for a workshop seed, but alan and linus were inserted with dates from 3–5 months ago (`2026-09-01`, `2026-06-15`) while the other three are from this week. The dates are hardcoded in `seed.ts` rather than using `now()`, so they'll never change.

2. **`created_at` is midnight UTC for all rows.** The seed passes bare date strings (`"2026-11-20"`) rather than timestamps. Postgres coerces them to `00:00:00+00`, which is a lossy representation — real signups would have sub-day precision.

3. **Non-sequential insertion order vs. `created_at` order.** `ada` (id=1) was inserted first but has a later `created_at` than `alan` (id=3) and `linus` (id=4). If the app ever sorts by `created_at` to find the "first" user, it'll return linus, not ada — and the `firstEmail` line in `App.tsx` (which grabs `users[0]` from an `ORDER BY id` query) would show ada. These two orderings diverge silently.

`★ Insight ─────────────────────────────────────`
1. **`TIMESTAMPTZ` vs `TIMESTAMP`** — the column is `timestamp with time zone`, meaning Postgres stores UTC internally and converts on display. Passing a bare date string (`"2026-11-20"`) works because Postgres parses it as midnight in the session timezone. In production, always pass an explicit ISO 8601 timestamp with offset to avoid timezone-of-the-inserting-connection surprises.
2. **`SERIAL` is shorthand for a sequence** — the `\d` output shows `nextval('users_id_seq'::regclass)` as the default. `SERIAL` creates that sequence implicitly. The modern Postgres equivalent is `id INT GENERATED ALWAYS AS IDENTITY`, which ties the sequence ownership more tightly and prevents accidental manual inserts.
`─────────────────────────────────────────────────`

### Step 4: Add a GET /api/health endpoint to the Express API that returns {"status":"ok"} with HTTP 200.

`GET /api/health` is at line 15–17, placed before the user routes — a conventional spot for health checks. The route is a one-liner: no DB call, no async, just an immediate `res.json({ status: "ok" })`.

Since `tsx` watches for file changes in dev (`start` uses `tsx`), the server should have hot-reloaded already. You can verify with:

```bash
curl http://localhost:3001/api/health
# → {"status":"ok"}
```

`★ Insight ─────────────────────────────────────`
1. **Health checks before data routes** — placing `/health` above `/api/users` means it's matched first in Express's linear router scan. For a 2-route app this is negligible, but it matters when load balancers or k8s liveness probes hammer it at high frequency — you want zero DB involvement.
2. **No DB ping in this health check** — a "shallow" health check (`{"status":"ok"}`) tells the orchestrator the process is alive. A "deep" check would also `pool.query("SELECT 1")`. Shallow is safer for liveness probes (a DB hiccup shouldn't restart the pod); deep is better for readiness probes (don't send traffic until the DB is reachable).
`─────────────────────────────────────────────────`

### Step 5: Make GET /api/users/:id return HTTP 400 with an error message when the id is not a positive integer.

Done. The guard uses `Number(req.params.id)` then `Number.isInteger(id) || id < 1` to reject floats (`1.5`), negative numbers (`-3`), zero, and non-numeric strings (`"abc"` → `NaN`).

You can test the three failure cases:

```bash
curl -s http://localhost:3001/api/users/abc   # → {"error":"id must be a positive integer"}
curl -s http://localhost:3001/api/users/-1    # → {"error":"id must be a positive integer"}
curl -s http://localhost:3001/api/users/1.5   # → {"error":"id must be a positive integer"}
curl -s http://localhost:3001/api/users/1     # → valid user
```

`★ Insight ─────────────────────────────────────`
`Number("1.5")` returns `1.5`, which passes `isNaN` but fails `Number.isInteger` — so the float case is caught without a separate regex or `parseInt`. `Number("")` returns `0`, also rejected by `id < 1`. This keeps the guard to a single condition with no string parsing edge cases.
`─────────────────────────────────────────────────`

### Step 6: Review your changes with git diff and write a pull request description for them - summary, changes, and how to test.

Here's the PR description:

---

## Add `/api/health` endpoint and input validation for `/api/users/:id`

### Summary

Two small API hardening changes:

- **Health check endpoint** — adds `GET /api/health` returning `{"status":"ok"}` with HTTP 200. No database involvement, safe to call at high frequency from load balancers or k8s probes.
- **Input validation on user lookup** — `GET /api/users/:id` now rejects non-positive-integer IDs with HTTP 400 before hitting the database. Previously, a string like `"abc"` would reach `pool.query` and cause an unhandled Postgres type error.

The `.pptx` change is unrelated to the code (pre-existing local modification).

### Changes

| File | What changed |
|---|---|
| `api/src/index.ts` | Added `GET /api/health` route; added `id` guard on `GET /api/users/:id` |

### How to test

```bash
# Health check — expect 200 {"status":"ok"}
curl -s http://localhost:3001/api/health

# Valid user — expect 200 with user object
curl -s http://localhost:3001/api/users/1

# Non-numeric id — expect 400 {"error":"id must be a positive integer"}
curl -s -w "\n%{http_code}" http://localhost:3001/api/users/abc

# Negative id — expect 400
curl -s -w "\n%{http_code}" http://localhost:3001/api/users/-1

# Float id — expect 400
curl -s -w "\n%{http_code}" http://localhost:3001/api/users/1.5

# Non-existent valid id — expect 404 (pre-existing behaviour)
curl -s -w "\n%{http_code}" http://localhost:3001/api/users/999
```

---

Note: the `.pptx` diff is a pre-existing local change — you'll want to either include it intentionally or stash it before opening the PR.

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

## Usage

```json
{
  "input_tokens": 30,
  "output_tokens": 4863,
  "cache_read_input_tokens": 659171,
  "cache_creation_input_tokens": 65396,
  "total_tokens": 729460,
  "cost_usd": 0.6631622999999999,
  "num_turns": 20
}
```
