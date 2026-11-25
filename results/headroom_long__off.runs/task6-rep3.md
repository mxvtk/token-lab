# headroom_long__off task 6 rep 3

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
- Express 4 does **not** automatically forward uncaught errors from `async` route handlers to error middleware — the promise rejects silently, leaving the client hanging. Express 5 fixes this, but only if you're on it.
- Parameterized queries (`$1`) protect against SQL injection, but they don't protect against invalid types reaching PostgreSQL — the DB still errors, just at the type-cast layer instead.
- Pool configuration defaults are invisible in code review; explicitly setting `max`, `connectionTimeoutMillis`, and `idleTimeoutMillis` makes capacity decisions auditable.
`─────────────────────────────────────────────────`

---

## Code Review — `api/src/db.ts` and `api/src/index.ts`

---

### 1. **[Correctness] Unhandled async route handlers will silently hang or crash**

`index.ts:16–21` and `index.ts:24–34`

Both route handlers are `async` with no `try/catch`. In Express 4, a rejected promise is an unhandled rejection — Express never sees it, so the client gets no response and eventually times out. This affects every DB error: connection loss, query timeout, schema mismatch, etc.

```typescript
// Every route needs this pattern
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

The alternative is a wrapper once at the top:
```typescript
function asyncRoute(fn: (req: express.Request, res: express.Response) => Promise<void>) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    fn(req, res).catch(next);
  };
}
// Then: app.get("/api/users", asyncRoute(async (_req, res) => { ... }));
```

---

### 2. **[Security / Correctness] No input validation on `:id`**

`index.ts:27`

```typescript
[req.params.id]   // passed raw to $1
```

A parameterized query prevents SQL injection, but `req.params.id` is a raw string. Sending `/api/users/abc` or `/api/users/0` or `/api/users/99999999999999999999` causes PostgreSQL to throw an invalid integer cast error — which (per issue 1) hangs the client. Explicitly validate before touching the DB:

```typescript
app.get("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  // ...pool.query(..., [id])
});
```

---

### 3. **[Security] Hardcoded default credentials committed to source**

`db.ts:8–10`

```typescript
password: process.env.PGPASSWORD ?? "tokenlab",
```

The literal string `"tokenlab"` is now in git history. If the env var is ever unset in a deployment, the server silently connects with known credentials. Remove the fallback entirely and fail loudly at startup:

```typescript
const password = process.env.PGPASSWORD;
if (!password) throw new Error("PGPASSWORD is required");

export const pool = new Pool({ ..., password });
```

Same applies to `PGUSER` and `PGDATABASE` if they must be set for correctness.

---

### 4. **[Correctness] `withRetry` retries non-transient errors**

`db.ts:15–21`

The catch-all `catch (err)` retries every failure — including authentication errors, bad config, missing database, and pg client bugs. A wrong password will silently retry 10 times, sleeping 10 seconds, before surfacing the actual error. Only transient connectivity errors should be retried:

```typescript
function isTransient(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  // connection refused, server not ready, server reset connection
  return ["ECONNREFUSED", "ENOTFOUND", "57P03", "08006", "08001"].includes(code ?? "");
}

for (let i = 0; i < tries; i++) {
  try {
    return await fn();
  } catch (err) {
    if (!isTransient(err)) throw err;   // fail fast on non-transient errors
    lastErr = err;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); // exponential backoff
  }
}
```

---

### 5. **[Operability] Startup DB failure becomes an unhandled rejection with no exit code**

`index.ts:38–42`

```typescript
withRetry(() => pool.query("SELECT 1")).then(() => {
  app.listen(port, ...);
});
// no .catch()
```

If `withRetry` exhausts all retries, the resulting promise rejection is unhandled. Node.js behavior on unhandled rejections varies by version — it may print a warning but continue running (Node < 15) or crash with exit code 1 (Node ≥ 15). Neither is explicit. Orchestrators that watch exit codes need a guaranteed non-zero exit:

```typescript
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("Database connection failed after retries:", err);
    process.exit(1);
  });
```

---

### 6. **[Security] `Access-Control-Allow-Origin: *` with no OPTIONS handler**

`index.ts:9–13`

The wildcard CORS origin is noted as a workshop convenience, but two additional bugs remain regardless:

1. **OPTIONS preflight is never handled.** A browser issuing a preflight `OPTIONS /api/users` gets a `404` (Express finds no matching route), causing the actual request to be blocked.
2. **`Access-Control-Allow-Headers`** is set but `Access-Control-Allow-Credentials` is not, so cookies/auth headers would silently not work if added later.

```typescript
app.options("*", (_req, res) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN ?? "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  res.sendStatus(204);
});
```

For production, replace `"*"` with an explicit origin from env.

---

### 7. **[Security] No body size limit on `express.json()`**

`index.ts:5`

```typescript
app.use(express.json());
```

The default body size limit in Express is 100 KB for JSON. That's the library default, but it's not enforced explicitly and not visible here. If the default ever changes, or if someone is reading this code to audit attack surface, it looks like there's no limit. Be explicit:

```typescript
app.use(express.json({ limit: "100kb" }));
```

---

### 8. **[Performance] `GET /api/users` has no pagination**

`index.ts:17`

```typescript
"SELECT id, email, created_at FROM users ORDER BY id"
```

No `LIMIT` or `OFFSET`. With enough users this returns the full table into Node.js memory and streams it all to the client. It will time out or OOM before the client gives up. Even a simple hard cap prevents the worst case:

```typescript
const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
const offset = parseInt(req.query.offset as string) || 0;
pool.query(
  "SELECT id, email, created_at FROM users ORDER BY id LIMIT $1 OFFSET $2",
  [limit, offset]
);
```

---

### 9. **[Performance] Pool has no connection timeout or max configuration**

`db.ts:5–11`

```typescript
export const pool = new Pool({
  host: ...,
  // no max, no connectionTimeoutMillis, no idleTimeoutMillis
});
```

`pg`'s default `max` is 10, but it's invisible here. More critically, without `connectionTimeoutMillis`, a request that arrives when all 10 slots are occupied will queue **indefinitely**. Under load this causes requests to pile up in memory:

```typescript
export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "tokenlab",
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? "tokenlab",
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000,   // fail fast if pool is saturated
});
```

---

### 10. **[Operability] No health/readiness endpoint**

`index.ts` (absent)

Kubernetes liveness and readiness probes, load balancer health checks, and uptime monitors all need an endpoint that:
- returns `200` when the server can serve traffic (DB reachable)
- returns `503` when it can't

Without it, a pod with a broken DB connection looks healthy to the orchestrator and continues to receive traffic.

```typescript
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});
```

---

### 11. **[Operability] No request logging**

`index.ts` (absent)

There is no logging middleware. In production you need at minimum method, path, status code, and latency for every request. Without it, any incident investigation is blind. Add a minimal middleware before the routes:

```typescript
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      })
    );
  });
  next();
});
```

Or use `morgan` / `pino-http` for structured log lines.

---

### 12. **[Performance] Fixed 1-second retry interval with no jitter**

`db.ts:19`

```typescript
await new Promise((r) => setTimeout(r, 1000));
```

All retries fire at exactly 1-second intervals. If multiple instances start simultaneously (e.g., a k8s rollout), they all hammer the DB at the same cadence — a thundering herd. Exponential backoff with jitter spreads load:

```typescript
const delay = Math.min(1000 * 2 ** i, 10_000);           // cap at 10s
const jitter = Math.random() * 500;                        // ±500 ms
await new Promise((r) => setTimeout(r, delay + jitter));
```

---

`★ Insight ─────────────────────────────────────`
- Issues 1 and 5 are the highest blast-radius ones: a single DB hiccup can silently hang every in-flight request and leave the process in an indeterminate state.
- Issues 3 and 6 are the most likely to surface in a security audit — credentials in source history are permanent and OPTIONS failures block legitimate browsers from ever reaching the API.
- The pattern of "no pagination + no error handling + no connection timeout" (issues 1, 8, 9) creates a scenario where a burst of traffic triggers a full-table scan, saturates the connection pool, then those queued requests all hang indefinitely.
`─────────────────────────────────────────────────`

**Summary of priorities:**

| # | Category | Severity | File:Line |
|---|---|---|---|
| 1 | Correctness | P0 | `index.ts:16,24` |
| 2 | Security/Correctness | P0 | `index.ts:27` |
| 5 | Operability | P0 | `index.ts:38` |
| 3 | Security | P1 | `db.ts:8–10` |
| 4 | Correctness | P1 | `db.ts:15–21` |
| 6 | Security | P1 | `index.ts:9–13` |
| 7 | Security | P1 | `index.ts:5` |
| 8 | Performance | P2 | `index.ts:17` |
| 9 | Performance | P2 | `db.ts:5–11` |
| 10 | Operability | P2 | absent |
| 11 | Operability | P2 | absent |
| 12 | Performance | P3 | `db.ts:19` |

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 5729,
  "cache_read_input_tokens": 55152,
  "cache_creation_input_tokens": 17984,
  "total_tokens": 78869,
  "cost_usd": 0.21039660000000002,
  "num_turns": 3,
  "permission_denials": 0
}
```
