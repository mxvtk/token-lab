# cli_long__on task 6 rep 3

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
- The `withRetry` on startup is a common Docker Compose pattern — it handles the race between the app container and the DB container coming up. But it only protects the boot probe, not runtime queries, so a transient mid-flight DB hiccup still crashes individual requests.
- Parameterised queries (`$1`) correctly prevent SQL injection. The risk here is upstream of SQL: type coercion on the `:id` path param — pg will accept `'abc'` as a `bigint` column but throw a backend error rather than a clean 404.
`─────────────────────────────────────────────────`

Here is a full senior-engineer review. No files are changed.

---

## api/src/db.ts

### 1. Hardcoded credential defaults — `db.ts:9`
**Why it matters:** `password: process.env.PGPASSWORD ?? "tokenlab"` means forgetting to set the env var in production silently uses a well-known password that is already in the repo's git history. A misconfigured deploy passes its own health check and is invisibly insecure.

```ts
// Fail loudly instead of silently falling back
const required = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

export const pool = new Pool({
  host:     process.env.PGHOST     ?? "db",
  port:     Number(process.env.PGPORT ?? 5432),
  user:     process.env.PGUSER     ?? "tokenlab",
  password: required("PGPASSWORD"),
  database: process.env.PGDATABASE ?? "tokenlab",
});
```

---

### 2. No pool size or connection timeout configuration — `db.ts:5-11`
**Why it matters:** `pg.Pool` defaults to `max: 10` connections with no `connectionTimeoutMillis` or `idleTimeoutMillis`. Under load, all 10 slots fill and new requests hang indefinitely. If the DB goes away mid-operation, the pool never times out and Express requests pile up until the process OOMs.

```ts
export const pool = new Pool({
  ...
  max: 20,
  connectionTimeoutMillis: 3_000,   // fail fast if no slot available
  idleTimeoutMillis: 30_000,
  statement_timeout: 5_000,          // server-side query timeout
});
```

---

### 3. `withRetry` retries every error, not just transient ones — `db.ts:13-24`
**Why it matters:** A permanent config error (wrong password, wrong host) causes 10 × 1-second waits before the process finally dies. A developer stares at silence for 10 seconds with no feedback.

```ts
export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = (err as any)?.code;
      // ECONNREFUSED / ENOTFOUND are transient; auth errors are not
      if (!["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code)) throw err;
      console.warn(`DB not ready (attempt ${i + 1}/${tries}), retrying…`);
      await new Promise((r) => setTimeout(r, 1000 * (i + 1))); // exponential backoff
    }
  }
  throw lastErr;
}
```

---

## api/src/index.ts

### 4. No error handling on any route — `index.ts:16-34`
**Why it matters:** Any DB error (connection lost, query timeout, schema mismatch) causes an unhandled promise rejection. In Node 18+ that crashes the process; in earlier Node it logs a warning and the client hangs forever — no response is ever sent.

```ts
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

A better pattern for a larger API is a single error-handling middleware:
```ts
// wrap async handlers
const asyncHandler =
  (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});
```

---

### 5. No input validation on `:id` — `index.ts:25-28`
**Why it matters:** `req.params.id` is a raw string. Postgres will coerce `'abc'` or `'-1'` for a `bigint` column and throw `22P02 invalid input syntax`, which crashes the route (see issue 4 above). An attacker can also probe with `0`, negative numbers, or extremely large values.

```ts
app.get("/api/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  const { rows } = await pool.query(
    "SELECT id, email, created_at FROM users WHERE id = $1",
    [id]
  );
  ...
});
```

---

### 6. Wildcard CORS is permanent, not workshop-only — `index.ts:8-13`
**Why it matters:** The comment says "during the workshop" but there is no mechanism to turn this off in production. `Access-Control-Allow-Origin: *` on a credentialed API means any website on the internet can make cross-origin requests and read the response. It also exposes the API to CSRF-style attacks from any origin.

```ts
const allowedOrigin = process.env.CORS_ORIGIN;
if (allowedOrigin) {
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", allowedOrigin);
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
    next();
  });
}
// If CORS_ORIGIN is unset, no CORS header is emitted — same-origin only.
```

---

### 7. Missing OPTIONS preflight handler — `index.ts:8-13`
**Why it matters:** The CORS middleware sets response headers but never responds to `OPTIONS` preflight requests. Browsers send `OPTIONS` before cross-origin `POST`/`PUT`/`DELETE`. Without a 204 response the preflight fails and those methods are entirely unusable from a browser.

```ts
app.options("*", (_req, res) => {
  res.header("Access-Control-Allow-Origin", allowedOrigin ?? "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  res.sendStatus(204);
});
```

---

### 8. `withRetry` startup failure is silently ignored — `index.ts:38-42`
**Why it matters:** If the DB never becomes reachable, the `withRetry(...).then(...)` promise rejects, but there is no `.catch()`. The process exits with an unhandled rejection and no structured log — just a stack trace that may or may not be captured by your log aggregator.

```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("Failed to connect to database after retries:", err);
    process.exit(1);  // explicit non-zero exit triggers restart policies
  });
```

---

### 9. No request size limit — `index.ts:5`
**Why it matters:** `express.json()` with no options defaults to a 100 KB body limit, which is usually fine — but it is worth making explicit. If this API ever grows to accept file uploads or large payloads, an accidental omission of a limit could allow a simple DoS.

```ts
app.use(express.json({ limit: "100kb" })); // explicit, reviewable
```

---

### 10. No readiness / liveness endpoint — `index.ts` (missing)
**Why it matters:** Kubernetes and Docker health checks need a `/healthz` or `/ready` route that verifies the DB connection is alive. Without it, a pod with a broken DB connection looks healthy and continues to receive traffic.

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

`★ Insight ─────────────────────────────────────`
- Issues 4 and 8 compound each other: a startup DB failure is silent, and a runtime query failure crashes the route. Together, the app can reach a state where it starts successfully (boot probe passes), then silently fails every request — the worst kind of failure mode in production.
- Issue 6 (wildcard CORS) is a good example of "workshop scaffolding" drifting into production: the comment communicates intent but code has no enforcement mechanism. The right fix is to make the safe path the default (no env var → no CORS header) so a misconfigured deploy fails safe.
`─────────────────────────────────────────────────`

---

**Summary of findings:**

| # | File | Line | Category | Severity |
|---|------|------|----------|----------|
| 1 | db.ts | 9 | Security — hardcoded credential default | High |
| 2 | db.ts | 5-11 | Performance/operability — no pool/timeout config | Medium |
| 3 | db.ts | 13-24 | Correctness — retries permanent errors | Medium |
| 4 | index.ts | 16-34 | Correctness — no error handling, process crashes on DB error | High |
| 5 | index.ts | 25-28 | Input validation — unvalidated `:id` | Medium |
| 6 | index.ts | 8-13 | Security — wildcard CORS with no off-switch | High |
| 7 | index.ts | 8-13 | Correctness — no OPTIONS preflight handler | Medium |
| 8 | index.ts | 38 | Operability — startup failure silently swallowed | Medium |
| 9 | index.ts | 5 | Operability — implicit body size limit | Low |
| 10 | index.ts | — | Operability — no health/readiness endpoint | Medium |

The two blocking issues before production are **#1** (credential fallback) and **#4** (no error handling on routes). Fix those and the service stops being one bad request away from a crash or an invisible security misconfiguration.

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 3358,
  "cache_read_input_tokens": 51331,
  "cache_creation_input_tokens": 14128,
  "total_tokens": 68821,
  "cost_usd": 0.1505493,
  "num_turns": 3,
  "permission_denials": 0
}
```
