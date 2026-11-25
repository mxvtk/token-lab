# headroom_long__off task 6 rep 3

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
The two files together are a classic "works in dev, breaks in prod" setup. The logic is correct but the **operational envelope** is completely missing: no error boundaries, no pool health signaling, and no graceful lifecycle management. Every real outage will come from exactly these gaps.
`─────────────────────────────────────────────────`

---

## Production review — `api/src/`

### 1. Async route handlers have no error boundary — `index.ts:16`, `index.ts:24`

**Why it matters:** Express 4 does not catch rejected async route handlers. If `pool.query()` throws (DB timeout, cast error, any connection failure), the promise rejection is unhandled. In Node ≥ 15 that crashes the process; in earlier versions the client just hangs until it times out — no 500 is ever sent.

```ts
// fix both handlers the same way
app.get("/api/users", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id"
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/users:", err);
    res.status(500).json({ error: "internal server error" });
  }
});
```

---

### 2. No `pool.on("error")` handler — `db.ts:5`

**Why it matters:** `pg.Pool` emits an `"error"` event when an *idle* client encounters a network error (the DB server closed the connection while it sat in the pool). Without a listener, Node.js treats it as an uncaught error and crashes the process — even if no request was in flight.

```ts
export const pool = new Pool({ ... });

pool.on("error", (err) => {
  console.error("idle client error:", err);
  // do NOT rethrow — just log. The pool self-heals on the next acquire.
});
```

---

### 3. Startup `withRetry` rejection is never caught — `index.ts:38`

**Why it matters:** If the DB is never reachable, `withRetry` exhausts its attempts and rejects. There is no `.catch()`, so the process either crashes or silently does nothing — it never calls `app.listen()`, so the port is never bound, but the process stays alive and looks healthy to a supervisor. Services like Kubernetes will not restart it because the process is still running.

```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("DB never became ready:", err);
    process.exit(1); // force restart by supervisor
  });
```

---

### 4. `withRetry` retries permanent errors, not just transient ones — `db.ts:13`

**Why it matters:** The retry loop catches *all* errors. A bad `PGPASSWORD`, a missing database name, or a DNS failure that will never resolve will still spin 10 times with 1-second pauses before surfacing. This turns a 0-second fail-fast into a 10-second mystery delay, and silently retries things that retrying cannot fix.

```ts
const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "57P03"]);

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (!TRANSIENT_CODES.has(err?.code)) throw err; // fail fast on permanent errors
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1))); // exponential back-off
    }
  }
  throw lastErr;
}
```

---

### 5. `:id` param is not validated before hitting the DB — `index.ts:25`

**Why it matters:** `req.params.id` is a raw string from the URL. If it's not a valid integer (e.g., `/api/users/abc` or `/api/users/999999999999999999999`), PostgreSQL throws `invalid input syntax for type integer` or `integer out of range`. Combined with issue #1 (no try/catch), that becomes an unhandled rejection. Even with a try/catch this produces a confusing 500 when a 400 is correct.

```ts
app.get("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users WHERE id = $1",
      [id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("GET /api/users/:id:", err);
    res.status(500).json({ error: "internal server error" });
  }
});
```

---

### 6. No connection timeout on the pool — `db.ts:5`

**Why it matters:** With no `connectionTimeoutMillis`, a request that arrives when all 10 pool slots are busy waits *indefinitely* for a slot to free. Under load this causes requests to pile up in memory until the process OOMs rather than shedding load with a 503. `idleTimeoutMillis` is also missing, so idle connections are never released back to the DB server.

```ts
export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "tokenlab",
  password: process.env.PGPASSWORD ?? "tokenlab",
  database: process.env.PGDATABASE ?? "tokenlab",
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,  // fail with ETIMEDOUT instead of hanging
});
```

---

### 7. `PORT` env var not validated — `index.ts:36`

**Why it matters:** `Number("abc")` returns `NaN`. `app.listen(NaN)` does not throw — Node.js silently coerces it to `0`, which picks an arbitrary ephemeral port. The log says `api listening on :NaN` and nothing can reach the service.

```ts
const rawPort = process.env.PORT ?? "3001";
const port = parseInt(rawPort, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid PORT: "${rawPort}"`);
  process.exit(1);
}
```

---

### 8. No graceful shutdown — `index.ts:38`

**Why it matters:** On `SIGTERM` (every deploy, every `docker stop`, every k8s rolling update), the process dies instantly. In-flight requests are dropped mid-response and the pool is closed without draining. The DB may hold locks or transactions open.

```ts
const server = app.listen(port, () => console.log(`api listening on :${port}`));

process.on("SIGTERM", () => {
  server.close(async () => {       // stop accepting new connections
    await pool.end();              // drain and close all pool connections
    process.exit(0);
  });
});
```

---

### 9. CORS wildcard with no OPTIONS handler — `index.ts:8`

**Why it matters:** `Access-Control-Allow-Origin: *` is intentional here. But there's no `OPTIONS` route handler. When a browser sends a CORS preflight for any non-simple request (e.g., a future `POST` with `Content-Type: application/json`), Express returns 404. The request never reaches the actual handler and the browser shows a CORS error — not a 404 — making it very confusing to debug.

```ts
// add before the other app.use() calls
app.options("*", (_req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  res.sendStatus(204);
});
```

---

### 10. `GET /api/users` has no pagination — `index.ts:16`

**Why it matters:** `SELECT … FROM users ORDER BY id` with no `LIMIT` returns every row in the table. At scale this is a full table scan, an unbounded JSON payload, and a memory spike on both sides. This is the most common "it was fine in dev" performance cliff.

```ts
app.get("/api/users", async (req, res) => {
  const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 200);
  const cursor = parseInt((req.query.after as string) ?? "0", 10) || 0;
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users WHERE id > $1 ORDER BY id LIMIT $2",
      [cursor, limit]
    );
    res.json({ rows, next: rows.length === limit ? rows[rows.length - 1].id : null });
  } catch (err) { ... }
});
```

---

`★ Insight ─────────────────────────────────────`
Issues #1, #2, #3 form a cascade: a single DB hiccup can crash the process, and if it doesn't crash, the lack of a `.catch()` on startup means the server silently fails to bind — a pattern that defeats health checks entirely. The `withRetry`-only-at-startup design also means transient errors during normal operation (issues the pool would naturally recover from) are never retried in routes.
`─────────────────────────────────────────────────`

**Summary by category:**

| # | Severity | Category | File |
|---|----------|----------|------|
| 1 | Critical | Error handling | index.ts:16,24 |
| 2 | Critical | Operability | db.ts:5 |
| 3 | Critical | Operability | index.ts:38 |
| 4 | High | Correctness | db.ts:13 |
| 5 | High | Input validation + security | index.ts:25 |
| 6 | High | Performance | db.ts:5 |
| 7 | High | Correctness | index.ts:36 |
| 8 | High | Operability | index.ts:38 |
| 9 | Medium | Security / CORS | index.ts:8 |
| 10 | Medium | Performance | index.ts:16 |

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 5185,
  "cache_read_input_tokens": 55180,
  "cache_creation_input_tokens": 18024,
  "total_tokens": 78393,
  "cost_usd": 0.20248500000000003,
  "num_turns": 3
}
```
