# headroom_long__on task 6 rep 2

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
Both files are intentionally minimal (workshop context), but several of the gaps here are the exact class of issues that cause production incidents: unhandled async throws that leave HTTP clients hanging, retry logic that retries permanent errors, and CORS that breaks on preflight — none of which a linter or type-checker will catch.
`─────────────────────────────────────────────────`

---

## `db.ts`

---

### 1 · Hardcoded credential defaults — `db.ts:8-9`
**Why it matters:** If `PGPASSWORD` / `PGUSER` are unset in production (e.g. a missing Secret), the server starts, connects successfully against the defaults, and silently talks to the wrong database. No startup crash, no alert — just subtle data corruption or access to test data.

```ts
// Before: silently falls back to dev credentials in prod
password: process.env.PGPASSWORD ?? "tokenlab",

// After: fail fast if the secret is absent
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
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

### 2 · No pool size or timeout limits — `db.ts:5-11`
**Why it matters:** `pg.Pool` defaults to `max: 10`, `connectionTimeoutMillis: 0` (infinite wait). Under a traffic spike, connection acquisition blocks forever, and you have no visibility into it. Under a DB hiccup, connections that become idle-but-stuck are never evicted.

```ts
export const pool = new Pool({
  ...
  max:                      20,
  idleTimeoutMillis:        30_000,
  connectionTimeoutMillis:  5_000,
});
```

---

### 3 · `withRetry` retries permanent errors and has no backoff — `db.ts:13-24`
**Why it matters:** A wrong password, a DNS failure, or a misconfigured host will retry 10 times at 1-second intervals and block startup for 10 seconds with no log output. Meanwhile a real transient `ECONNREFUSED` on a healthy container race should actually back off so it doesn't hammer the DB during its own startup.

```ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  tries = 10,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      // Don't retry auth or config errors — they won't self-heal.
      if (err?.code === "28P01" || err?.code === "3D000") throw err;

      lastErr = err;
      const delay = Math.min(1000 * 2 ** i, 10_000); // exponential backoff, cap 10s
      console.warn(`db: attempt ${i + 1}/${tries} failed (${err?.message}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
```

---

### 4 · No SSL for database connections — `db.ts:5-11`
**Why it matters:** Without `ssl`, credentials and query results travel in plaintext over the network, which matters as soon as the app and DB aren't on the same host or same VPC.

```ts
export const pool = new Pool({
  ...
  ssl: process.env.PGSSLMODE === "disable"
    ? false
    : { rejectUnauthorized: process.env.NODE_ENV === "production" },
});
```

---

### 5 · Pool is never closed on shutdown — `db.ts` / `index.ts`
**Why it matters:** When the process receives SIGTERM (K8s pod eviction, docker stop, etc.), Node will not exit cleanly while the pool holds open sockets. This causes a 30-second grace-period timeout on every deploy rollout.

```ts
// in index.ts, after app.listen()
const server = app.listen(port, () => { ... });

process.on("SIGTERM", () => {
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
});
```

---

## `index.ts`

---

### 6 · Async route handlers have no error handling — `index.ts:16-21`, `24-34`
**Why it matters:** In Express 4, an unhandled rejection inside an `async` route handler does NOT invoke the error middleware — the response just hangs and the client eventually times out. Any transient DB error (e.g. `connectionTimeoutMillis` from issue #2) will trigger this.

```ts
// Wrap every async handler:
app.get("/api/users", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Add a global JSON error handler at the bottom:
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});
```

---

### 7 · Startup DB probe rejection is unhandled — `index.ts:38-42`
**Why it matters:** If `withRetry` exhausts all attempts and rejects, there is no `.catch()`. In Node ≥15 this crashes the process without a useful message; in Node 14 it emits an `UnhandledPromiseRejectionWarning` and swallows the error. Either way the server never starts and the reason is unclear.

```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("Could not connect to database:", err);
    process.exit(1);
  });
```

---

### 8 · No CORS preflight (OPTIONS) handler — `index.ts:8-13`
**Why it matters:** The middleware correctly sets CORS headers, but Express has no registered handler for `OPTIONS`. Browsers send a preflight `OPTIONS` request before any non-simple request (e.g. `Content-Type: application/json` with PUT/DELETE). Express returns `404` on OPTIONS, the browser treats the preflight as failed, and the actual request is never sent.

```ts
// Replace manual headers with the `cors` package, or add an explicit handler:
app.options("*", (_req, res) => res.status(204).send());

// Or, in production, scope the allowed origin:
app.use(cors({
  origin: process.env.CORS_ORIGIN ?? "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
}));
```

---

### 9 · `:id` parameter is not validated before hitting the DB — `index.ts:27`
**Why it matters:** `req.params.id` is a string. If a caller sends `/api/users/abc`, PostgreSQL will throw `invalid input syntax for type integer` — which today propagates as an unhandled rejection (issue #6). Validating upfront returns a 400 instead, keeps DB errors out of this path, and avoids leaking postgres error messages to clients.

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

### 10 · `PORT` env var not validated — `index.ts:36`
**Why it matters:** `Number("not-a-port")` → `NaN`. `app.listen(NaN)` does not throw — it silently picks a random ephemeral port. The server starts and logs a port that it's not actually on.

```ts
const rawPort = process.env.PORT ?? "3001";
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: "${rawPort}"`);
}
```

---

### 11 · `GET /api/users` returns all rows without pagination — `index.ts:17-20`
**Why it matters:** A table with millions of rows will serialize the entire result into memory, block the event loop during JSON serialization, and OOM the process. The calling client has no way to paginate.

```ts
app.get("/api/users", async (_req, res, next) => {
  try {
    const limit  = Math.min(Number(_req.query.limit)  || 100, 1000);
    const offset = Math.max(Number(_req.query.offset) || 0,   0);
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id LIMIT $1 OFFSET $2",
      [limit, offset]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
```

---

### 12 · Wildcard CORS in non-workshop settings — `index.ts:9`
**Why it matters:** `Access-Control-Allow-Origin: *` lets any website on the internet make authenticated requests to this API from a visitor's browser. The comment says "during the workshop" but code has a habit of outliving its context.

```ts
// Make the origin configurable so a production deployment always
// restricts it without changing code:
const allowedOrigin = process.env.CORS_ORIGIN ?? "*";
res.header("Access-Control-Allow-Origin", allowedOrigin);
```

---

## Summary table

| # | File | Line(s) | Category | Severity |
|---|------|---------|----------|---------|
| 1 | `db.ts` | 8–9 | Security / operability | High |
| 2 | `db.ts` | 5–11 | Performance / operability | High |
| 3 | `db.ts` | 13–24 | Correctness / operability | High |
| 4 | `db.ts` | 5–11 | Security | Medium |
| 5 | `db.ts` / `index.ts` | — | Operability | Medium |
| 6 | `index.ts` | 16–34 | Correctness / error handling | High |
| 7 | `index.ts` | 38–42 | Correctness / error handling | High |
| 8 | `index.ts` | 8–13 | Correctness | High |
| 9 | `index.ts` | 27 | Input validation / correctness | Medium |
| 10 | `index.ts` | 36 | Correctness | Medium |
| 11 | `index.ts` | 17–20 | Performance | Medium |
| 12 | `index.ts` | 9 | Security | Low (env-gated) |

The two highest-priority items to fix first are **#6** (hanging responses on any DB error) and **#7** (silent startup failure) — they will cause the server to either never start or stop serving without any observable signal.

`★ Insight ─────────────────────────────────────`
Issues #6 and #7 share the same root cause: Express 4 does not automatically propagate async rejections to error middleware. Express 5 (released 2024) fixes this by wrapping async handlers automatically — upgrading would eliminate the need for most of the try/catch boilerplate, though the `withRetry` `.catch()` on startup (#7) would still be required since it's not inside a route handler.
`─────────────────────────────────────────────────`

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 5303,
  "cache_read_input_tokens": 55187,
  "cache_creation_input_tokens": 18122,
  "total_tokens": 78616,
  "cost_usd": 0.16407059999999998,
  "num_turns": 3
}
```
