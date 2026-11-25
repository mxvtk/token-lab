# headroom_long__on task 6 rep 3

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
- Express 4 does **not** automatically forward rejected async route-handler promises to error middleware — unlike Express 5. Missing try/catch in an async handler means Node 15+ will crash the process on the first DB error.
- `pg.Pool` emits an `'error'` event for idle-client failures. If nothing listens, Node converts it to an uncaught exception. This is a separate failure path from query errors.
`─────────────────────────────────────────────────`

---

## Production review — `api/src/db.ts` and `api/src/index.ts`

---

### 1. Hardcoded fallback credentials — `db.ts:9`

```ts
password: process.env.PGPASSWORD ?? "tokenlab",
```

If `PGPASSWORD` is not set the app connects with the well-known default password. Any environment where the env var is accidentally missing silently uses a credential an attacker can guess or find in this repo. There is no warning, no crash — just a live DB connection with a leaked password.

**Fix:** throw at startup if the secret is absent:

```ts
const password = process.env.PGPASSWORD;
if (!password) throw new Error("PGPASSWORD env var is required");

export const pool = new Pool({ ..., password });
```

---

### 2. No SSL for database connections — `db.ts:5-11`

The pool omits `ssl`. Credentials and query results travel over plaintext TCP. Any cloud-hosted or managed-PostgreSQL service (RDS, Cloud SQL, Supabase) requires, or strongly recommends, TLS.

**Fix:**

```ts
export const pool = new Pool({
  ...
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: true },
});
```

---

### 3. Pool emits `'error'` but nobody listens — `db.ts:5-11`

A pg `Pool` can emit `error` on an idle client (dropped connection, timeout). Node converts an unhandled `EventEmitter` error into an uncaught exception — the process crashes with no context.

**Fix:** add one listener right after pool creation:

```ts
pool.on("error", (err) => {
  console.error("pg pool error", err);
});
```

---

### 4. `withRetry` retries permanent errors — `db.ts:13-24`

```ts
} catch (err) {
  lastErr = err;
  await new Promise((r) => setTimeout(r, 1000));
}
```

Every error is retried — including `password authentication failed`, `database "x" does not exist`, or bad host. Those will never succeed; retrying them 10 times just burns 10 seconds at startup and hides the real cause.

**Fix:** only retry connection-class errors:

```ts
const TRANSIENT = ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "57P03"];
catch (err) {
  const code = (err as any).code ?? "";
  if (!TRANSIENT.includes(code)) throw err;   // permanent – fail fast
  lastErr = err;
  await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); // exp back-off
}
```

---

### 5. Flat back-off, no jitter — `db.ts:20`

`setTimeout(r, 1000)` is a fixed 1 s delay every time. Under load with multiple replicas, every instance retries at the same instant — thundering-herd against the DB. Exponential back-off with jitter (shown above) spreads the load.

---

### 6. No connection pool limits or timeouts — `db.ts:5-11`

```ts
export const pool = new Pool({ host, port, user, password, database });
```

No `max`, `idleTimeoutMillis`, or `connectionTimeoutMillis`. The default pool ceiling is 10 and connections never time out. Under load a query can queue forever waiting for a free slot, with no timeout to surface the problem.

**Fix:**

```ts
export const pool = new Pool({
  ...,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
```

---

### 7. Async route handlers have no error handling — `index.ts:16-21` and `index.ts:24-34`

```ts
app.get("/api/users", async (_req, res) => {
  const { rows } = await pool.query(...)   // throws → unhandled rejection
  res.json(rows);
});
```

Express 4 does **not** catch rejections from async handlers. The first DB error leaves `res` dangling (client hangs forever) **and** throws an unhandled rejection — crashing the process in Node 15+.

**Fix:** wrap every handler, or use a wrapper once:

```ts
const asyncHandler =
  (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

app.get("/api/users", asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id, email, created_at FROM users ORDER BY id"
  );
  res.json(rows);
}));
```

Then add a central error handler after all routes:

```ts
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});
```

---

### 8. `req.params.id` not validated as an integer — `index.ts:27`

```ts
const { rows } = await pool.query(
  "SELECT ... WHERE id = $1",
  [req.params.id]           // string "abc" → Postgres type error
);
```

The parameterised query prevents SQL injection, but `pg` sends `req.params.id` as a text value and PostgreSQL will throw `invalid input syntax for type integer` when the path is `/api/users/abc`. Combined with issue #7, this crashes the process (or hangs the request).

**Fix:** parse and validate early:

```ts
const id = parseInt(req.params.id, 10);
if (Number.isNaN(id)) {
  res.status(400).json({ error: "id must be an integer" });
  return;
}
const { rows } = await pool.query(
  "SELECT id, email, created_at FROM users WHERE id = $1",
  [id]
);
```

---

### 9. Startup DB-check has no `.catch()` — `index.ts:38-42`

```ts
withRetry(() => pool.query("SELECT 1")).then(() => {
  app.listen(port, ...);
});
```

If `withRetry` exhausts all retries (line 23 of db.ts throws `lastErr`), the rejection is unhandled. Node logs a warning (or exits in 15+) but the process never called `app.listen` — leaving it in limbo with no log message indicating what went wrong.

**Fix:**

```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("DB unreachable, shutting down", err);
    process.exit(1);
  });
```

---

### 10. `Number(process.env.PORT)` accepts `NaN` — `index.ts:36`

```ts
const port = Number(process.env.PORT ?? 3001);
```

`PORT=abc` → `port === NaN`. `app.listen(NaN, ...)` will throw or silently bind to an unexpected port depending on the Node version.

**Fix:**

```ts
const portRaw = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}
const port = portRaw;
```

---

### 11. CORS wildcard exposes all user data to any origin — `index.ts:9`

```ts
res.header("Access-Control-Allow-Origin", "*");
```

Any website can call `/api/users` from a visitor's browser and read all user emails. For a workshop this is intentional, but for production it must be locked to known origins, and the `Vary: Origin` header must be set so caches don't serve one origin's response to another.

**Fix:**

```ts
const ALLOWED = new Set((process.env.CORS_ORIGINS ?? "").split(",").filter(Boolean));

app.use((req, res, next) => {
  const origin = req.headers.origin ?? "";
  if (ALLOWED.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});
```

---

### 12. `OPTIONS` preflight requests are not handled — `index.ts:8-13`

The middleware sets the CORS headers for all methods but never short-circuits `OPTIONS`. Browsers send a preflight `OPTIONS` before any non-simple request. Express has no `OPTIONS` route, so it falls through to a 404 or Express's default "Cannot OPTIONS /api/users" response — breaking cross-origin `PUT`/`DELETE` calls.

**Fix:** shown inline in the snippet above (`if (req.method === "OPTIONS")`).

---

### 13. No request body size limit — `index.ts:5`

```ts
app.use(express.json());
```

Without a `limit` option the default is 100 kB (Express 4). For user-creation endpoints that can be fine, but it is easy to miss as the app grows. Set an explicit limit to make the policy intentional and document it:

```ts
app.use(express.json({ limit: "16kb" }));
```

---

`★ Insight ─────────────────────────────────────`
- Issues #7 (no try/catch in async handlers) and #8 (no `.catch()` at startup) are the most likely to cause a production outage — either a DB blip crashes the process or it fails to start with no actionable log message.
- Issues #1 and #2 (hardcoded password, no SSL) are the security risks most likely to be caught in a secrets or compliance audit and block a production launch.
`─────────────────────────────────────────────────`

**Summary:** 13 issues across both files. The highest-priority fixes before production are: #7+#8 (crash on DB error), #1 (hardcoded credential), #2 (no SSL), #4 (retrying permanent errors), and #3 (unhandled pool error event). The remaining issues — CORS, validation, back-off, pool limits, and PORT parsing — are production quality-of-life and security hygiene that should follow immediately after.

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 5353,
  "cache_read_input_tokens": 55453,
  "cache_creation_input_tokens": 18841,
  "total_tokens": 79651,
  "cost_usd": 0.2099889,
  "num_turns": 3,
  "permission_denials": 0
}
```
