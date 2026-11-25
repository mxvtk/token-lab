# headroom_chain__off task 7 rep 1

Grade: "/api/health added; non-numeric :id returns 400; only api/ files changed; PR description written"

## Agent result

### Step 1: Read every file in api/src and web/src and explain how the app fits together - request flow from the React page to Postgres.

`★ Insight ─────────────────────────────────────`
- **`pool` is a module-level singleton** in `db.ts` — every route handler shares one connection pool, so there's no per-request connection overhead. The `withRetry` wrapper is only used at startup to wait for Postgres to become ready (useful inside Docker Compose where the DB container may start after the API).
- **`seed.ts` is a one-shot script**, not part of the server. It runs `CREATE TABLE IF NOT EXISTS` (idempotent) and uses `ON CONFLICT (email) DO NOTHING` so re-running it never duplicates rows — a clean pattern for local development seeds.
- **`App.tsx` line 20 has a deliberate bug** (`users[0].email` when `users` is `[]`). The comment says `eval task 2` — this is an intentional workshop exercise for participants to find and fix.
`─────────────────────────────────────────────────`

---

## Request flow: React → Express → pg → Postgres

```
Browser (React)
│
│  1. main.tsx mounts <App /> into #root via createRoot
│
│  2. App.tsx useEffect fires on mount:
│       fetch(`${VITE_API_URL}/api/users`)     ← env var, defaults to :3001
│
│  3. HTTP GET /api/users crosses the network (or loopback in dev)
│
Express server (api/src/index.ts)
│
│  4. CORS middleware adds Access-Control-Allow-* headers
│     (open wildcard — intentional for the workshop, not for prod)
│
│  5. Route handler: pool.query("SELECT id, email, created_at FROM users ORDER BY id")
│
pg Pool (api/src/db.ts)
│
│  6. Pool picks an idle connection (or opens one) to Postgres
│     Connection params come from env vars; defaults point to the Docker "db" host
│
Postgres
│
│  7. Executes the query against the `users` table
│     (created by seed.ts: id SERIAL PK, email TEXT UNIQUE, created_at TIMESTAMPTZ)
│
│  8. Returns rows → pool → route handler → res.json(rows)
│
Back in React
│
│  9. fetch resolves → setUsers(rows) triggers re-render
│ 10. List renders all users as buttons; clicking one calls setSelected(u)
│ 11. Selected user's detail section appears below the list
```

---

### Key architectural points

| Layer | File | Responsibility |
|---|---|---|
| Entry point | `web/src/main.tsx` | Mounts React into the DOM |
| UI + data fetching | `web/src/App.tsx` | Single component: fetch on mount, render list + detail |
| HTTP server | `api/src/index.ts` | Two routes (`GET /api/users`, `GET /api/users/:id`) + CORS |
| DB connection | `api/src/db.ts` | `pg.Pool` singleton + startup retry helper |
| Schema + fixtures | `api/src/seed.ts` | Standalone script: creates table, inserts 5 seed users |

The server starts only after `withRetry(() => pool.query("SELECT 1"))` succeeds — it blocks `app.listen` until Postgres is reachable. This is the same retry loop `seed.ts` uses, so both scripts tolerate a slow-starting database container.

### Step 2: Run `docker compose logs api --tail 200` and summarise what the API has been doing and any errors or warnings.

The API container has had a clean, uneventful lifecycle — no errors or warnings at all:

| Step | What happened |
|---|---|
| **Seed** | `npm run seed` ran `src/seed.ts` — connected to Postgres, created the `users` table (idempotent), inserted the 5 seed rows, exited cleanly (`seed complete`) |
| **Start** | `npm run start` ran `src/index.ts` — the `withRetry` loop succeeded on the first try (Postgres was already up), and the Express server bound to `:3001` |

No errors, no warnings, no retries. The container started up in the ideal happy path.

### Step 3: Using psql (postgresql://tokenlab:tokenlab@localhost:5432/tokenlab), show the users table schema and its rows, and point out anything odd in the data.

### Schema

Straightforward — three columns, no surprises:
- `id`: auto-incrementing integer PK
- `email`: `TEXT NOT NULL UNIQUE` — no length cap, one index enforces uniqueness
- `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()` — timezone-aware, defaults to insertion time

### Rows

| id | email | created_at |
|---|---|---|
| 1 | ada@example.com | 2026-11-20 |
| 2 | grace@example.com | 2026-11-22 |
| 3 | alan@example.com | 2026-09-01 |
| 4 | linus@example.com | 2026-06-15 |
| 5 | margaret@example.com | 2026-11-23 |

### Odd things in the data

1. **`created_at` is midnight UTC for every row** — the seed script passed date strings (`"2026-11-20"`) rather than timestamps, so Postgres cast them to `00:00:00+00`. Not wrong, but all times are suspiciously identical at midnight, which would look odd in a real dataset.

2. **Non-monotonic sign-up dates** — rows 3 and 4 (alan, linus) have `created_at` values months before rows 1, 2, and 5, yet their `id`s are higher. That's because `id` reflects insertion order (seed script ran them top-to-bottom), not chronological sign-up order. A query like `ORDER BY id` and `ORDER BY created_at` would return different sequences — something to be aware of if the app ever sorts by either.

3. **All emails are `@example.com`** — expected for seed data, but worth noting if any validation or domain-based logic is ever added.

### Step 4: Add a GET /api/health endpoint to the Express API that returns {"status":"ok"} with HTTP 200.

Looks good. The TypeScript diagnostics shown are pre-existing across the whole file (missing `@types/express`, implicit `any` on all handlers) — not introduced by this change.

You can smoke-test it once the container restarts:

```bash
curl http://localhost:3001/api/health
# {"status":"ok"}
```

The endpoint is at line 15–17, placed before the data routes so health probes never hit the DB.

### Step 5: Make GET /api/users/:id return HTTP 400 with an error message when the id is not a positive integer.

Done. The guard at `api/src/index.ts:30-33` now rejects before the query runs:

| Input | Behaviour |
|---|---|
| `/api/users/3` | proceeds to DB query as before |
| `/api/users/abc` | `Number("abc")` → `NaN`, `isInteger(NaN)` → false → **400** |
| `/api/users/1.5` | `Number("1.5")` → `1.5`, `isInteger(1.5)` → false → **400** |
| `/api/users/0` or `/api/users/-5` | `id < 1` → **400** |

The validated `id` (a JS number) is also now what gets passed to the parameterized query instead of the raw string `req.params.id`, which is slightly cleaner for `pg`.

### Step 6: Review your changes with git diff and write a pull request description for them - summary, changes, and how to test.

The diff covers two distinct areas. The API changes (`api/src/index.ts`) are what I wrote in this session. The rest — `README.md`, `eval/`, `deck/`, `setup.sh` — were already on the branch before I touched anything.

Here's a PR description that covers the full branch:

---

## Add health endpoint + user ID validation to API; Bedrock Headroom support and cost-accounting fixes for workshop eval

### Summary

- **API** (`api/src/index.ts`): add `GET /api/health → {"status":"ok"}` for liveness probes; add input validation on `GET /api/users/:id` returning HTTP 400 when the id is not a positive integer.
- **Eval runner** (`eval/run.ts`, `eval/run-all.sh`): fix multi-step cost accounting (`total_cost_usd` from `--resume` sessions is cumulative — now only the per-step delta is summed); add Bedrock-mode Headroom support via `--bedrock-api-url` + `--settings` passthrough; guard ON rows where the compression pipeline ran zero requests.
- **Workshop setup** (`setup.sh`): install Headroom into a venv (`~/.venvs/headroom`) instead of `pip install --user`, which Homebrew Python rejects (PEP 668).
- **Deck** (`deck/build-deck.js`): add prompt-cache savings calculation priced at list rates; improve Headroom findings card to show all three rows + proxy pipeline counts; export computed slide text to `slide-text.json`.
- **Docs** (`README.md`): update dry-run instructions for Bedrock mode; document venv install path and `HEADROOM_BIN` override.

### Changes

| File | What changed |
|---|---|
| `api/src/index.ts` | `GET /api/health` endpoint; positive-integer guard on `GET /api/users/:id` |
| `eval/run.ts` | Per-step cost delta from cumulative session total; `EVAL_CLAUDE_SETTINGS` flag; `cost_accounting` field in result JSON |
| `eval/run-all.sh` | Bedrock upstream detection; `--mode token` for Headroom proxy; pipeline-run count in metrics file; stricter ON validation |
| `setup.sh` | Headroom installed via `python3 -m venv` instead of `pip install --user` |
| `deck/build-deck.js` | Cache savings math; multi-row Headroom card; `EXPORT`/`slide-text.json` |
| `README.md` | Bedrock + venv + cost-accounting notes |

### How to test

**Health endpoint**
```bash
curl http://localhost:3001/api/health
# → {"status":"ok"}  HTTP 200
```

**User ID validation**
```bash
curl -i http://localhost:3001/api/users/abc    # 400 {"error":"id must be a positive integer"}
curl -i http://localhost:3001/api/users/-1     # 400
curl -i http://localhost:3001/api/users/0      # 400
curl -i http://localhost:3001/api/users/1      # 200 (valid row)
curl -i http://localhost:3001/api/users/9999   # 404 {"error":"not found"}
```

**Eval + deck (requires workshop setup)**
```bash
./setup.sh                            # should show ✓ for headroom in ~/.venvs
npm run eval:all -- --task 1          # smoke test; check Headroom A/B section ran
npm run build-deck                    # should write deck/slide-text.json alongside the pptx
```

For Bedrock mode, set `CLAUDE_CODE_USE_BEDROCK=1` and `ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:<local-gateway-port>` in `~/.claude/settings.json`; `eval:all` will detect the local URL and route Headroom's proxy in front of it automatically.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

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
  "input_tokens": 29,
  "output_tokens": 5435,
  "cache_read_input_tokens": 646682,
  "cache_creation_input_tokens": 45219,
  "total_tokens": 697365,
  "cost_usd": 0.44518784999999994,
  "num_turns": 19
}
```
