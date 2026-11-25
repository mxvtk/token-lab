# cli_long__on task 6 rep 2

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
- Express async route handlers don't catch thrown errors by default — an unhandled rejection crashes the process or hangs the client. Express 5 adds this, but Express 4 (still the default install) does not.
- PostgreSQL's `Pool` will accept `NaN` as a port number silently if the env var is set to a non-numeric string, because `Number("bad")` is `NaN`.
`─────────────────────────────────────────────────`

---

## Code Review — `api/src/`

---

### 1. Unhandled async rejections on every route — `index.ts:17`, `index.ts:25`

**Why it matters:** Express 4 does not catch errors thrown from `async` route handlers. Any DB error (network blip, bad query, pool exhaustion) causes an unhandled rejection, which either silently hangs the in-flight request or, in Node 15+, crashes the process.

```ts
// Minimal wrapper — add once at the top of index.ts
function wrap(fn: (req: express.Request, res: express.Response) => Promise<void>) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    fn(req, res).catch(next);
  };
}

// Then register routes as:
app.get("/api/users", wrap(async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id, email, created_at FROM users ORDER BY id"
  );
  res.json(rows);
}));

// And add an error handler at the bottom:
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});
```

---

### 2. No input validation on `:id` — `index.ts:28`

**Why it matters:** `req.params.id` is passed directly as the `$1` bind parameter. While parameterised queries prevent SQL injection, an arbitrary string (e.g. `"../../etc"`, `"0; DROP..."`, or a 10 MB string) still hits the DB and wastes a round-trip. Integer IDs should be validated before the query.

```ts
app.get("/api/users/:id", wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  const { rows } = await pool.query(
    "SELECT id, email, created_at FROM users WHERE id = $1",
    [id]
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(rows[0]);
}));
```

---

### 3. Startup failure is silent — `index.ts:38`

**Why it matters:** `withRetry(...).then(...)` has no `.catch()`. If all 10 retries are exhausted (DB never comes up), the rejection is unhandled and the process may exit without any log message, leaving operators with no signal.

```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("DB did not become ready:", err);
    process.exit(1);
  });
```

---

### 4. Wildcard CORS in production — `index.ts:9`

**Why it matters:** `Access-Control-Allow-Origin: *` allows any origin to call the API. The comment acknowledges it is for the workshop Vite dev server — but if this ever reaches a real deployment it leaks the API to the open web. At minimum, guard it with an env toggle so it's impossible to accidentally ship.

```ts
const allowedOrigin = process.env.CORS_ORIGIN ?? (
  process.env.NODE_ENV === "production" ? undefined : "*"
);

app.use((_req, res, next) => {
  if (allowedOrigin) {
    res.header("Access-Control-Allow-Origin", allowedOrigin);
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  }
  next();
});
```

---

### 5. `OPTIONS` preflight requests are not handled — `index.ts:8–13`

**Why it matters:** Browsers send a preflight `OPTIONS` request before cross-origin `POST`/`PUT`/`DELETE`. The current middleware sets the headers but no route handles `OPTIONS`, so Express falls through to a 404. Cross-origin mutations will never work from a browser.

```ts
app.options("*", (_req, res) => {
  res.sendStatus(204);
});
// (place after the CORS middleware, before the routes)
```

---

### 6. Hardcoded credential defaults — `db.ts:8–9`

**Why it matters:** `password: process.env.PGPASSWORD ?? "tokenlab"` means a misconfigured environment silently connects with a known default password. In a production context this is a credential exposure. The password in particular should be required, not defaulted.

```ts
const password = process.env.PGPASSWORD;
if (!password) throw new Error("PGPASSWORD env var is required");

export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "tokenlab",
  password,
  database: process.env.PGDATABASE ?? "tokenlab",
});
```

---

### 7. `NaN` port accepted silently — `db.ts:7`, `index.ts:36`

**Why it matters:** `Number("bad")` is `NaN`. If `PGPORT` or `PORT` is set to a non-numeric string, `new Pool({ port: NaN })` and `app.listen(NaN)` both behave unpredictably (Node maps `NaN` to `0` for `listen`, picking a random port; `pg` may throw a confusing error).

```ts
// db.ts
const pgPort = Number(process.env.PGPORT ?? 5432);
if (!Number.isInteger(pgPort)) throw new Error(`Invalid PGPORT: ${process.env.PGPORT}`);

// index.ts
const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port)) throw new Error(`Invalid PORT: ${process.env.PORT}`);
```

---

### 8. `withRetry` retries on every error class — `db.ts:13–24`

**Why it matters:** The retry loop catches all errors, including permanent ones (bad credentials, database does not exist, TLS mismatch). Retrying 10 times over 10 seconds on an auth error wastes time and creates confusing logs. Only transient connection errors (`ECONNREFUSED`, `ETIMEDOUT`, Postgres code `57P03`) should be retried.

```ts
const RETRYABLE = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"]);

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      const isRetryable =
        RETRYABLE.has(err?.code) ||
        err?.code === "57P03"; // DB starting up
      if (!isRetryable) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}
```

---

### 9. Pool is never shut down cleanly — `db.ts` / `index.ts`

**Why it matters:** No `SIGTERM`/`SIGINT` handler closes the pool. Under a graceful container shutdown the process exits with open DB connections, which causes `pg` to log connection errors server-side and can delay Postgres connection slot recovery.

```ts
// index.ts — after app.listen
const server = app.listen(port, () => console.log(`api listening on :${port}`));

process.on("SIGTERM", () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});
```

---

`★ Insight ─────────────────────────────────────`
- Issues 1 and 3 (async errors swallowed by Express 4 and unguarded `.then`) are the most likely to cause silent production outages — they're invisible in development where the DB is always up.
- Issue 8 is a subtle operability trap: distinguishing retryable from permanent errors is essential for fast feedback during misconfiguration, and it's commonly overlooked in startup retry loops.
`─────────────────────────────────────────────────`

---

**Summary table**

| # | File | Line | Severity | Category |
|---|------|------|----------|----------|
| 1 | index.ts | 17, 25 | **High** | Error handling |
| 2 | index.ts | 28 | Medium | Input validation |
| 3 | index.ts | 38 | **High** | Error handling / operability |
| 4 | index.ts | 9 | Medium | Security |
| 5 | index.ts | 8 | Medium | Correctness |
| 6 | db.ts | 9 | Medium | Security |
| 7 | db.ts:7, index.ts:36 | Low | Correctness |
| 8 | db.ts | 18 | Medium | Operability |
| 9 | db.ts / index.ts | — | Low | Operability |

The two highest-priority fixes before production: **async error handling on routes (#1)** and **startup failure propagation (#3)** — both are invisible during development and guaranteed to bite under any real failure condition.

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 2769,
  "cache_read_input_tokens": 51327,
  "cache_creation_input_tokens": 13851,
  "total_tokens": 67951,
  "cost_usd": 0.14005109999999998,
  "num_turns": 3,
  "permission_denials": 0
}
```
