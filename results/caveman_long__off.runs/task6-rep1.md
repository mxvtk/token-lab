# caveman_long__off task 6 rep 1

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix" # live_only: opens a real PR — never part of the batch A/B; run by hand with --task 5.

## Agent result

`★ Insight ─────────────────────────────────────`
This is a compact Express + pg service, so the review spans two categories: (1) **correctness/crash bugs** that will fire the moment a bad request or blip arrives in production, and (2) **hardening gaps** (CORS, missing limits, no graceful shutdown) that are easy to skip in a workshop but non-negotiable before shipping.
`─────────────────────────────────────────────────`

---

## api/src/index.ts

---

### 1. Async route handlers have no error handling — unhandled rejection crashes the process
**Lines 16–21, 24–34**

Express 4 does **not** automatically forward rejected promises from `async` route handlers to the error middleware. If `pool.query()` throws (DB connection lost, query timeout, constraint violation), Node.js emits an `unhandledRejection` and the process exits.

```typescript
// Every async handler needs this pattern:
app.get("/api/users", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id LIMIT 1000"
    );
    res.json(rows);
  } catch (err) {
    next(err); // hands off to the error middleware below
  }
});

// Add a catch-all error middleware at the bottom:
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});
```

> Alternatively, upgrade to Express 5 (`npm i express@5`), which natively awaits async handlers. Either way, the error middleware is still required.

---

### 2. No validation on `:id` — invalid input causes a pg error that crashes the handler
**Line 27**

`req.params.id` is a raw string. `GET /api/users/abc` passes `'abc'` as `$1` to a column typed `integer`. PostgreSQL throws `invalid input syntax for type integer` — which, combined with issue #1, is an unhandled rejection.

```typescript
app.get("/api/users/:id", async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
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
    next(err);
  }
});
```

---

### 3. Startup DB-connection failure is silently swallowed
**Lines 38–42**

`withRetry(...).then(...)` has no `.catch()`. If the DB is unreachable after 10 attempts, the promise rejects, nothing catches it, and the server either silently exits or emits an unhandledRejection — neither outcome is debuggable in a container log.

```typescript
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("fatal: cannot connect to database", err);
    process.exit(1);
  });
```

---

### 4. Wildcard CORS is a security issue for production
**Line 9**

`Access-Control-Allow-Origin: *` is fine for a local workshop, but in production it allows any origin to make credentialed cross-site requests against the API. Restrict to known origins.

```typescript
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173").split(",")
);

app.use((req, res, next) => {
  const origin = req.headers.origin ?? "";
  if (ALLOWED_ORIGINS.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  next();
});
```

---

### 5. Missing OPTIONS handler — CORS preflight returns 404
**Lines 8–13**

The browser sends a preflight `OPTIONS` request before cross-origin `POST`/`PUT`/`DELETE`. There is no `OPTIONS` handler, so the preflight gets a 404 and the actual request is blocked.

```typescript
app.options("*", (_req, res) => {
  res.status(204).end();
});
```

Or replace the manual CORS block with the `cors` package, which handles OPTIONS automatically.

---

### 6. `GET /api/users` returns an unbounded result set
**Lines 17–19**

No `LIMIT`. On a large table this will read every row, exhaust pool memory, and time out. Add pagination.

```typescript
// Minimal: add a hard cap
"SELECT id, email, created_at FROM users ORDER BY id LIMIT 1000"

// Better: cursor-based pagination
app.get("/api/users", async (req, res, next) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const after  = req.query.after ? Number(req.query.after) : 0;
  // ... WHERE id > $1 ORDER BY id LIMIT $2
});
```

---

### 7. No graceful shutdown — in-flight requests killed on deploy
**index.ts (no SIGTERM handler)**

Kubernetes sends `SIGTERM` before killing a pod. Without a handler, the process exits immediately, dropping all in-flight requests.

```typescript
const server = app.listen(port, () => console.log(`api listening on :${port}`));

process.on("SIGTERM", () => {
  server.close(() => {           // stop accepting new connections
    pool.end(() => {             // drain the pool
      process.exit(0);
    });
  });
});
```

---

### 8. No health / readiness endpoint
**index.ts**

Without a `/health` endpoint, Kubernetes liveness and load-balancer health checks have nothing to call. The check should verify the pool is reachable, not just that the process is up.

```typescript
app.get("/health", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (err) {
    next(err);
  }
});
```

---

## api/src/db.ts

---

### 9. `withRetry` retries every error, not just transient ones
**Lines 13–24**

`ECONNREFUSED` during startup is transient and worth retrying. `password authentication failed`, `database "foo" does not exist`, or a syntax error are permanent — retrying them 10 times wastes 10 seconds and buries the real error. At minimum, check the pg error code.

```typescript
function isTransient(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    // pg connection-refused, server-not-ready, lost connection
    return ["ECONNREFUSED", "ECONNRESET", "57P03", "08006", "08001"].includes(code ?? "");
  }
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err)) throw err; // fail fast on non-transient errors
      lastErr = err;
      const delay = Math.min(1000 * 2 ** i + Math.random() * 200, 10_000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
```

This change also adds **exponential backoff with jitter**, replacing the flat 1 s sleep that causes thundering-herd when many containers restart simultaneously.

---

### 10. No connection timeout — pool acquisition hangs forever
**Lines 5–11**

`connectionTimeoutMillis` defaults to `0` (wait forever). A single slow or unreachable DB makes every request queue silently. Set an explicit limit.

```typescript
export const pool = new Pool({
  host:     process.env.PGHOST     ?? "db",
  port:     Number(process.env.PGPORT ?? 5432),
  user:     process.env.PGUSER     ?? "tokenlab",
  password: process.env.PGPASSWORD ?? "tokenlab",
  database: process.env.PGDATABASE ?? "tokenlab",
  max:                    10,
  connectionTimeoutMillis: 3_000,  // fail fast if pool is exhausted
  idleTimeoutMillis:      30_000,
  statement_timeout:      5_000,   // kill runaway queries
});
```

---

### 11. Hardcoded fallback credentials
**Lines 8–9**

`password: process.env.PGPASSWORD ?? "tokenlab"` means forgetting to set the env var in production silently uses the dev password. The password should have no default, or the app should refuse to start.

```typescript
const pgPassword = process.env.PGPASSWORD;
if (!pgPassword) {
  console.error("fatal: PGPASSWORD is required");
  process.exit(1);
}

export const pool = new Pool({
  // ...
  password: pgPassword,
  // ...
});
```

---

### 12. No SSL configuration
**Lines 5–11**

Production databases should require TLS. Without `ssl`, traffic is unencrypted and the connection will be rejected by most managed DB services that enforce SSL.

```typescript
export const pool = new Pool({
  // ...
  ssl: process.env.PGSSLMODE === "disable"
    ? false
    : { rejectUnauthorized: process.env.NODE_ENV === "production" },
});
```

---

## Summary table

| # | File | Lines | Severity | Category |
|---|------|--------|----------|----------|
| 1 | index.ts | 16–34 | **Critical** | No error handling → process crash |
| 2 | index.ts | 27 | **Critical** | No `:id` validation → pg crash |
| 3 | index.ts | 38–42 | **Critical** | Startup failure silently swallowed |
| 4 | index.ts | 9 | **High** | Wildcard CORS |
| 5 | index.ts | 8–13 | **High** | Missing OPTIONS preflight handler |
| 6 | index.ts | 17–19 | **High** | Unbounded query, no pagination |
| 7 | index.ts | — | **High** | No SIGTERM/graceful shutdown |
| 8 | index.ts | — | **High** | No health endpoint |
| 9 | db.ts | 13–24 | **High** | Retries permanent errors + flat delay |
| 10 | db.ts | 5–11 | **High** | No connection timeout |
| 11 | db.ts | 8–9 | **Medium** | Hardcoded fallback credentials |
| 12 | db.ts | 5–11 | **Medium** | No SSL config |

`★ Insight ─────────────────────────────────────`
The most common prod outage pattern for Express+pg services is issue #1 combined with #2: an unexpected input hits a code path that wasn't unit-tested, pg throws, Express 4 doesn't catch it, and the pod restarts. The fix (try/catch + `next(err)` + a catch-all error middleware) is small but eliminates the entire crash class. Issues #3 and #9 are the same pattern at startup time — startup retry logic that never surfaces the real error, and that retries things it shouldn't, is one of the top causes of Kubernetes pods stuck in CrashLoopBackOff with unhelpful logs.
`─────────────────────────────────────────────────`

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 5348,
  "cache_read_input_tokens": 55150,
  "cache_creation_input_tokens": 17977,
  "total_tokens": 78479,
  "cost_usd": 0.20463900000000002,
  "num_turns": 3
}
```
