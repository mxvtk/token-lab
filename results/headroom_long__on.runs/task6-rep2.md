# headroom_long__on task 6 rep 2

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
Express 4 does **not** automatically forward thrown errors from async route handlers to the error middleware — they become unhandled promise rejections. Express 5 fixes this, but most codebases are still on v4. The pattern `async (req, res) => { ... }` without try/catch is a silent crash vector.
`─────────────────────────────────────────────────`

Here is the full review. Issues are ordered by severity.

---

## Critical

### 1. Async route handlers have no error handling — unhandled rejections crash the process

**`index.ts:17`**, **`index.ts:25`**

Any DB error (connection drop, syntax error, type mismatch) rejects the promise. In Express 4 these are not caught by error middleware and become unhandled rejections. Node ≥ 15 terminates the process on unhandled rejections.

```ts
// Every route must wrap the DB call:
app.get("/api/users", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id"
    );
    res.json(rows);
  } catch (err) {
    next(err); // hands off to Express error middleware
  }
});

// Add a catch-all error handler at the bottom of index.ts:
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});
```

---

### 2. Pool `error` event is unhandled — idle client errors crash the process

**`db.ts` (no line — event never wired)**

When the database kills an idle connection, `pg.Pool` emits `'error'` on the pool. Without a listener this becomes an uncaught exception and crashes Node.

```ts
export const pool = new Pool({ ... });

pool.on("error", (err) => {
  console.error("pg pool idle client error", err);
  // Don't throw — let the pool reconnect; individual queries will
  // surface their own errors through normal promise rejection.
});
```

---

### 3. `:id` is not validated — a non-integer path segment throws a DB error

**`index.ts:27`**

`req.params.id` is a raw string. `GET /api/users/abc` sends `'abc'` as `$1` to a query that likely casts it to `integer`, which throws `invalid input syntax for type integer`. Combined with issue #1 this crashes the process; with error handling it still leaks that the column is an integer.

```ts
app.get("/api/users/:id", async (req, res, next) => {
  const id = Number(req.params.id);
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
    next(err);
  }
});
```

---

## High

### 4. Startup DB failure is an unhandled rejection

**`index.ts:38`**

If `withRetry` exhausts all retries the returned promise rejects. `.then(...)` with no `.catch(...)` leaves it unhandled; the process terminates without a helpful log line and without calling `app.listen`.

```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("database unreachable after retries, exiting", err);
    process.exit(1);
  });
```

---

### 5. `withRetry` retries permanent errors (wrong password, missing DB)

**`db.ts:13`**

Every error is retried — including `password authentication failed`, `database "x" does not exist`, or `role "x" does not exist`. These will never succeed and you waste 10 seconds before surfacing the real message.

```ts
const TRANSIENT_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT",
  "57P01", // admin shutdown
  "08006", // connection failure
  "08001", // unable to connect
]);

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const code: string = err?.code ?? "";
      const isTransient =
        TRANSIENT_CODES.has(code) ||
        err?.message?.includes("ECONNREFUSED");
      if (!isTransient) throw err; // fail fast on permanent errors
      lastErr = err;
      const delay = Math.min(1000 * 2 ** i, 15_000); // exponential backoff
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
```

---

### 6. No graceful shutdown — in-flight requests are dropped on SIGTERM

**`index.ts` (not present)**

Kubernetes and Docker send `SIGTERM` before killing the process. Without a shutdown handler the pool is closed mid-query and all in-flight requests get connection errors.

```ts
const server = app.listen(port, () => console.log(`api listening on :${port}`));

process.on("SIGTERM", () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});
```

---

### 7. CORS wildcard with no preflight handler

**`index.ts:9`** and **`index.ts:8-13`**

`Access-Control-Allow-Origin: *` is fine for a fully public API, but without an `OPTIONS` handler browsers never receive a 2xx for preflight requests, so cross-origin `POST`/`PUT`/`DELETE` with a `Content-Type` header will fail.

```ts
// Replace the manual middleware with the cors package — handles OPTIONS automatically:
import cors from "cors";

app.use(cors({
  origin: process.env.CORS_ORIGIN ?? "*", // lock down to known origins in prod
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type"],
}));
```

---

## Medium

### 8. Hardcoded credential defaults silently succeed with wrong config

**`db.ts:7-10`**

```ts
user: process.env.PGUSER ?? "tokenlab",
password: process.env.PGPASSWORD ?? "tokenlab",
```

If environment variables are missing in production the server starts using the defaults and connects to whatever database accepts them. Missing config should fail loudly.

```ts
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var ${name} is not set`);
  return val;
}

export const pool = new Pool({
  host:     process.env.PGHOST     ?? "db",
  port:     Number(process.env.PGPORT ?? 5432),
  user:     requireEnv("PGUSER"),
  password: requireEnv("PGPASSWORD"),
  database: requireEnv("PGDATABASE"),
});
```

---

### 9. Pool connection limit is implicit

**`db.ts:5`**

`pg.Pool` defaults to `max: 10`. In a container where you are the only service that is fine; in a shared environment you may exhaust the DB's `max_connections`. Make the limit explicit and configurable.

```ts
export const pool = new Pool({
  ...
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});
```

---

### 10. `PORT` env var not validated — `NaN` silently misbehaves

**`index.ts:36`**

```ts
const port = Number(process.env.PORT ?? 3001);
```

If `PORT=banana` is set, `Number("banana")` is `NaN` and `app.listen(NaN)` picks an OS-assigned port, not a startup error.

```ts
const rawPort = process.env.PORT ?? "3001";
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${rawPort}`);
}
```

---

## Minor

### 11. No request logging

**`index.ts`** (not present)

There is no access log. In production you cannot reconstruct what requests were made when investigating incidents.

```ts
import morgan from "morgan";
app.use(morgan("combined")); // before routes
```

---

### 12. `GET /api/users` has no pagination or limit

**`index.ts:17`**

`SELECT ... FROM users ORDER BY id` with no `LIMIT` returns every row. On a large table this will cause slow queries, high memory, and large payloads.

```ts
app.get("/api/users", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id LIMIT 100"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
```

---

`★ Insight ─────────────────────────────────────`
Issues #1 and #2 are the same root cause: **anything that can emit an `error` event or reject a promise must have an explicit handler**, or Node's default behavior terminates the process. The pattern to remember is: pool events → `.on('error')`, async route handlers → `try/catch` + `next(err)`, startup promises → `.catch(...)`.
`─────────────────────────────────────────────────`

---

**Summary table**

| # | File | Line | Severity | Category |
|---|------|------|----------|----------|
| 1 | index.ts | 17, 25 | Critical | Error handling |
| 2 | db.ts | — | Critical | Error handling |
| 3 | index.ts | 27 | Critical | Input validation |
| 4 | index.ts | 38 | High | Error handling |
| 5 | db.ts | 13 | High | Correctness |
| 6 | index.ts | — | High | Operability |
| 7 | index.ts | 8–13 | High | Security / correctness |
| 8 | db.ts | 7–10 | Medium | Security / config |
| 9 | db.ts | 5 | Medium | Performance |
| 10 | index.ts | 36 | Medium | Correctness |
| 11 | index.ts | — | Minor | Operability |
| 12 | index.ts | 17 | Minor | Performance |

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 4604,
  "cache_read_input_tokens": 55325,
  "cache_creation_input_tokens": 18280,
  "total_tokens": 78213,
  "cost_usd": 0.19534949999999998,
  "num_turns": 3,
  "permission_denials": 0
}
```
