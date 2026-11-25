# cli_long__off task 6 rep 2

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

Good — Express 4. That's important because async route errors are **not** automatically caught in Express 4 (Express 5 added that). Now I have everything I need.

---

`★ Insight ─────────────────────────────────────`
Express 4 requires explicit `try/catch` + `next(err)` in async handlers; unhandled rejections cause requests to hang forever (the response never sends), not crash — which is worse than a crash because it silently exhausts sockets. Express 5 fixed this, but `^4.19.2` is pinned here.
`─────────────────────────────────────────────────`

---

## API Code Review — `api/src/`

---

### 1. Unhandled async errors in both route handlers — `index.ts:16` and `index.ts:24` *(Critical)*

**Why it matters:** Express 4 does not catch rejections from async route handlers. If `pool.query` throws (DB down, type mismatch, constraint error), the promise rejects, Express silently ignores it, and the client hangs until the browser's timeout fires. No 500 is ever sent. This is the most dangerous bug in the file.

```typescript
// Fix: wrap every async handler
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

app.get("/api/users/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
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
  } catch (err) {
    next(err);
  }
});

// Add a JSON error handler at the bottom
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});
```

---

### 2. `/:id` parameter not validated before hitting the database — `index.ts:27` *(High)*

**Why it matters:** `req.params.id` is a raw string. If the `users.id` column is an integer and the caller sends `/api/users/abc`, PostgreSQL throws `invalid input syntax for type integer`. That error surfaces as case #1 above (hanging request), but even after you add error handling, it wastes a roundtrip to the DB and returns a confusing 500 instead of a 400. Parameterized queries protect against SQL injection, but not type errors.

```typescript
const id = Number(req.params.id);
if (!Number.isInteger(id) || id < 1) {
  res.status(400).json({ error: "id must be a positive integer" });
  return;
}
// then pass id (now a number) to the query
```

---

### 3. `withRetry` rejection on startup is unhandled — `index.ts:38` *(High)*

**Why it matters:** If the DB never comes up and all 10 retries fail, `withRetry` rejects. There is no `.catch()`, so Node.js emits an unhandled promise rejection. In Node 15+ the process exits with a non-zero code and no useful message. The operator sees `UnhandledPromiseRejection` in the logs and no indication of what failed.

```typescript
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, (err?: Error) => {
      if (err) { console.error("listen failed:", err); process.exit(1); }
      console.log(`api listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error("database never became ready:", err);
    process.exit(1);
  });
```

---

### 4. No `error` event handler on the Pool — `db.ts:5` *(High)*

**Why it matters:** `pg.Pool` emits `'error'` when an idle client hits a network error (e.g., the DB kills connections after idle timeout). Without a listener, Node.js treats this as an unhandled `EventEmitter` error and **crashes the process** with `Error: Unhandled 'error' event`. This is the one case where the server does crash — but unexpectedly and silently.

```typescript
export const pool = new Pool({ ... });

pool.on("error", (err) => {
  console.error("idle client error", err);
  // process.exit(1) is optional; pg will reconnect on the next query
});
```

---

### 5. `withRetry` retries all errors, not just transient ones — `db.ts:13` *(Medium)*

**Why it matters:** Any error — authentication failure, `relation "users" does not exist`, max connections exceeded — is retried 10 times over 10 seconds before giving up. A misconfigured password wastes 10 seconds and fills logs with noise. Only `ECONNREFUSED`/`ENOTFOUND`/`ETIMEDOUT` and pg error code `57P03` ("cannot connect now") should be retried.

```typescript
function isTransient(err: unknown): boolean {
  if (err instanceof Error) {
    if ("code" in err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"].includes(code ?? "")) return true;
      // pg "cannot connect now" (db starting up)
      if ((err as any).routine === "ProcessStartupPacket") return true;
    }
  }
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err)) throw err;   // fail fast on non-transient errors
      lastErr = err;
      console.warn(`db not ready, attempt ${i + 1}/${tries}`);
      await new Promise((r) => setTimeout(r, 1000 * Math.min(i + 1, 5)));
    }
  }
  throw lastErr;
}
```

---

### 6. `Number(process.env.PORT)` silently produces `NaN` — `index.ts:36` *(Medium)*

**Why it matters:** If `PORT=abc` is set by accident, `Number("abc")` is `NaN`. `app.listen(NaN)` in Node does not throw — it silently listens on port `0` (a random OS-assigned port), which looks like it's running but nothing can reach it. The log line reads `api listening on :NaN`.

```typescript
const rawPort = process.env.PORT;
const port = rawPort ? parseInt(rawPort, 10) : 3001;
if (isNaN(port) || port < 1 || port > 65535) {
  console.error(`invalid PORT "${rawPort}"`);
  process.exit(1);
}
```

---

### 7. Wildcard CORS in production-bound code — `index.ts:9` *(Medium)*

**Why it matters:** `Access-Control-Allow-Origin: *` lets any website on the internet make requests to this API. The comment says "during the workshop" but there is no guard preventing this from being deployed as-is. If the API ever adds cookies or auth headers, `credentials: 'include'` will silently fail because browsers block credentials with `*` origin — but unauthenticated reads will still work from any origin.

```typescript
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:5173").split(",");

app.use((req, res, next) => {
  const origin = req.headers.origin ?? "";
  if (ALLOWED_ORIGINS.includes(origin)) {
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

### 8. No OPTIONS preflight handler — `index.ts:8` *(Medium)*

**Why it matters:** Browsers send an `OPTIONS` preflight before `PUT`, `DELETE`, or any request with a non-simple header. The middleware sets CORS headers and calls `next()`, which falls through to Express's default 404 handler (or your routes, none of which accept OPTIONS). The preflight gets a 404, the browser blocks the actual request, and callers on `PUT`/`DELETE` see a CORS error with no obvious cause.

```typescript
// Inside the CORS middleware, before next():
if (req.method === "OPTIONS") {
  res.header("Access-Control-Max-Age", "86400");
  res.sendStatus(204);
  return;
}
next();
```

---

### 9. Hardcoded default credentials — `db.ts:8–9` *(Medium)*

**Why it matters:** The fallback values `"tokenlab"` / `"tokenlab"` are committed to source. If the production environment is misconfigured and the env vars are absent, the server silently connects with the workshop credentials. For production the right answer is to fail loudly if credentials are missing.

```typescript
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) { console.error(`missing required env var: ${name}`); process.exit(1); }
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

### 10. No connection timeout on the pool — `db.ts:5` *(Low)*

**Why it matters:** With the default pool config, if all 10 connections are busy, incoming queries queue indefinitely. Under load, the queue grows unbounded and requests stack up. `connectionTimeoutMillis` makes the caller fail fast with a clear error rather than waiting forever.

```typescript
export const pool = new Pool({
  ...
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,   // fail after 5s if no connection available
});
```

---

### 11. No catch-all 404 route — `index.ts` *(Low / Operability)*

**Why it matters:** Any request to an unmatched path (e.g., `/healthz`, `/api/users/1/posts`) returns Express's default HTML `Cannot GET /…` body with a 200 `Content-Type: text/html`. API consumers get an HTML payload they can't parse as JSON, and health-check endpoints that expect JSON will silently fail.

```typescript
// After all routes, before the error handler:
app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});
```

---

`★ Insight ─────────────────────────────────────`
Issues 1 and 4 are the most dangerous: hanging requests (no try/catch in Express 4 async handlers) and surprise process crashes (pool `'error'` event) can both take the service down silently with no actionable log line. They're also the two patterns that look fine in testing — they only surface under real network conditions.
`─────────────────────────────────────────────────`

---

**Summary table:**

| # | File | Line | Category | Severity |
|---|------|------|----------|----------|
| 1 | `index.ts` | 16, 24 | Error handling / correctness | Critical |
| 2 | `index.ts` | 27 | Input validation | High |
| 3 | `index.ts` | 38 | Error handling / operability | High |
| 4 | `db.ts` | 5 | Error handling / correctness | High |
| 5 | `db.ts` | 13 | Correctness / reliability | Medium |
| 6 | `index.ts` | 36 | Correctness | Medium |
| 7 | `index.ts` | 9 | Security | Medium |
| 8 | `index.ts` | 8 | Correctness / CORS | Medium |
| 9 | `db.ts` | 8–9 | Security | Medium |
| 10 | `db.ts` | 5 | Performance / reliability | Low |
| 11 | `index.ts` | EOF | Operability | Low |

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 5,
  "output_tokens": 6564,
  "cache_read_input_tokens": 87607,
  "cache_creation_input_tokens": 19346,
  "total_tokens": 113522,
  "cost_usd": 1.3995462,
  "num_turns": 5,
  "permission_denials": 0
}
```
