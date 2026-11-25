# caveman_long__off task 6 rep 3

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix" # live_only: opens a real PR — never part of the batch A/B; run by hand with --task 5.

## Agent result

`★ Insight ─────────────────────────────────────`
Express 4 and Express 5 have fundamentally different async error semantics. In Express 4, an `async` route handler that rejects is an **unhandled promise rejection** — not caught by Express's error handler. Express 5 changed this. Because this codebase pins `^4.19.2`, every async route that lacks try/catch is a latent crash waiting for the first DB hiccup.
`─────────────────────────────────────────────────`

---

## Code Review — `api/src/`

### 1. `index.ts:16–21`, `24–34` — Async route handlers without error handling (Express 4 — **crash on any DB error**)

Express 4 does **not** wrap async route handlers. If `pool.query()` rejects (DB timeout, connection dropped, bad input), the rejection propagates as an unhandled rejection, potentially crashing the process or silently hanging the client request with no response.

```typescript
// BROKEN — Express 4 does not catch this rejection
app.get("/api/users", async (_req, res) => {
  const { rows } = await pool.query(...)  // throws → unhandled rejection
  res.json(rows);
});
```

**Fix** — wrap every async handler:

```typescript
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

### 2. `index.ts:24–34` — `req.params.id` not validated as integer (**crash**)

`id` is a `SERIAL` (integer) column. Passing `"abc"` as `$1` causes pg to throw `invalid input syntax for type integer: "abc"`. Combined with issue #1, this crashes the process on any malformed URL.

```typescript
// GET /api/users/abc → pg throws → unhandled rejection on Express 4
const { rows } = await pool.query(
  "SELECT ... WHERE id = $1",
  [req.params.id]   // string "abc" passed to integer column
);
```

**Fix:**

```typescript
app.get("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users WHERE id = $1",
      [id]
    );
    if (rows.length === 0) return void res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("GET /api/users/:id:", err);
    res.status(500).json({ error: "internal server error" });
  }
});
```

---

### 3. `db.ts:9` — Hardcoded password as fallback (**security**)

```typescript
password: process.env.PGPASSWORD ?? "tokenlab",
```

If `PGPASSWORD` is absent in a production deployment (misconfigured secret, typo in env var name), the app silently connects with the well-known default password. Any attacker who reads the source has valid credentials. Credentials must never have hardcoded fallbacks.

**Fix** — fail fast at startup if required secrets are missing:

```typescript
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "tokenlab",
  password: requireEnv("PGPASSWORD"),
  database: process.env.PGDATABASE ?? "tokenlab",
});
```

---

### 4. `db.ts` — No pool `'error'` event handler (**crash**)

pg's `Pool` emits `'error'` on idle client errors (network reset, DB restart). Node's `EventEmitter` throws unhandled `'error'` events as exceptions, crashing the process.

```typescript
// Missing — will crash the process on network blip
pool.on("error", (err) => {
  console.error("pg pool idle client error:", err);
  // Do NOT re-throw here; just log. The pool self-recovers.
});
```

---

### 5. `index.ts:38–42` — Startup `withRetry` failure silently hangs (**operability**)

```typescript
withRetry(() => pool.query("SELECT 1")).then(() => {
  app.listen(port, () => { ... });
});
// No .catch() — if withRetry exhausts all retries, the rejection
// is unhandled, the server never starts, there is no log output,
// and the process exits with code 0 (or stays alive in some runtimes).
```

**Fix:**

```typescript
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

### 6. `db.ts:13–24` — `withRetry` retries all errors, including permanent ones (**reliability**)

Authentication failures, bad credentials, schema errors, and malformed queries all get retried 10 times with 1 s each (10 seconds of silence) before the real error surfaces. Only transient connection errors should be retried.

```typescript
// Currently retries EVERYTHING — including "password authentication failed"
catch (err) {
  lastErr = err;
  await new Promise((r) => setTimeout(r, 1000));
}
```

**Fix** — check for ECONNREFUSED / pg connection error codes:

```typescript
const TRANSIENT_PG_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "57P03"]);

function isTransient(err: unknown): boolean {
  if (err instanceof Error) {
    if ("code" in err && TRANSIENT_PG_CODES.has((err as any).code)) return true;
    if (err.message.includes("ECONNREFUSED")) return true;
  }
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err)) throw err; // fail fast on permanent errors
      lastErr = err;
      const delay = Math.min(1000 * 2 ** i + Math.random() * 200, 10_000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
```

This also adds **exponential backoff with jitter** — fixed 1 s retries under load cause thundering-herd behavior.

---

### 7. `index.ts — No graceful shutdown (**data integrity in containers**)

Kubernetes/Docker sends `SIGTERM` before killing the process. Without a shutdown handler, in-flight requests are dropped mid-response and pg connections are abruptly terminated. This can leave clients in a bad state and can trigger transient "connection reset" errors upstream.

```typescript
const server = app.listen(port, () => console.log(`api listening on :${port}`));

process.on("SIGTERM", () => {
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
});
```

---

### 8. `index.ts:36` / `db.ts:7` — `PORT` and `PGPORT` env vars silently become `NaN`

```typescript
const port = Number(process.env.PORT ?? 3001);         // "abc" → NaN
port: Number(process.env.PGPORT ?? 5432),              // "abc" → NaN
```

`Number("abc")` returns `NaN`. `app.listen(NaN)` and pg's port option both have undefined behavior with `NaN` — they may bind on port 0, throw at an odd stack frame, or silently do nothing.

**Fix:**

```typescript
function parsePort(env: string | undefined, fallback: number): number {
  if (!env) return fallback;
  const n = parseInt(env, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error(`Invalid port in env: "${env}"`);
  return n;
}

const port = parsePort(process.env.PORT, 3001);
// same for PGPORT in db.ts
```

---

### 9. `index.ts:8–13` — CORS middleware doesn't handle `OPTIONS` preflight

```typescript
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  next(); // OPTIONS request falls through to 404 (or Express's auto-200)
});
```

Browser preflight (`OPTIONS`) for non-simple requests (e.g., `POST` with `Content-Type: application/json`) requires a proper 2xx response with CORS headers. Express 4's auto-OPTIONS response is unreliable across middleware stacks. The comment says this is a dev-only workaround, but it still needs to work correctly.

**Fix** — respond to preflight immediately:

```typescript
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  if (_req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});
```

---

### 10. `index.ts:16–19` — `GET /api/users` returns unbounded rows (**performance / DoS**)

```typescript
"SELECT id, email, created_at FROM users ORDER BY id"
// No LIMIT — returns every row in the table
```

As the table grows, this saturates both network and memory. Add a default limit and optional pagination:

```typescript
app.get("/api/users", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id LIMIT 100"
    );
    res.json(rows);
  } catch (err) { ... }
});
```

---

### 11. `db.ts:5–11` — Pool has no connection timeout

```typescript
export const pool = new Pool({ host, port, user, password, database });
// No connectionTimeoutMillis — if the DB is unreachable during a request,
// pool.query() hangs indefinitely.
```

**Fix:**

```typescript
export const pool = new Pool({
  host: ...,
  port: ...,
  user: ...,
  password: ...,
  database: ...,
  connectionTimeoutMillis: 5_000,  // fail a query in 5s rather than hang
  idleTimeoutMillis: 30_000,
  max: 10,
});
```

---

`★ Insight ─────────────────────────────────────`
Issues #1 and #2 interact: a single bad request to `GET /api/users/foo` triggers a pg type error, which exits the unhandled-rejection path, which on Node 15+ terminates the entire process. These two issues together give any anonymous caller a one-shot kill switch against the API — the CORS wildcard on line 9 means they don't even need to be on the same origin.
`─────────────────────────────────────────────────`

---

**Summary table** (ordered by blast radius):

| # | File:Line | Category | Severity |
|---|-----------|----------|----------|
| 1 | `index.ts:16–34` | Correctness | Critical — crash on any DB error |
| 2 | `index.ts:25–28` | Input validation | Critical — crash on malformed :id |
| 3 | `db.ts:9` | Security | Critical — credentials fallback |
| 4 | `db.ts` | Error handling | Critical — pool idle crash |
| 5 | `index.ts:38–42` | Error handling | High — silent startup failure |
| 6 | `db.ts:13–24` | Reliability | High — retries non-transient errors |
| 7 | `index.ts` | Operability | High — no graceful shutdown |
| 8 | `index.ts:36`, `db.ts:7` | Input validation | Medium — NaN port |
| 9 | `index.ts:8–13` | Correctness | Medium — broken CORS preflight |
| 10 | `index.ts:17` | Performance | Medium — unbounded query |
| 11 | `db.ts:5–11` | Reliability | Medium — no connection timeout |

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 9,
  "output_tokens": 7977,
  "cache_read_input_tokens": 249784,
  "cache_creation_input_tokens": 21114,
  "total_tokens": 278884,
  "cost_usd": 0.32130119999999995,
  "num_turns": 8
}
```
