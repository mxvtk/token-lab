# headroom_long__off task 6 rep 1

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
Reading these files together before forming any opinion, because `index.ts` and `db.ts` have a tight coupling: the startup retry in `db.ts` feeds directly into the Express startup in `index.ts`, and any error boundary that's missing in one file amplifies a gap in the other.
`─────────────────────────────────────────────────`

---

## Production code review — `api/src/`

### 1. Async route handlers have no error handling — Express 4 won't catch them

**`index.ts:16-21`, `index.ts:24-34`**

Both handlers are `async` but have no `try/catch`. If `pool.query()` throws (DB timeout, connection lost, type mismatch on the `:id` parameter), Express 4 never receives the error, the response is never sent, and the client hangs until it times out. Node.js 15+ turns unhandled rejections into process exits, so a single bad query crashes the server.

```ts
// Fix: wrap every async handler
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

### 2. No input validation on `:id` — type mismatch crashes the handler

**`index.ts:25-34`**

`req.params.id` is a raw string from the URL. If a caller sends `/api/users/abc` or `/api/users/999999999999999999999`, PostgreSQL tries to cast the value to `integer`, fails, and throws — right into the unhandled async path above. Parameterized queries prevent SQL injection, but they don't prevent type errors.

```ts
app.get("/api/users/:id", async (req, res) => {
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
    console.error(`GET /api/users/${id}:`, err);
    res.status(500).json({ error: "internal server error" });
  }
});
```

---

### 3. CORS middleware doesn't handle the `OPTIONS` preflight

**`index.ts:8-13`**

The middleware sets response headers but doesn't respond to the `OPTIONS` method itself. Any browser making a `POST` or `PUT` with a `Content-Type: application/json` header will fire a preflight `OPTIONS` request first. The current code falls through to no matching route and hangs (or returns 404), so those calls fail in-browser even though the headers exist.

```ts
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
```

---

### 4. Wildcard `Access-Control-Allow-Origin` is unsafe outside dev

**`index.ts:9`**

`"*"` lets any website on the internet call this API from a user's browser and receive the response. The comment says "workshop", but if credentials or cookies are ever added, the browser won't send them with a wildcard origin anyway — meaning this will silently break auth and someone will work around it in an unsafe way. Lock it to known origins now.

```ts
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:5173";

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }
  // ... rest of CORS headers
  next();
});
```

---

### 5. Hardcoded fallback credentials in `db.ts`

**`db.ts:9`**

```ts
password: process.env.PGPASSWORD ?? "tokenlab",
```

If `PGPASSWORD` is unset in a production deployment (a common misconfiguration), the pool silently connects with a known public password. The correct behavior in production is to fail fast and loudly, not to fall back.

```ts
// In production, require the env var explicitly
const password = process.env.PGPASSWORD;
if (!password && process.env.NODE_ENV === "production") {
  throw new Error("PGPASSWORD must be set in production");
}

export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "tokenlab",
  password: password ?? "tokenlab",
  database: process.env.PGDATABASE ?? "tokenlab",
});
```

---

### 6. `withRetry` retries all errors, including non-transient ones

**`db.ts:13-24`**

The function retries every exception. If the DB is up but the password is wrong, or the database name doesn't exist, it will retry 10 times over 10 seconds before surfacing the real error. This delays startup and buries the root cause in noise.

```ts
function isTransient(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  // ECONNREFUSED, ENOTFOUND — DB not yet up
  // 57P01 — admin shutdown; 08xxx — connection class errors
  return !code || code.startsWith("08") || code === "ECONNREFUSED" || code === "ENOTFOUND";
}

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err)) throw err;   // fail fast on auth/config errors
      lastErr = err;
      const delay = Math.min(1000 * 2 ** i, 10_000); // exponential backoff
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
```

---

### 7. Startup failure has no `.catch()` — unhandled rejection on DB timeout

**`index.ts:38-42`**

```ts
withRetry(() => pool.query("SELECT 1")).then(() => {
  app.listen(port, () => { ... });
});
```

If `withRetry` exhausts all retries the returned promise rejects with no handler attached. Node.js treats this as an unhandled rejection and in modern versions exits. The process dies with no message explaining why.

```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("Failed to connect to database:", err);
    process.exit(1);
  });
```

---

### 8. No graceful shutdown — SIGTERM drops in-flight requests and leaks connections

**`index.ts:38-42`** (absence)

Kubernetes and Docker send `SIGTERM` before killing a container. Without a handler the process exits immediately: active requests get a connection reset, and the pg pool doesn't flush. Add:

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

### 9. No pool connection timeout — queries can hang forever under DB pressure

**`db.ts:5-11`**

`pg.Pool` defaults `connectionTimeoutMillis` to `0`, meaning a connection attempt will wait indefinitely when the pool is exhausted. Under load, all Node.js worker threads block on the connection queue and the server becomes unresponsive.

```ts
export const pool = new Pool({
  ...
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000,  // fail after 3s, return 503 to caller
});
```

---

### 10. No health check endpoint

**`index.ts`** (absence)

Load balancers, Kubernetes liveness/readiness probes, and uptime monitors all need an endpoint to probe. Without one, a pod can be marked healthy immediately after startup before the DB connection is established.

```ts
app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "db unavailable" });
  }
});
```

---

### 11. No request/error logging — zero observability in production

**`index.ts`** (absence)

The only `console.log` is the startup banner. When something goes wrong in production there is no request log to correlate timing, and errors are silently swallowed (as noted in issue 1). At minimum, add error logging in the catch blocks and a lightweight request log:

```ts
// A middleware that logs method, path, status, and latency
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});
```

---

`★ Insight ─────────────────────────────────────`
- Express 4's async gap (issue 1) is the most common source of "my API just stops responding" bugs — Express 5 (now stable) wraps async handlers natively and would eliminate it entirely.
- Issues 1, 3, and 7 form a chain: async errors that aren't caught → no response sent → client and server both hang silently. They look like three separate bugs but share a single root cause: no error boundary at the Express layer.
- The retry logic in `db.ts` is used only during startup today, but it's exported as a general utility. If it's ever used for query retries later, the "retry everything" behavior (issue 6) will cause silent thundering-herd on the DB on any application-level error.
`─────────────────────────────────────────────────`

---

**Summary of findings by severity:**

| # | Severity | File | Issue |
|---|----------|------|-------|
| 1 | **Critical** | `index.ts:17,25` | Async handlers unguarded — hangs/crashes on DB error |
| 2 | **High** | `index.ts:27` | No `:id` validation — type error crashes unguarded handler |
| 3 | **High** | `index.ts:8-13` | OPTIONS preflight not handled — POST/PUT fail in-browser |
| 6 | **High** | `db.ts:18` | Retries non-transient errors, masks root cause |
| 7 | **High** | `index.ts:38` | No `.catch()` on startup — silent unhandled rejection |
| 4 | **Medium** | `index.ts:9` | Wildcard CORS — any origin can read API responses |
| 5 | **Medium** | `db.ts:9` | Hardcoded fallback credentials silently used in production |
| 8 | **Medium** | `index.ts` | No SIGTERM handler — requests dropped, connections leaked |
| 9 | **Medium** | `db.ts:5` | No connection timeout — server hangs under pool exhaustion |
| 10 | Low | `index.ts` | No `/healthz` endpoint |
| 11 | Low | `index.ts` | No request or error logging |

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 5598,
  "cache_read_input_tokens": 55189,
  "cache_creation_input_tokens": 18234,
  "total_tokens": 79025,
  "cost_usd": 0.1689162,
  "num_turns": 3
}
```
