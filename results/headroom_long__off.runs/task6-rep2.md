# headroom_long__off task 6 rep 2

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
- Both files are short but hide several production-breaking issues. The most dangerous are invisible at first glance: Express 4's silent swallowing of async rejections, and `pg`'s EventEmitter crashing the process on idle-connection errors.
- Parameterized queries prevent SQL injection, but they don't stop type errors — `$1 = 'abc'` against an integer column still throws at the DB layer.
`─────────────────────────────────────────────────`

---

## `db.ts`

---

### 1. Hardcoded fallback credentials — `db.ts:9`

```ts
password: process.env.PGPASSWORD ?? "tokenlab",
```

**Why it matters:** The literal password `"tokenlab"` ships in source control. If `PGPASSWORD` is ever unset (misconfigured deploy, CI leak, local copy), the server silently connects with a well-known password. Same applies to the username on line 8.

**Fix:**
```ts
if (!process.env.PGPASSWORD) throw new Error("PGPASSWORD env var is required");
// then:
password: process.env.PGPASSWORD,
```
Fail fast and loud at startup — never fall back to a hardcoded secret.

---

### 2. No pool error handler — `db.ts:5-11`

```ts
export const pool = new Pool({ ... });
```

**Why it matters:** `pg.Pool` extends `EventEmitter`. If an idle client encounters a network error, it emits `'error'`. With no listener, Node.js's default behavior is to throw an uncaught exception and **crash the process**. This is a known gotcha documented in `node-postgres`.

**Fix:**
```ts
pool.on("error", (err) => {
  console.error("pg pool error", err);
  // optionally: process.exit(1) if the pool is now unusable
});
```

---

### 3. No connection / timeout limits on the pool — `db.ts:5-11`

**Why it matters:** The default `Pool` has `max: 10` connections and no `connectionTimeoutMillis`. Under load, a slow/unreachable DB makes every request block forever waiting for a free client, exhausting the event loop and causing cascading timeouts.

**Fix:**
```ts
export const pool = new Pool({
  ...
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,  // fail fast rather than queue forever
});
```

---

### 4. `withRetry` retries every error — not just transient ones — `db.ts:13-24`

```ts
} catch (err) {
  lastErr = err;
  await new Promise((r) => setTimeout(r, 1000));
}
```

**Why it matters:** Authentication failures (`28P01`), bad database names (`3D000`), and permission errors (`42501`) are permanent. Retrying them 10 times wastes 10 seconds and masks the real cause in logs. For startup races you only want `ECONNREFUSED`/`ENOTFOUND`.

**Fix:**
```ts
const TRANSIENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"]);

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (!TRANSIENT.has(err?.code)) throw err;   // permanent → bail immediately
      lastErr = err;
      console.warn(`db not ready (attempt ${i + 1}/${tries}):`, err.code);
      await new Promise((r) => setTimeout(r, 1000 * Math.min(i + 1, 5))); // back-off
    }
  }
  throw lastErr;
}
```

---

### 5. No exponential back-off or jitter — `db.ts:20`

```ts
await new Promise((r) => setTimeout(r, 1000));
```

**Why it matters:** Every retry fires at the same interval. In a fleet restart (many containers starting simultaneously), all processes hammer the database at the same cadence, creating a thundering-herd effect.

**Fix:** shown in the snippet above — `1000 * Math.min(i + 1, 5)` (capped) or use `Math.pow(2, i) * 500 + Math.random() * 200` for jitter.

---

## `index.ts`

---

### 6. Async route handlers have no error handling — `index.ts:16-34`

```ts
app.get("/api/users", async (_req, res) => {
  const { rows } = await pool.query(...)
  res.json(rows);
});
```

**Why it matters:** This is the most critical issue in the file. **Express 4 does not catch rejections from async route handlers.** If `pool.query` throws — network blip, pool timeout, DB down — the error becomes an unhandled promise rejection. In Node ≥ 15 that crashes the process. In older versions the client just hangs forever.

**Fix (Express 4):**
```ts
app.get("/api/users", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id"
    );
    res.json(rows);
  } catch (err) {
    next(err);  // passes to Express error handler → 500 response
  }
});
```
Then add a final error-handling middleware:
```ts
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});
```
_(Apply the same try/catch pattern to the `/api/users/:id` handler.)_

---

### 7. No input validation on `:id` — `index.ts:27`

```ts
const { rows } = await pool.query(
  "SELECT id, email, created_at FROM users WHERE id = $1",
  [req.params.id]  // ← raw string from URL
);
```

**Why it matters:** Parameterized queries prevent SQL injection, but `$1 = 'abc'` against an integer column will cause PostgreSQL to throw `22P02 invalid_input_syntax for type integer`. With no try/catch (issue #6), that crashes the process or hangs the request. Even with error handling, the DB round-trip is wasted.

**Fix:**
```ts
app.get("/api/users/:id", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users WHERE id = $1",
      [id]
    );
    if (rows.length === 0) { res.status(404).json({ error: "not found" }); return; }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});
```

---

### 8. CORS middleware doesn't respond to OPTIONS preflight — `index.ts:8-13`

```ts
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  ...
  next();   // ← passes OPTIONS through; no one handles it
});
```

**Why it matters:** Browsers send an OPTIONS preflight before any `POST`/`PUT`/`DELETE` with a JSON body. Without a handler, the preflight falls through to Express's 404 and the actual request never fires. The CORS headers on line 9-11 never actually unblock cross-origin `POST` calls.

**Fix:**
```ts
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});
```

---

### 9. Wildcard CORS is production-unsafe — `index.ts:9`

```ts
res.header("Access-Control-Allow-Origin", "*");
```

**Why it matters:** `*` allows any page on the internet to call this API from a user's browser. Any XSS on any domain can read the response. For a workshop server it is tolerable; for a service with authentication or sensitive data it is not.

**Fix:** Restrict to known origins or use `cors` with an `origin` allowlist:
```ts
import cors from "cors";
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") ?? [] }));
```

---

### 10. Startup failure is an unhandled rejection — `index.ts:38`

```ts
withRetry(() => pool.query("SELECT 1")).then(() => {
  app.listen(port, ...);
});
// no .catch()
```

**Why it matters:** If `withRetry` exhausts all retries and throws, the rejection goes unhandled. In Node ≥ 15 this crashes the process with no meaningful log message beyond the default "UnhandledPromiseRejection" dump.

**Fix:**
```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("Failed to connect to database:", err);
    process.exit(1);  // explicit, with a human-readable message
  });
```

---

### 11. `app.listen` port parsing is fragile — `index.ts:36`

```ts
const port = Number(process.env.PORT ?? 3001);
```

**Why it matters:** `Number("abc")` returns `NaN`. `app.listen(NaN)` picks a random OS-assigned port and logs `api listening on :NaN` — the server appears healthy while nothing can reach it.

**Fix:**
```ts
const rawPort = process.env.PORT ?? "3001";
const port = parseInt(rawPort, 10);
if (isNaN(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: "${rawPort}"`);
}
```

---

### 12. No graceful shutdown — `index.ts` (missing)

**Why it matters:** Kubernetes and Docker send `SIGTERM` before `SIGKILL`. Without a handler, in-flight requests are interrupted mid-response, the pool is never drained, and pg clients may leave dangling transactions.

**Fix:**
```ts
const server = app.listen(port, () => console.log(`api listening on :${port}`));

const shutdown = () => {
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

---

## Summary table

| # | File | Line | Severity | Issue |
|---|------|------|----------|-------|
| 1 | db.ts | 9 | **Critical** | Hardcoded fallback password in source |
| 2 | db.ts | 5 | **Critical** | No pool `'error'` listener — unhandled EventEmitter crash |
| 6 | index.ts | 16,24 | **Critical** | Async routes crash process on throw (Express 4, no try/catch) |
| 4 | db.ts | 13 | **High** | `withRetry` retries permanent errors (auth, bad DB name) |
| 7 | index.ts | 27 | **High** | No `:id` validation → DB type error crashes unguarded handler |
| 8 | index.ts | 8 | **High** | OPTIONS preflight not handled → CORS broken for POST/PUT/DELETE |
| 10 | index.ts | 38 | **High** | Startup failure is an unhandled rejection |
| 3 | db.ts | 5 | **Medium** | No `connectionTimeoutMillis` → requests queue forever under load |
| 5 | db.ts | 20 | **Medium** | Fixed retry interval — thundering herd on restart |
| 9 | index.ts | 9 | **Medium** | Wildcard CORS — unsafe for production |
| 11 | index.ts | 36 | **Medium** | `Number(env)` → `NaN` port silently binds to random port |
| 12 | index.ts | — | **Medium** | No SIGTERM handler — requests interrupted, pool not drained |

`★ Insight ─────────────────────────────────────`
- Issues #2 and #6 are "invisible" because they look fine locally where the DB never goes down and no bad IDs are sent. They only surface under production conditions (network blip, deploy race, malformed request).
- Express 5 (released 2024) auto-wraps async handlers, which would fix #6 without try/catch — worth considering as a dependency upgrade path.
- The pattern of `withRetry` only guarding startup (not actual query paths) means the server survives a reboot check but has zero resilience to mid-flight DB interruptions once running.
`─────────────────────────────────────────────────`

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 5407,
  "cache_read_input_tokens": 55130,
  "cache_creation_input_tokens": 18137,
  "total_tokens": 78678,
  "cost_usd": 0.206478,
  "num_turns": 3,
  "permission_denials": 0
}
```
