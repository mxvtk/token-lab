# headroom_long__off task 6 rep 1

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
- The codebase uses a **parameterized query** at line 26 of `index.ts` (`$1` placeholder), which correctly prevents SQL injection — but this benefit is silently undermined if the parameter type isn't validated first.
- Express async route handlers silently swallow thrown errors unless you wrap them with a try/catch or a middleware. In Node 18+ unhandled promise rejections terminate the process, so a single bad DB query will crash the server.
`─────────────────────────────────────────────────`

---

## Production code review — `api/src/`

### 1. **[Correctness / Crash] Unhandled async errors in every route** — `index.ts:16-34`

Every `async` route handler is missing try/catch. If `pool.query` throws (network blip, constraint violation, malformed packet), Express never catches it. In Node 18+ this is an unhandled rejection that **terminates the process**.

```ts
// pattern to apply to every route
app.get("/api/users", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal server error" });
  }
});
```

Or install a central async wrapper once:

```ts
const asyncRoute =
  (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});
```

---

### 2. **[Input Validation / Correctness] `id` parameter is not validated before hitting the DB** — `index.ts:27`

`req.params.id` is an arbitrary string from the URL. Passing `"abc"` sends a non-integer to a Postgres integer column. Postgres returns an error; without try/catch that crashes the process (issue #1). Even with try/catch, you leak a 500 instead of a proper 400. Passing `"1; DROP TABLE users"` can't execute because it's parameterised, but Postgres will still error on the type mismatch.

```ts
app.get("/api/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  // ...
});
```

---

### 3. **[Security] CORS wildcard with no preflight handling** — `index.ts:8-13`

`Access-Control-Allow-Origin: *` is dangerous for any endpoint that uses cookies or auth headers. The comment says "for the workshop Vite dev server" — but if this code ships to production that origin broadens to the entire internet. Browsers won't send cookies with `*`, but custom clients will.

Additionally, there is no OPTIONS preflight handler. `Access-Control-Allow-Methods: DELETE` is declared but no matching OPTIONS route exists, so browsers will block preflighted DELETE requests.

```ts
const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",");

app.use((req, res, next) => {
  const origin = req.headers.origin ?? "";
  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});
```

---

### 4. **[Operability / Crash] `withRetry` failure silently hangs startup** — `index.ts:38-42`

`withRetry(...).then(...)` has no `.catch`. If the DB is unreachable after all 10 retries, the promise rejects and the process either hangs or terminates with an unhandled rejection, with no log explaining why the server never started.

```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("DB unavailable after retries, exiting:", err);
    process.exit(1);
  });
```

---

### 5. **[Security] Hardcoded default credentials** — `db.ts:8-10`

```
user: process.env.PGUSER ?? "tokenlab",
password: process.env.PGPASSWORD ?? "tokenlab",
database: process.env.PGDATABASE ?? "tokenlab",
```

Hardcoded defaults mean the application silently connects with known credentials if the env vars are absent — in staging, CI, or if a `.env` file is accidentally missing in production. The safe pattern is to require them explicitly:

```ts
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const pool = new Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5432),
  user: requireEnv("PGUSER"),
  password: requireEnv("PGPASSWORD"),
  database: requireEnv("PGDATABASE"),
});
```

---

### 6. **[Operability] `withRetry` retries every error unconditionally** — `db.ts:13-24`

The retry loop does not inspect the error type. It will retry on permanent errors (wrong password, database does not exist, SSL mismatch) just as it retries transient ones. This wastes 10 seconds at startup before surfacing the real error.

```ts
import { DatabaseError } from "pg";

const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "57P03" /* cannot_connect_now */]);

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = err instanceof DatabaseError ? err.code : (err as NodeJS.ErrnoException).code;
      if (!TRANSIENT_CODES.has(code ?? "")) throw err; // fail fast on permanent errors
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); // exponential backoff
    }
  }
  throw lastErr;
}
```

---

### 7. **[Performance] No connection pool size configuration** — `db.ts:5-11`

`pg.Pool` defaults to 10 connections. For a production service this should be explicit and tunable via env:

```ts
export const pool = new Pool({
  // ...
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_TIMEOUT ?? 30_000),
  connectionTimeoutMillis: Number(process.env.PGPOOL_CONN_TIMEOUT ?? 5_000),
});
```

Without `connectionTimeoutMillis`, requests that arrive when all connections are busy will queue indefinitely rather than returning a 503.

---

### 8. **[Operability] No graceful shutdown** — `index.ts:38-42`

There is no `SIGTERM` handler. When Docker/Kubernetes sends SIGTERM (e.g. during a rolling deploy), the process exits immediately while in-flight requests are still being served. The pool also leaks open connections.

```ts
const server = app.listen(port, () => console.log(`api listening on :${port}`));

process.on("SIGTERM", () => {
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
});
```

---

### 9. **[Performance] `GET /api/users` has no pagination** — `index.ts:16-21`

`SELECT … ORDER BY id` with no LIMIT will return every row in the users table into memory and then serialize the entire result set into one JSON response. With enough rows this exhausts memory and saturates the network.

```ts
app.get("/api/users", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const offset = Number(req.query.offset ?? 0);
  const { rows } = await pool.query(
    "SELECT id, email, created_at FROM users ORDER BY id LIMIT $1 OFFSET $2",
    [limit, offset]
  );
  res.json(rows);
});
```

---

### 10. **[Operability] No request logging or correlation IDs** — `index.ts`

There is no structured request log, so in production you cannot trace a failed request back to a specific user, timestamp, or duration. Minimal addition:

```ts
app.use((req, _res, next) => {
  console.log(JSON.stringify({ method: req.method, path: req.path, ts: new Date().toISOString() }));
  next();
});
```

A proper setup would use `pino` + `express-pino-logger` and inject a request ID.

---

`★ Insight ─────────────────────────────────────`
- Issues 1, 4, and the missing SIGTERM handler all share the same root cause: **no lifecycle management**. Production-grade Express apps treat the server, database pool, and process signals as a unified lifecycle — start together, shut down together.
- The `withRetry` function (issue 6) shows a classic pitfall of copy-paste retry logic: it retries the action but forgets to classify errors. In distributed systems, **fail fast on permanent errors, retry only on transient ones** is the invariant.
- The hardcoded credentials (issue 5) are especially insidious in containerized setups where `docker compose up` without a `.env` will silently succeed with the defaults, making it easy to accidentally deploy to prod with the wrong config.
`─────────────────────────────────────────────────`

---

**Summary of findings by severity**

| # | Severity | File | Issue |
|---|----------|------|-------|
| 1 | **Critical** | `index.ts:16,24` | Unhandled async rejections crash the process |
| 4 | **Critical** | `index.ts:38` | Startup retry failure is unhandled, server silently never starts |
| 2 | **High** | `index.ts:27` | No type-validation on `:id` — 500 on bad input |
| 3 | **High** | `index.ts:8-13` | Wildcard CORS + no OPTIONS handler |
| 5 | **High** | `db.ts:8-10` | Hardcoded fallback credentials |
| 6 | **Medium** | `db.ts:15-23` | Retry on permanent errors; no backoff |
| 8 | **Medium** | `index.ts:38` | No SIGTERM handler — requests drop on deploys |
| 7 | **Low** | `db.ts:5-11` | Pool size/timeout not configurable |
| 9 | **Low** | `index.ts:16` | No pagination on the users list |
| 10 | **Low** | `index.ts` | No structured request logging |

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 3210,
  "cache_read_input_tokens": 55103,
  "cache_creation_input_tokens": 17952,
  "total_tokens": 76269,
  "cost_usd": 0.17240489999999997,
  "num_turns": 3,
  "permission_denials": 0
}
```
