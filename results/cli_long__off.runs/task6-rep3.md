# cli_long__off task 6 rep 3

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
This codebase is a workshop skeleton, not a hardened service. The patterns to watch for are: (1) async errors escaping Express without a catch (Express 4 does **not** automatically catch promise rejections from route handlers), (2) pg's `Pool` emitting `'error'` on idle clients — if unlistened, Node.js turns it into an uncaught exception and crashes the process, and (3) credential fallbacks baked into source code surviving into production when env vars aren't set.
`─────────────────────────────────────────────────`

---

## `db.ts`

---

### 1. Pool's `error` event is unhandled — crash vector `db.ts:5`

```ts
export const pool = new Pool({ ... });
```

pg's `Pool` can emit `'error'` on an idle client (e.g., the DB closes the connection while it's sitting in the pool). Node.js treats an unlistened `'error'` event as an uncaught exception and **crashes the process**. This is documented in the `node-postgres` docs as the single most common crash in production.

**Fix:**
```ts
pool.on("error", (err) => {
  console.error("idle client error", err);
});
```

---

### 2. Hardcoded fallback credentials `db.ts:9`

```ts
password: process.env.PGPASSWORD ?? "tokenlab",
```

If `PGPASSWORD` is absent in a production deploy (misconfigured secret, missing env block), the service silently connects — or attempts to — with `"tokenlab"`. Hardcoded credential fallbacks are a security defect and a misconfiguration magnet.

**Fix:** Fail loudly if the variable is missing in non-development environments:
```ts
function requireEnv(name: string, devDefault?: string): string {
  const val = process.env[name];
  if (val) return val;
  if (process.env.NODE_ENV !== "production" && devDefault !== undefined) return devDefault;
  throw new Error(`Missing required environment variable: ${name}`);
}

export const pool = new Pool({
  host:     requireEnv("PGHOST", "db"),
  port:     Number(requireEnv("PGPORT", "5432")),
  user:     requireEnv("PGUSER", "tokenlab"),
  password: requireEnv("PGPASSWORD", "tokenlab"),
  database: requireEnv("PGDATABASE", "tokenlab"),
});
```

---

### 3. `withRetry` retries on every error — including permanent ones `db.ts:13–24`

```ts
} catch (err) {
  lastErr = err;
  await new Promise((r) => setTimeout(r, 1000));
}
```

A bad password, a missing database, or a network that will never come up retries 10 times over 10 seconds with no distinction. A startup with the wrong `PGPASSWORD` will log nothing and throw after 10 seconds — or worse, never give a clear error.

Also: the fixed 1-second linear delay with no jitter means multiple service replicas starting simultaneously all pound the DB at the same instant — thundering herd.

**Fix:**
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
      lastErr = err;
      // Don't retry authentication/config errors — they won't self-heal.
      const code = (err as { code?: string }).code;
      if (code === "28P01" || code === "3D000") throw err; // bad creds / unknown DB
      const delay = Math.min(1000 * 2 ** i, 10_000) + Math.random() * 500;
      console.warn(`withRetry attempt ${i + 1}/${tries} failed (${code}), retrying in ${Math.round(delay)}ms`, err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
```

---

### 4. No pool connection limits or timeouts configured `db.ts:5–11`

pg defaults to `max: 10` connections with no `connectionTimeoutMillis` or `idleTimeoutMillis`. Under load, callers that can't get a connection will queue indefinitely, and idle connections are held open forever.

**Fix:**
```ts
export const pool = new Pool({
  ...
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  allowExitOnIdle: true,          // let the process exit cleanly in tests
});
```

---

## `index.ts`

---

### 5. Async route handlers have no error handling — unhandled rejections `index.ts:16, 24`

```ts
app.get("/api/users", async (_req, res) => {
  const { rows } = await pool.query(...)   // throws → unhandled rejection in Express 4
  res.json(rows);
});
```

Express 4 does **not** catch promise rejections from route handlers. A DB error here produces an unhandled rejection, hangs the request (no response), and in Node.js ≥ 15 crashes the process. (Express 5 fixes this, but the project uses Express 4.)

**Fix — wrap every async handler:**
```ts
app.get("/api/users", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id"
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/users", err);
    res.status(500).json({ error: "internal server error" });
  }
});
```

Apply the same pattern to `/api/users/:id`. Or install a central wrapper:
```ts
const asyncHandler =
  (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

app.get("/api/users", asyncHandler(async (_req, res) => { ... }));
```

---

### 6. No input validation on `:id` — PostgreSQL type error becomes 500 `index.ts:26`

```ts
const { rows } = await pool.query(
  "SELECT id, email, created_at FROM users WHERE id = $1",
  [req.params.id]  // "abc", "1; DROP", negative numbers all reach Postgres
);
```

`id` is almost certainly `SERIAL`/`INT`. Passing `"abc"` causes pg to throw `invalid input syntax for type integer`, which — given issue #5 — crashes the process or hangs the request. This also leaks DB error messages to the client if error handling is ever added naively.

**Fix:**
```ts
const id = parseInt(req.params.id, 10);
if (!Number.isFinite(id) || id <= 0) {
  res.status(400).json({ error: "id must be a positive integer" });
  return;
}
const { rows } = await pool.query(
  "SELECT id, email, created_at FROM users WHERE id = $1",
  [id]
);
```

---

### 7. No CORS preflight (OPTIONS) response `index.ts:8–13`

```ts
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  next();
});
```

The middleware sets CORS headers but never short-circuits `OPTIONS` preflight requests. They fall through to route handlers, which return 404, causing browsers to block all cross-origin requests with a custom `Content-Type`.

**Fix:**
```ts
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  if (_req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});
```

---

### 8. `withRetry` startup failure is a silent unhandled rejection `index.ts:38`

```ts
withRetry(() => pool.query("SELECT 1")).then(() => {
  app.listen(port, () => { ... });
});
```

If `withRetry` exhausts all retries, the returned promise rejects. There is no `.catch()`. The server silently never starts, and Node.js logs an `UnhandledPromiseRejection` (and exits in Node ≥ 15).

**Fix:**
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

### 9. No request body size limit `index.ts:5`

```ts
app.use(express.json());
```

No `limit` option. The default in Express is 100 kb, but that is easy to miss and can be tuned down. More importantly, there is no equivalent guard on future file-upload routes. Worth being explicit now.

**Fix:**
```ts
app.use(express.json({ limit: "64kb" }));
```

---

### 10. No graceful shutdown `index.ts:36–42`

There is no `SIGTERM`/`SIGINT` handler. In Docker/Kubernetes, the orchestrator sends `SIGTERM` before `SIGKILL`. Without a handler, in-flight requests are dropped, DB connections are not released cleanly, and PostgreSQL accumulates stale connections.

**Fix:**
```ts
const server = app.listen(port, () =>
  console.log(`api listening on :${port}`)
);

process.on("SIGTERM", () => {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
});
```

---

### 11. No pagination on the users list `index.ts:17–19`

```ts
"SELECT id, email, created_at FROM users ORDER BY id"
```

No `LIMIT`/`OFFSET` or cursor-based pagination. At scale this reads an unbounded number of rows into memory and serializes them all into one JSON response, which will OOM or time out.

**Fix** (keyset pagination is better, but cursor pagination is the minimum):
```ts
app.get("/api/users", asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const after = Number(req.query.after) || 0;
  const { rows } = await pool.query(
    "SELECT id, email, created_at FROM users WHERE id > $1 ORDER BY id LIMIT $2",
    [after, limit]
  );
  res.json({ rows, next: rows.length === limit ? rows[rows.length - 1].id : null });
}));
```

---

`★ Insight ─────────────────────────────────────`
Issues #5 (unhandled async errors) and #1 (unlistened pool error event) interact: either one, in isolation, is enough to crash the process under a transient DB blip. Together they create a situation where normal operational noise — a DB restart, a momentary network hiccup — takes down the API entirely. In Express 4 codebases these two are the most common production outage source after launch.
`─────────────────────────────────────────────────`

---

## Priority summary

| # | File | Severity | Topic |
|---|------|----------|-------|
| 1 | db.ts:5 | **Critical** | Pool `error` event unhandled → process crash |
| 5 | index.ts:16,24 | **Critical** | Async handlers uncaught → hung request / crash |
| 8 | index.ts:38 | **Critical** | Startup rejection unhandled → silent no-start |
| 2 | db.ts:9 | **High** | Hardcoded fallback credentials |
| 3 | db.ts:13 | **High** | Retries on permanent errors; no backoff jitter |
| 6 | index.ts:26 | **High** | No `:id` validation → DB type error / 500 |
| 10 | index.ts:36 | **High** | No graceful shutdown → dropped connections |
| 7 | index.ts:8 | **Medium** | No OPTIONS preflight → browser blocks CORS |
| 9 | index.ts:5 | **Medium** | No request body size limit |
| 4 | db.ts:5 | **Medium** | No explicit pool timeouts |
| 11 | index.ts:17 | **Medium** | No pagination → unbounded query |

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 4599,
  "cache_read_input_tokens": 51647,
  "cache_creation_input_tokens": 14192,
  "total_tokens": 70442,
  "cost_usd": 0.1696431,
  "num_turns": 3,
  "permission_denials": 0
}
```
