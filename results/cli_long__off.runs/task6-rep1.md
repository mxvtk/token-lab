# cli_long__off task 6 rep 1

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
- The codebase uses a workshop-era `SELECT 1` probe with `withRetry` to gate startup — a reasonable pattern, but it only tests connectivity, not pool health during the app's lifetime.
- Both files are intentionally minimal (workshop context), which is why some of these gaps are "acceptable for a demo" but would be blockers in production.
`─────────────────────────────────────────────────`

---

## Code Review — `api/src/index.ts` & `api/src/db.ts`

---

### 1. No error handling on database queries — crashes the process on any DB error

**`index.ts:17–20`, `index.ts:25–33`**

Every `await pool.query(...)` call is unguarded. An unhandled promise rejection in an Express async route handler will, depending on the Node version and the express version, either crash the process (Node ≤16) or silently hang the response (Express 4 without `express-async-errors`). Either outcome is production-breaking.

```ts
// Fix: wrap each handler, or add a global async error wrapper
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

// Add a centralized error handler at the bottom, before app.listen:
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});
```

---

### 2. No input validation on `:id` — SQL injection via type confusion

**`index.ts:25–34`**

`req.params.id` is a raw string. `pg` will pass it as a text bind parameter, so a classic string injection is blocked. However, passing `'abc'` or `'1; DROP TABLE users--'` to a column declared `integer` causes a PostgreSQL type error that propagates as an unhandled rejection (see issue #1 above). More subtly, nothing prevents a caller from sending an absurdly large string that wastes DB resources, or a path like `../secret`.

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

### 3. Wildcard CORS with no OPTIONS pre-flight handling

**`index.ts:8–13`**

`Access-Control-Allow-Origin: *` is intentionally broad for the workshop, but it's left as a plain middleware rather than a guarded condition. Two concrete problems in production:

- No `OPTIONS` pre-flight response — browsers will stall on complex requests (non-simple methods, custom headers) waiting for a 200 to their `OPTIONS` probe.
- No origin allowlist — any website can read your API responses, including authenticated future endpoints.

```ts
// At minimum, short-circuit OPTIONS:
app.options("*", (_req, res) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN ?? "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  res.sendStatus(204);
});

app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN ?? "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});
```

Production: replace manual middleware with the `cors` package, which handles pre-flight, vary headers, and origin whitelisting correctly.

---

### 4. Startup failure is silent — `withRetry` rejection is unhandled

**`index.ts:38–42`**

```ts
withRetry(() => pool.query("SELECT 1")).then(() => {
  app.listen(port, () => { ... });
});
```

If `withRetry` exhausts all 10 retries and throws, the rejection is unhandled — the process may print an `UnhandledPromiseRejection` warning but will not exit with a non-zero code on Node 14 (depends on `--unhandled-rejections` flag). On Node 15+ it crashes, but only with an obscure dump, not a clean "DB unavailable" message.

```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("Failed to connect to database after retries:", err);
    process.exit(1);
  });
```

---

### 5. Hardcoded credentials in source code

**`db.ts:8–9`**

```ts
user: process.env.PGUSER ?? "tokenlab",
password: process.env.PGPASSWORD ?? "tokenlab",
```

The fallback credentials ship in source control. If an operator forgets to set environment variables, the app silently starts with the default password. Any future security scanner, Dockerfile layer diff, or git history viewer exposes them.

```ts
// Remove the fallback literals; fail loudly at startup if missing:
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT ?? 5432),
  user: requireEnv("PGUSER"),
  password: requireEnv("PGPASSWORD"),
  database: requireEnv("PGDATABASE"),
});
```

---

### 6. `withRetry` retries on all errors, not just transient ones

**`db.ts:13–24`**

The retry loop catches every exception — including permanent failures like `FATAL: role "tokenlab" does not exist` or a syntax error in the probe query. This burns all 10 attempts + 10 seconds of delay before surfacing the real error, making startup debugging painful.

```ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  tries = 10,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      // Only retry connection-level errors, not auth/config errors
      const isTransient = !code || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "57P03";
      if (!isTransient) throw err;
      lastErr = err;
      console.warn(`DB connection attempt ${i + 1}/${tries} failed, retrying…`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}
```

---

### 7. No pool connection limit or idle timeout configured

**`db.ts:5–11`**

`pg.Pool` defaults to `max: 10` connections, `idleTimeoutMillis: 10000`, and `connectionTimeoutMillis: 0` (wait forever). In production:

- `connectionTimeoutMillis: 0` means a request will hang indefinitely if the pool is exhausted.
- No `idleTimeoutMillis` awareness — connections that stay open to a Postgres behind a firewall with idle-connection teardown will silently break.

```ts
export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT ?? 5432),
  user: requireEnv("PGUSER"),
  password: requireEnv("PGPASSWORD"),
  database: requireEnv("PGDATABASE"),
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000, // fail fast instead of hanging forever
});
```

---

### 8. No graceful shutdown — open connections on SIGTERM

**`index.ts:38–42`** (absence)

The process has no SIGTERM/SIGINT handler. When the container orchestrator kills the pod it sends SIGTERM; Node exits immediately, dropping in-flight requests and leaving DB connections unclosed. Postgres will eventually reclaim them, but in-flight transactions may be left open longer than necessary.

```ts
const server = app.listen(port, () => console.log(`api listening on :${port}`));

process.on("SIGTERM", async () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});
```

---

### 9. `GET /api/users` has no pagination — unbounded table scan

**`index.ts:16–21`**

`SELECT … FROM users ORDER BY id` with no `LIMIT` returns every row in the table. At scale this returns megabytes of JSON in a single response, saturates the DB, and can OOM the Node process.

```ts
app.get("/api/users", async (req, res, next) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  try {
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

`★ Insight ─────────────────────────────────────`
- Issues #1 and #4 interact: unhandled async rejections in Express 4 don't reach the error middleware automatically — you must `catch` and call `next(err)`, or install `express-async-errors` which monkey-patches this. Express 5 (currently RC) does this natively.
- Issue #6 is a common retry anti-pattern: distinguishing transient vs. permanent errors by PostgreSQL error code (the `code` field on `pg` errors maps to [SQLSTATE codes](https://www.postgresql.org/docs/current/errcodes-appendix.html)) makes retries safe and fast to debug.
`─────────────────────────────────────────────────`

---

**Summary table:**

| # | File | Line(s) | Severity | Category |
|---|------|---------|----------|----------|
| 1 | `index.ts` | 17, 25 | **High** | Error handling — crashes/hangs on DB errors |
| 2 | `index.ts` | 25–28 | **High** | Input validation / type safety on `:id` |
| 3 | `index.ts` | 8–13 | **Medium** | Security — wildcard CORS, no OPTIONS handler |
| 4 | `index.ts` | 38–42 | **Medium** | Operability — silent startup failure |
| 5 | `db.ts` | 8–9 | **Medium** | Security — hardcoded credentials in source |
| 6 | `db.ts` | 13–24 | **Medium** | Correctness — retries on permanent failures |
| 7 | `db.ts` | 5–11 | **Low** | Performance — no connection timeout or pool tuning |
| 8 | `index.ts` | (absent) | **Low** | Operability — no graceful shutdown |
| 9 | `index.ts` | 16–21 | **Low** | Performance — unbounded `SELECT *` users list |

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 3327,
  "cache_read_input_tokens": 51639,
  "cache_creation_input_tokens": 14173,
  "total_tokens": 69143,
  "cost_usd": 0.1504467,
  "num_turns": 3,
  "permission_denials": 0
}
```
