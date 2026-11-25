# caveman_long__off task 6 rep 2

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix" # live_only: opens a real PR — never part of the batch A/B; run by hand with --task 5.

## Agent result

`★ Insight ─────────────────────────────────────`
This codebase is intentionally minimal — a workshop scaffold — but that's exactly the kind of code that gets promoted to production "just temporarily" and stays there for years. The issues below are real production concerns, not theoretical nits.
`─────────────────────────────────────────────────`

Here's the full production review:

---

## `api/src/index.ts`

---

### 1. Unhandled async exceptions crash the process (correctness / reliability)
**`index.ts:17`** and **`index.ts:25`**

Both route handlers are `async` but have no `try/catch`. Any unexpected DB error (connection drop, constraint violation, etc.) will propagate as an unhandled rejection and either crash the Node process or, in newer Node versions, emit an unhandled rejection that silently swallows the error while leaving the client hanging.

```ts
// Fix: wrap each handler
app.get("/api/users", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id"
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/users error", err);
    res.status(500).json({ error: "internal server error" });
  }
});
```

A better pattern for a larger API is a central error-handling wrapper:
```ts
function asyncHandler(fn: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});
```

---

### 2. No input validation on `:id` — potential SQL misbehavior or type confusion
**`index.ts:27`**

```ts
[req.params.id]
```

`req.params.id` is always a `string`. If the DB column `id` is `integer`, pg will coerce it, but passing `"abc"` or `"1; --"` causes a pg type error rather than a clean 400. More importantly, there's no upper bound on length — a 10,000-character string will be sent to the DB before you reject it.

```ts
// Fix: validate before hitting the DB
const id = Number(req.params.id);
if (!Number.isInteger(id) || id <= 0) {
  res.status(400).json({ error: "id must be a positive integer" });
  return;
}
const { rows } = await pool.query(
  "SELECT id, email, created_at FROM users WHERE id = $1",
  [id]
);
```

---

### 3. CORS is a wildcard with no preflight handling — security issue for workshop code promoted to production
**`index.ts:9`**

```ts
res.header("Access-Control-Allow-Origin", "*");
```

The comment says "during the workshop" but there's no mechanism to gate this. `*` wildcard CORS means any website on the internet can call this API from a user's browser — combined with cookies or any future auth headers, this opens CSRF-equivalent risks. There's also no `OPTIONS` preflight handler, so browsers will sometimes send a preflight that gets a 404 response.

```ts
// Fix: environment-gated CORS + preflight
const allowedOrigin = process.env.CORS_ORIGIN ?? "http://localhost:5173";
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", allowedOrigin);
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
```

---

### 4. Startup failure is fatal and unlogged
**`index.ts:38`**

```ts
withRetry(() => pool.query("SELECT 1")).then(() => {
  app.listen(port, () => { ... });
});
```

If `withRetry` exhausts all retries, the returned promise rejects with no `.catch()`. The process exits with an unhandled rejection, potentially without printing the error (depends on Node version and process config). The error should be caught, logged explicitly, and `process.exit(1)` called so the container/orchestrator knows to restart.

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

### 5. No request size limit — DoS via large payloads
**`index.ts:5`**

```ts
app.use(express.json());
```

By default `express.json()` accepts payloads up to 100 KB. For this API that serves/receives user rows, 100 KB is far more than necessary. A malicious caller can send near-100 KB JSON on every request, burning memory and CPU for JSON parsing. Set an explicit, tight limit:

```ts
app.use(express.json({ limit: "4kb" }));
```

---

### 6. No health / readiness endpoint
**`index.ts` — missing**

There is no `/healthz` or `/readyz` endpoint. Without one, load balancers and Kubernetes liveness/readiness probes can't determine if the app is healthy, leading to traffic being routed to broken instances or restarts being delayed. A minimal addition:

```ts
app.get("/healthz", (_req, res) => res.json({ ok: true }));
```

---

## `api/src/db.ts`

---

### 7. Hardcoded credential defaults in source code
**`db.ts:8–11`**

```ts
password: process.env.PGPASSWORD ?? "tokenlab",
```

If `PGPASSWORD` is not set in a production environment, the pool connects with the plaintext default password `"tokenlab"`. This is a credential in source that can appear in git history and container images. The correct behavior is to fail fast if credentials are missing in production — not silently fall back to a known default.

```ts
// Fix: require credentials in production, allow defaults only in dev
const isProduction = process.env.NODE_ENV === "production";

function requireEnv(name: string, fallback?: string): string {
  const val = process.env[name] ?? fallback;
  if (!val && isProduction) throw new Error(`Missing required env var: ${name}`);
  return val ?? "";
}

export const pool = new Pool({
  host: requireEnv("PGHOST", "db"),
  port: Number(process.env.PGPORT ?? 5432),
  user: requireEnv("PGUSER", "tokenlab"),
  password: requireEnv("PGPASSWORD", isProduction ? undefined : "tokenlab"),
  database: requireEnv("PGDATABASE", "tokenlab"),
});
```

---

### 8. `withRetry` retries on all errors — including non-transient ones
**`db.ts:18`**

```ts
} catch (err) {
  lastErr = err;
  await new Promise((r) => setTimeout(r, 1000));
}
```

The retry logic catches everything — including `EACCES`, auth failures, bad SQL, or config errors — and retries them 10 times over 10 seconds before giving up. A wrong password will silently hammer the DB auth system 10 times before surfacing the error. This also makes startup-time misconfiguration much harder to diagnose.

At minimum, distinguish connection errors from other errors:

```ts
export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      // Don't retry auth failures or bad credentials — they won't self-heal
      if (err?.code === "28P01" || err?.code === "28000") throw err;
      lastErr = err;
      console.warn(`withRetry attempt ${i + 1}/${tries} failed:`, err?.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}
```

---

### 9. No pool size limits or timeout configuration
**`db.ts:5–11`**

The `Pool` is created with all defaults: `max: 10` connections, no `connectionTimeoutMillis`, no `idleTimeoutMillis`. Under load:
- If all 10 connections are busy, new queries queue silently with no timeout — a request can hang indefinitely waiting for a connection.
- Idle connections are held for 10 seconds (default) but leaked connections are never detected.

```ts
export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "tokenlab",
  password: process.env.PGPASSWORD ?? "tokenlab",
  database: process.env.PGDATABASE ?? "tokenlab",
  max: 10,
  connectionTimeoutMillis: 3000,  // fail fast if pool is exhausted
  idleTimeoutMillis: 30000,
  statement_timeout: 5000,        // kill runaway queries after 5s
});
```

---

`★ Insight ─────────────────────────────────────`
Issues 1 and 4 (unhandled async errors + no `.catch` on startup) are the most likely to cause silent production failures — they're the kind of bug that only appears at 2am under load. Issue 7 (hardcoded credentials) is the kind that shows up in a security audit as a critical finding even when it's "obviously" for dev only. Issue 8 (retrying auth failures) is a subtle operational trap: it makes legitimate connection errors take 10x longer to surface, which is the worst time to be waiting.
`─────────────────────────────────────────────────`

---

## Summary table

| # | File | Line | Severity | Category |
|---|------|------|----------|----------|
| 1 | `index.ts` | 17, 25 | **Critical** | Correctness — unhandled async rejections |
| 2 | `index.ts` | 27 | High | Input validation — unvalidated `:id` |
| 3 | `index.ts` | 9 | High | Security — wildcard CORS, no preflight |
| 4 | `index.ts` | 38 | High | Reliability — unhandled startup rejection |
| 5 | `index.ts` | 5 | Medium | DoS / performance — no body size limit |
| 6 | `index.ts` | — | Medium | Operability — no health endpoint |
| 7 | `db.ts` | 8–11 | **Critical** | Security — hardcoded credential defaults |
| 8 | `db.ts` | 18 | High | Reliability — retries non-transient errors |
| 9 | `db.ts` | 5–11 | Medium | Performance / reliability — no pool timeouts |

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 3183,
  "cache_read_input_tokens": 55169,
  "cache_creation_input_tokens": 18089,
  "total_tokens": 76445,
  "cost_usd": 0.17284170000000001,
  "num_turns": 3
}
```
