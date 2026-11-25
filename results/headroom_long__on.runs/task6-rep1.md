# headroom_long__on task 6 rep 1

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
Before diving in: this codebase is a workshop sandbox, so some choices (wildcard CORS, hardcoded credentials) are intentional for local dev. But many issues below would still land in production if the workshop code got promoted — which is exactly the right time to catch them.
`─────────────────────────────────────────────────`

Here is the full senior-engineer review. Issues are ordered by severity.

---

## `api/src/index.ts`

---

### 1. Unhandled async errors — crash-prone routes
**`index.ts:17`, `index.ts:25`**

Both route handlers are `async` but have no `.catch()` and no wrapping `try/catch`. Any DB error (connection lost, query syntax error, constraint violation) will produce an unhandled promise rejection. In Node 18+ that crashes the process; on earlier Node it silently swallows the error and leaves the HTTP request hanging until a timeout.

**Why it matters:** A single bad query or transient DB hiccup takes down the whole server.

**Fix:**
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
Apply the same pattern to every async route. Alternatively, use an `asyncHandler` wrapper once and apply it to all routes:
```ts
const asyncHandler =
  (fn: express.RequestHandler) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// then:
app.get("/api/users", asyncHandler(async (_req, res) => { ... }));
```

---

### 2. No input validation on `:id` — type confusion / accidental full-table scan risk
**`index.ts:27`**

`req.params.id` is a raw string from the URL. `pg` will pass it as `$1` to Postgres, which will coerce it to `integer` for the `WHERE id = $1` comparison — but only if the string looks like an integer. If it doesn't (e.g. `GET /api/users/../../etc`), Postgres throws a cast error that falls into issue #1 and crashes the process. If `id` is a UUID column, any non-UUID input causes the same crash.

**Why it matters:** Unvalidated path params are a correctness bug today and an injection vector if the query ever evolves.

**Fix:**
```ts
app.get("/api/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  // ... use id
});
```

---

### 3. Wildcard CORS with no OPTIONS pre-flight handler
**`index.ts:9`**

`Access-Control-Allow-Origin: *` is intentional for dev (the comment says so), but there is no `OPTIONS` handler. Modern browsers send a pre-flight `OPTIONS` request before any `POST`/`PUT`/`DELETE`. Without a handler, the pre-flight hits Express's default 404, so the actual request is blocked.

**Why it matters:** `GET /api/users` works fine, but any future mutation endpoint (`POST /api/users`) will be silently blocked from the browser.

**Fix:**
```ts
// At the top, before routes, handle pre-flight explicitly:
app.options("*", (_req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  res.sendStatus(204);
});
```
Or replace the manual headers with the `cors` package, which handles OPTIONS automatically:
```ts
import cors from "cors";
app.use(cors());
```

---

### 4. No request body size limit
**`index.ts:5`**

`express.json()` with no options defaults to a **100 kB** body limit. That's Express's default, not yours. For this API there is no mutation route yet, but once one lands, a payload larger than 100 kB will throw a `PayloadTooLargeError` — which is again an unhandled async error (see issue #1).

**Why it matters:** Easy to miss; the error message is obscure and the route just hangs if the error isn't caught.

**Fix:**
```ts
app.use(express.json({ limit: "10kb" })); // explicit and intentional
```

---

### 5. `withRetry` startup failure is fully silent
**`index.ts:38`**

```ts
withRetry(() => pool.query("SELECT 1")).then(() => { app.listen(...) });
```

If `withRetry` exhausts all 10 tries and throws, the rejection is unhandled — the process exits (Node 18+) with no meaningful log message. The root cause (wrong password, DB host unreachable) is swallowed.

**Why it matters:** A failed startup in a container or CI pipeline will appear as an instant crash with no actionable log.

**Fix:**
```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("DB connectivity check failed:", err);
    process.exit(1);
  });
```

---

### 6. Missing `GET /api/users` response pagination / size cap
**`index.ts:17–20`**

`SELECT ... FROM users ORDER BY id` with no `LIMIT` returns every row in the table. At scale this means unbounded memory allocation in the Node process and a potentially enormous JSON response to the client.

**Why it matters:** A table with 100 k users sends ~10–15 MB of JSON per request and ties up a pool connection for seconds.

**Fix:**
```ts
const limit = Math.min(Number(req.query.limit ?? 100), 1000);
const offset = Number(req.query.offset ?? 0);
const { rows } = await pool.query(
  "SELECT id, email, created_at FROM users ORDER BY id LIMIT $1 OFFSET $2",
  [limit, offset]
);
```

---

## `api/src/db.ts`

---

### 7. Hardcoded credential defaults in production code
**`db.ts:6–10`**

```ts
password: process.env.PGPASSWORD ?? "tokenlab",
```

The fallback `"tokenlab"` ships in the binary. If `PGPASSWORD` is ever unset in a non-dev environment (misconfigured secret, wrong env namespace), the app silently connects with the default password and shows no warning.

**Why it matters:** The fallback looks like a "it just works" safety net but is actually a credential leak vector. It also masks misconfiguration silently.

**Fix — fail fast if the env var is absent in non-dev:**
```ts
function requireEnv(key: string, devDefault?: string): string {
  const val = process.env[key];
  if (val) return val;
  if (process.env.NODE_ENV !== "production" && devDefault !== undefined) return devDefault;
  throw new Error(`Missing required environment variable: ${key}`);
}

export const pool = new Pool({
  host: requireEnv("PGHOST", "db"),
  port: Number(requireEnv("PGPORT", "5432")),
  user: requireEnv("PGUSER", "tokenlab"),
  password: requireEnv("PGPASSWORD", "tokenlab"),
  database: requireEnv("PGDATABASE", "tokenlab"),
});
```

---

### 8. `withRetry` retries every error, not just transient ones
**`db.ts:13–24`**

The retry loop catches all errors unconditionally. If `fn` throws a *permanent* error — authentication failure (`28P01`), database does not exist (`3D000`), or a query syntax error — `withRetry` will retry it 10 times over 10 seconds, burning time and generating noise in logs before eventually throwing.

**Why it matters:** Ops/on-call wastes 10 seconds during a startup failure and sees 10 noisy log lines instead of one clear error.

**Fix — only retry on transient network/connection errors:**
```ts
const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "57P01", "08006", "08001"]);

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? (err as { code?: string }).code;
      if (!TRANSIENT_CODES.has(code ?? "")) throw err; // permanent — don't retry
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1))); // exponential backoff
    }
  }
  throw lastErr;
}
```

---

### 9. No pool connection limits configured
**`db.ts:5–11`**

`new Pool({...})` with no `max` defaults to **10 connections**. This is not necessarily wrong, but it is implicit. Under load, all 10 connections can be held by slow queries, causing new requests to queue indefinitely. There is also no `idleTimeoutMillis` or `connectionTimeoutMillis`, so a hung connection is never recycled and a new request waits forever.

**Why it matters:** Connection exhaustion is a common production incident. Explicit limits and timeouts make the failure mode predictable and fast.

**Fix:**
```ts
export const pool = new Pool({
  ...
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000, // fail fast if pool is exhausted
});
```

---

### 10. No pool error event handler — silent unhandled rejection
**`db.ts`**

`pg.Pool` emits an `"error"` event when a background client encounters an error (e.g. the DB kills an idle connection). If no handler is registered, Node.js treats this as an unhandled `EventEmitter` error and crashes the process.

**Why it matters:** A routine DB server restart or network blip will kill the API process entirely rather than letting it recover.

**Fix:**
```ts
pool.on("error", (err) => {
  console.error("Unexpected pool client error:", err);
  // Do NOT exit — the pool will recover on the next acquire
});
```

---

`★ Insight ─────────────────────────────────────`
Issues #1, #5, and #10 are all the same root pattern: unhandled rejections/errors at process boundaries. In Node.js, any `EventEmitter` with no `"error"` listener and any unhandled `Promise` rejection share the same failure mode — a silent or crashing process. A good production baseline adds `process.on("unhandledRejection", ...)` and `process.on("uncaughtException", ...)` as a last-resort safety net on top of explicit per-site handling.
`─────────────────────────────────────────────────`

---

## Summary table

| # | File | Line(s) | Severity | Category |
|---|------|---------|----------|----------|
| 1 | index.ts | 17, 25 | **Critical** | Error handling — unhandled async errors |
| 5 | index.ts | 38 | **Critical** | Error handling — silent startup failure |
| 10 | db.ts | 5 | **Critical** | Operability — pool crash on idle-client error |
| 7 | db.ts | 6–10 | **High** | Security — hardcoded credential defaults |
| 2 | index.ts | 27 | **High** | Correctness / Security — unvalidated path param |
| 8 | db.ts | 13 | **High** | Correctness — retrying permanent errors |
| 9 | db.ts | 5 | **Medium** | Operability — implicit pool limits, no timeouts |
| 3 | index.ts | 8–13 | **Medium** | Correctness — missing OPTIONS pre-flight handler |
| 6 | index.ts | 17 | **Medium** | Performance — unbounded `SELECT *` |
| 4 | index.ts | 5 | **Low** | Operability — implicit body size limit |

Ten issues total. The three critical ones (#1, #5, #10) can each take the server down in production under normal operating conditions; fix those first.

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 3697,
  "cache_read_input_tokens": 55191,
  "cache_creation_input_tokens": 18222,
  "total_tokens": 77114,
  "cost_usd": 0.18135630000000003,
  "num_turns": 3
}
```
