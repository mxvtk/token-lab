# headroom_long__on task 6 rep 1

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
Both files are short but dense with production risk: the two most dangerous classes here are **silent unhandled rejections** (Node ≥15 crashes on these with no log) and **missing input validation at the HTTP boundary** — a classic pattern where everything works in the happy path and silently breaks in production.
`─────────────────────────────────────────────────`

---

## Production review — `api/src/index.ts` & `api/src/db.ts`

---

### 1. `index.ts:17` and `index.ts:24` — Unhandled rejections in route handlers crash the process

**Why it matters:** Both async route handlers `await` a pool query with no `try/catch`. When the DB is unreachable, pg returns a rejected promise. In Express 4 (without `express-async-errors`), an async rejection is *not* forwarded to the error middleware — it becomes an unhandled rejection. Node.js ≥15 terminates the process on `unhandledRejection`. The client receives no response and hangs until its timeout fires.

**Fix:**
```ts
app.get("/api/users", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id LIMIT 1000"
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/users error", err);
    res.status(500).json({ error: "internal server error" });
  }
});

app.get("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);           // see finding #5
  if (isNaN(id)) return res.status(400).json({ error: "id must be numeric" });
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users WHERE id = $1",
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("GET /api/users/:id error", err);
    res.status(500).json({ error: "internal server error" });
  }
});
```

---

### 2. `index.ts:38` — Startup `withRetry` rejection is unhandled

**Why it matters:** If the DB remains down through all 10 retries, `withRetry` throws. The `.then(...)` chain has no `.catch()`. On Node ≥15 this triggers `unhandledRejection` and the process exits with no message in stderr — operators get a dead container with no explanation.

**Fix:**
```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("Could not connect to database after retries:", err);
    process.exit(1);
  });
```

---

### 3. `index.ts:36` — `??` doesn't guard empty-string `PORT`

**Why it matters:** `??` only short-circuits on `null`/`undefined`. If `PORT=""` (common in some PaaS environments that unset a var by setting it empty), `Number("") === 0`. `app.listen(0)` binds to a random ephemeral port; health checks and load-balancer probes targeting `:3001` all fail with `ECONNREFUSED`.

**Fix:**
```ts
const port = parseInt(process.env.PORT || "3001", 10);
// or: Number(process.env.PORT) || 3001
```

---

### 4. `db.ts:7` — Same `??` / empty-string bug with `PGPORT`

**Why it matters:** Same root cause as finding #3. `Number(process.env.PGPORT ?? 5432)` with `PGPORT=""` produces `port: 0`, making the pool try to connect on port 0. The pool will error on every query. The symptom is identical: broken silently.

**Fix:**
```ts
port: Number(process.env.PGPORT) || 5432,
```

---

### 5. `index.ts:27` — `req.params.id` not validated before hitting the DB

**Why it matters:** `req.params.id` is a raw string. If the caller passes `"abc"`, PostgreSQL throws `invalid input syntax for type integer`. Without try/catch (finding #1) this hangs the response. Even with try/catch it returns 500 when the correct code is 400 — a distinguishable client error that clients can act on. Additionally, an integer overflow (e.g. `id=99999999999999999999`) can produce unexpected DB behaviour.

**Fix:**
```ts
const id = parseInt(req.params.id, 10);
if (!Number.isFinite(id) || id <= 0) {
  return res.status(400).json({ error: "id must be a positive integer" });
}
```

---

### 6. `index.ts:17-18` — `SELECT … FROM users` with no `LIMIT` — unbounded table scan

**Why it matters:** `GET /api/users` returns every row in the table. At 10 k rows it's slow; at 1 M it OOMs the Node process or stalls the event loop serialising the JSON payload. There is no pagination and no warning to callers.

**Fix:**
```ts
// Minimum viable guard; pagination is better long-term
"SELECT id, email, created_at FROM users ORDER BY id LIMIT 1000"
```
Or add `offset`/`limit` query params and document the endpoint contract.

---

### 7. `db.ts:5-11` — Pool has no size cap, no connection timeout, no idle timeout

**Why it matters:**
- **No `max`:** `pg.Pool` defaults to `max: 10`. Fine now, but invisible — an operator reading the code can't tell if 10 is intentional or an omission. If the app scales horizontally, 3 replicas × 10 = 30 connections with nothing to prevent exhausting `max_connections` on a small Postgres instance.
- **No `connectionTimeoutMillis`:** Defaults to 0 (wait forever). A connection request queued behind a stalled one never times out, causing requests to hang rather than fast-fail.
- **No `idleTimeoutMillis`:** Idle connections are held forever; on ephemeral networks (k8s pod restarts, NAT timeouts) the pool accumulates stale connections that error on first use.

**Fix:**
```ts
export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER ?? "tokenlab",
  password: process.env.PGPASSWORD,         // see finding #8
  database: process.env.PGDATABASE ?? "tokenlab",
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});
```

---

### 8. `db.ts:9` — Hardcoded fallback password `"tokenlab"`

**Why it matters:** If `PGPASSWORD` is absent in production (misconfigured secret mount, typo in env var name), the app silently connects with the default password and either authenticates if someone left the dev password in prod, or fails with a confusing auth error that obscures the real problem (missing secret). A missing secret should be a hard startup failure, not a silent fallback.

**Fix:**
```ts
// Fail fast on startup if the secret is missing
const pgPassword = process.env.PGPASSWORD;
if (!pgPassword) {
  console.error("PGPASSWORD is required");
  process.exit(1);
}

export const pool = new Pool({
  ...
  password: pgPassword,
  ...
});
```

---

### 9. `index.ts:9-13` — CORS advertises POST/PUT/DELETE but no `OPTIONS` handler exists

**Why it matters:** Browsers issue a preflight `OPTIONS` request before any cross-origin non-simple request (POST, PUT, DELETE, or any request with a non-standard header). Express returns 404 for OPTIONS by default. The preflight fails, the browser blocks the real request with a CORS error. The only methods actually implemented are GET — so the `Allow-Methods` header is misleading on top of being broken.

**Fix (option A — trim to what's real):**
```ts
res.header("Access-Control-Allow-Methods", "GET");
// no OPTIONS route needed; GETs are simple requests
```

**Fix (option B — handle preflight):**
```ts
app.options("*", (_req, res) => res.sendStatus(204));
```

---

### 10. `index.ts` — No graceful shutdown; in-flight requests are killed hard

**Why it matters:** When a container orchestrator sends `SIGTERM` (rolling deploy, scale-down, pod eviction), Node exits immediately. Any in-flight DB queries are abandoned mid-flight, leaving the pool connection in an indeterminate state on the server side and returning a TCP RST to the client instead of a proper HTTP response.

**Fix:**
```ts
const server = app.listen(port, () => console.log(`api listening on :${port}`));

process.on("SIGTERM", () => {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
});
```

---

`★ Insight ─────────────────────────────────────`
Findings 1–3 form a chain: the startup path, the route handlers, and the port parsing all share the same root pattern of assuming the happy path. In a workshop context this is intentional to keep the code short, but all three would fire in the first real production incident. Findings 7–8 (pool config + secret guard) are the ones most commonly added only after the first on-call page.
`─────────────────────────────────────────────────`

**Summary by category:**

| # | File:Line | Category | Severity |
|---|-----------|----------|---------|
| 1 | `index.ts:17,24` | Error handling | Critical |
| 2 | `index.ts:38` | Error handling | Critical |
| 3 | `index.ts:36` | Correctness | High |
| 4 | `db.ts:7` | Correctness | High |
| 5 | `index.ts:27` | Input validation / security | High |
| 6 | `index.ts:17` | Performance | Medium |
| 7 | `db.ts:5-11` | Operability / performance | Medium |
| 8 | `db.ts:9` | Security | Medium |
| 9 | `index.ts:9-13` | Correctness (CORS) | Low |
| 10 | `index.ts:38-42` | Operability | Low |

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 5,
  "output_tokens": 5595,
  "cache_read_input_tokens": 94339,
  "cache_creation_input_tokens": 20785,
  "total_tokens": 120724,
  "cost_usd": 0.569118,
  "num_turns": 4,
  "permission_denials": 0
}
```
