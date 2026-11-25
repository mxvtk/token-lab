# headroom_long__off task 6 rep 2

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
- Express 4's async error handling is a well-known footgun: unlike Express 5, it doesn't catch rejected promises from route handlers — they silently become unhandled rejections that hang the client
- `pg.Pool` creates connections lazily but without bounds/timeouts configured, so a slow DB can stall the entire Node.js event loop thread on a single saturated connection
- Hardcoded credential defaults in source code get baked into Docker images and show up in `git log` forever — environment variable defaults should never be secrets
`─────────────────────────────────────────────────`

Here is every issue I found, grouped by category.

---

## Correctness / Crashes

### 1. `index.ts:38` — Unhandled rejection on startup failure

`withRetry(...).then(...)` has no `.catch()`. If the DB stays unreachable through all 10 retries the promise rejects with no handler. Node ≥ 15 terminates the process immediately with no log line; Node 14 silently swallows it and the server never starts.

```ts
// Fix
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("DB unreachable after all retries — exiting", err);
    process.exit(1);
  });
```

---

### 2. `index.ts:16–20` and `index.ts:24–34` — Async route handlers with no `try/catch`

Express 4 does **not** propagate rejected async handler promises to the error middleware. A thrown error (DB down, network hiccup) becomes an unhandled rejection; the response is never sent and the client times out.

```ts
// Fix both handlers
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

### 3. `index.ts:27` — URL param passed to integer column without validation

`req.params.id` is always a `string`. Postgres rejects non-numeric values with *"invalid input syntax for type integer"*, which then hits the missing try/catch above and hangs the client. Even numeric strings like `"3; DROP TABLE users"` are safe with parameterised queries, but `"abc"` is not.

```ts
app.get("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users WHERE id = $1",
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("GET /api/users/:id:", err);
    res.status(500).json({ error: "internal server error" });
  }
});
```

---

### 4. `index.ts:8–13` — OPTIONS preflight never answered

The CORS middleware sets headers and always calls `next()`. Express 4 has no built-in auto-reply to `OPTIONS`; if no route matches, it returns 404 with the CORS headers already set. Browsers require a 2xx status for preflight responses, so PUT/DELETE (and POST with `Content-Type: application/json` to a cross-origin server) are silently blocked.

```ts
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
// Or replace the whole block with: app.use(require('cors')())
```

---

### 5. `db.ts:14–23` — `withRetry` throws `undefined` when `tries ≤ 0`

`lastErr` is declared but never assigned when the loop body never runs. `throw lastErr` throws `undefined`. Any caller doing `catch (err) { err.message }` gets a `TypeError`.

```ts
export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  if (tries <= 0) throw new Error("withRetry: tries must be > 0");
  let lastErr: unknown = new Error("withRetry: no attempts made");
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); // exponential backoff (see #10)
    }
  }
  throw lastErr;
}
```

---

## Security

### 6. `db.ts:9` — Hardcoded default password committed to source

```ts
password: process.env.PGPASSWORD ?? "tokenlab",
```

`"tokenlab"` is now permanently in git history. Any image built from this repo carries the default; anyone who scans it gets the creds. The safe pattern is to require the env var in production and refuse to start without it.

```ts
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "tokenlab",
  password: requireEnv("PGPASSWORD"),   // fail loudly if unset
  database: process.env.PGDATABASE ?? "tokenlab",
});
```

---

### 7. `index.ts:9` — `Access-Control-Allow-Origin: *` with no authentication

A wildcard CORS policy means any website the user visits can silently call this API and read all user emails. This is fine for a workshop with no auth, but in production the allowed origin must be an explicit allowlist.

```ts
const ALLOWED_ORIGINS = new Set((process.env.CORS_ORIGINS ?? "").split(",").filter(Boolean));

app.use((req, res, next) => {
  const origin = req.headers.origin ?? "";
  if (ALLOWED_ORIGINS.has(origin)) res.header("Access-Control-Allow-Origin", origin);
  // ... rest of CORS headers
});
```

---

### 8. `db.ts:5–11` — No TLS on the database connection

Production Postgres should require SSL. `pg.Pool` defaults to no SSL.

```ts
export const pool = new Pool({
  ...
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: true },
});
```

---

## Input Validation

### 9. `index.ts:36` — `PORT` env var not validated

```ts
const port = Number(process.env.PORT ?? 3001);
```

If `PORT` is set to `"abc"` or `""`, `Number()` returns `NaN`. `app.listen(NaN)` picks an OS-assigned ephemeral port silently; the log line prints `:NaN`. Use:

```ts
const rawPort = process.env.PORT ?? "3001";
const port = parseInt(rawPort, 10);
if (!Number.isFinite(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: "${rawPort}"`);
}
```

---

## Performance

### 10. `db.ts:20` — Fixed 1 s retry delay, no jitter or exponential backoff

Under a container restart (many instances coming up simultaneously), all replicas hammer the DB in lockstep every second. Add exponential backoff with jitter.

```ts
const delay = Math.min(1000 * 2 ** i, 30_000);
const jitter = Math.random() * delay * 0.2;
await new Promise((r) => setTimeout(r, delay + jitter));
```

---

### 11. `db.ts:5–11` — Pool has no connection limits or timeouts configured

`pg.Pool` defaults to `max: 10` with no `connectionTimeoutMillis` or `idleTimeoutMillis`. Under a DB outage, all 10 connection slots can be held waiting indefinitely, blocking all subsequent queries. Set explicit bounds.

```ts
export const pool = new Pool({
  ...
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 10_000,
});
```

---

## Operability

### 12. `index.ts` — No health check endpoint

Kubernetes and load balancers need a `/healthz` (or `/health`) probe that checks both the app and the DB. Without it, a pod with a broken DB connection looks healthy.

```ts
app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});
```

---

### 13. `db.ts:16–21` — `withRetry` logs nothing during retries

A startup that takes 8 seconds of retries looks like a hang. Log each attempt.

```ts
} catch (err) {
  lastErr = err;
  console.warn(`withRetry attempt ${i + 1}/${tries} failed:`, err);
  await new Promise((r) => setTimeout(r, delay));
}
```

---

### 14. `index.ts:16–34` — Errors returned to clients reveal no correlation ID

When a 500 is returned there's no request ID in either the log or the response body. Correlating a user's bug report to a log line is guesswork. Add a request ID middleware (e.g. `express-request-id` or `crypto.randomUUID()` per request) and include it in both log output and the error response.

---

`★ Insight ─────────────────────────────────────`
- Items 2 (async handlers) and 4 (OPTIONS preflight) are the two most common Express 4 gotchas; Express 5 fixes both — async throws propagate automatically and OPTIONS returns 204 by default
- Items 6 (default password) + 8 (no TLS) + 7 (wildcard CORS) form a triad: individually each is "just a workshop setting", but all three together in a pushed Docker image is a full credential leak vector
- Item 11 (pool timeouts) is the difference between "DB hiccup → 5 s degradation" and "DB hiccup → all requests hang until dyno restart"
`─────────────────────────────────────────────────`

**Summary of priorities:** Fix items 1–5 (crash/correctness) before anything else — without them, the server can't survive a DB blip in production. Items 6–8 are security blockers for any production deployment. Items 9–14 are important for hardening but don't cause data loss.

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 5,
  "output_tokens": 5732,
  "cache_read_input_tokens": 94126,
  "cache_creation_input_tokens": 20756,
  "total_tokens": 120619,
  "cost_usd": 0.49874850000000004,
  "num_turns": 5
}
```
