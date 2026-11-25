# cli_long__on task 6 rep 1

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
- The codebase is a minimal Express + pg API — small surface area, but each issue carries more weight because there's no middleware layer absorbing mistakes.
- `pg.Pool` does connection pooling automatically; every unhandled exception in an async route handler leaks that pool slot until `pool.end()` or a PG timeout reclaims it.
- Hardcoded credentials in defaults are a classic workshop shortcut that gets copy-pasted to production — worth flagging explicitly.
`─────────────────────────────────────────────────`

---

Here is a complete senior-engineer review. Issues are ordered roughly by severity.

---

## 1. `api/src/index.ts:16-21` — Unhandled async exceptions crash the process (or hang the request)

**Why it matters:** Express 4 does **not** catch rejections from `async` route handlers. If `pool.query()` throws (DB timeout, connection error, constraint violation), the promise rejection is unhandled. In Node ≥ 15 that terminates the process. In earlier Node it silently hangs — the client waits forever and the pool slot is never released.

Same problem applies to the `GET /api/users/:id` handler (line 24-34).

```ts
// Every async handler needs a try/catch, or a wrapper:
app.get("/api/users", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id"
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/users failed:", err);
    res.status(500).json({ error: "internal server error" });
  }
});
```

Or install `express-async-errors` once at startup so thrown errors are routed to the Express error handler automatically.

---

## 2. `api/src/index.ts:25-33` — `:id` is passed to Postgres without type validation

**Why it matters:** `req.params.id` is a raw string. If a caller sends `/api/users/1;DROP TABLE users--` or a UUID when the column is `int4`, Postgres will reject it — but the rejection becomes an unhandled exception (issue #1). More subtly, an integer column implicitly cast from a string with leading whitespace behaves differently across Postgres versions. Validating before the query gives you a clean 400 instead of a 500 and closes off a class of unexpected behaviour.

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
    console.error("GET /api/users/:id failed:", err);
    res.status(500).json({ error: "internal server error" });
  }
});
```

---

## 3. `api/src/index.ts:8-13` — CORS wildcard on all origins with all methods

**Why it matters:** `Access-Control-Allow-Origin: *` allows any website's JavaScript to call your API. Combined with `Access-Control-Allow-Methods: GET,POST,PUT,DELETE` this is an XSS amplifier — a compromised third-party page can read your users list or hit destructive endpoints you add later. The comment even says "workshop", which is the main risk: this config gets committed and forgotten.

```ts
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:5173";

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");           // required when echoing a specific origin
    res.header("Access-Control-Allow-Headers", "Content-Type");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
```

Also note: the current code has **no `OPTIONS` preflight handler**. Browsers send `OPTIONS` before mutating requests; without a handler, POST/PUT/DELETE will be blocked in a browser even though the headers are set.

---

## 4. `api/src/db.ts:9` — Hardcoded plaintext password in source

**Why it matters:** `password: process.env.PGPASSWORD ?? "tokenlab"` means if `PGPASSWORD` is not set in production, the server silently connects with the default password. This is a production credential leak waiting to happen — especially dangerous if the image is pushed to a public registry.

```ts
// Fail fast rather than fall back to an insecure default:
const requiredEnv = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
};

export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "tokenlab",
  password: requiredEnv("PGPASSWORD"),          // no fallback
  database: process.env.PGDATABASE ?? "tokenlab",
});
```

---

## 5. `api/src/index.ts:38-42` — Startup failure is silently swallowed by `.then()` with no `.catch()`

**Why it matters:** If `withRetry` exhausts all 10 attempts (Postgres never comes up), the promise rejects. With no `.catch()` on that chain this becomes an unhandled rejection — again a process crash in Node ≥ 15, silent failure in older Node. The server never starts but exits with no useful message.

```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => {
      console.log(`api listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error("Could not connect to database after retries:", err);
    process.exit(1);
  });
```

---

## 6. `api/src/db.ts:13-24` — `withRetry` retries on every error, including permanent ones

**Why it matters:** A wrong password or a missing database name causes an `ECONNREFUSED`-class error but also causes auth failures (error code `28P01`) or database-not-found (`3D000`). Retrying those 10 times over 10 seconds wastes startup time and obscures the real cause in logs. Only transient connection errors should be retried.

```ts
const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "57P03"]);

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException & { code?: string }).code;
      if (code && !TRANSIENT_CODES.has(code)) throw err; // fail immediately on permanent errors
      lastErr = err;
      console.warn(`DB not ready (attempt ${i + 1}/${tries}), retrying in 1s…`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}
```

---

## 7. `api/src/db.ts:5-11` — No pool size or timeout configuration

**Why it matters:** `pg.Pool` defaults to a maximum of 10 connections with no `connectionTimeoutMillis` or `idleTimeoutMillis`. Under load, the pool can exhaust all Postgres `max_connections` slots, and a slow query holds a connection forever — starving other requests with no timeout or backpressure signal.

```ts
export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "tokenlab",
  password: requiredEnv("PGPASSWORD"),
  database: process.env.PGDATABASE ?? "tokenlab",
  max: Number(process.env.PGPOOL_MAX ?? 10),
  connectionTimeoutMillis: 5_000,   // give up acquiring a connection after 5 s
  idleTimeoutMillis: 30_000,        // release idle connections after 30 s
  statement_timeout: 10_000,        // per-query timeout at Postgres level
});
```

---

## 8. `api/src/index.ts:16-20` — `GET /api/users` is unbounded — no pagination or limit

**Why it matters:** `SELECT … FROM users ORDER BY id` with no `LIMIT` returns every row. With 10 M users this OOMs the Node process and hammers Postgres. Even at thousands of rows, response size becomes unbounded.

```ts
app.get("/api/users", async (_req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 1000);
  const offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || !Number.isInteger(offset) || offset < 0) {
    res.status(400).json({ error: "invalid pagination params" });
    return;
  }
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id LIMIT $1 OFFSET $2",
      [limit, offset]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/users failed:", err);
    res.status(500).json({ error: "internal server error" });
  }
});
```

---

## 9. `api/src/index.ts:36` — `PORT` parsing silently becomes `NaN`

**Why it matters:** `Number(process.env.PORT ?? 3001)` returns `NaN` if `PORT` is set to an empty string or non-numeric value. `app.listen(NaN)` picks a random OS-assigned port with no warning — the server starts but nothing can reach it reliably.

```ts
const rawPort = process.env.PORT ?? "3001";
const port = parseInt(rawPort, 10);
if (isNaN(port) || port < 1 || port > 65535) {
  console.error(`Invalid PORT: "${rawPort}"`);
  process.exit(1);
}
```

---

`★ Insight ─────────────────────────────────────`
- Issues 1 and 5 (unhandled async rejections) are the most likely to surface first in production — Express 4 doesn't wrap async handlers, and this is a very common gotcha that bites teams after upgrading Node.
- Issues 3 (CORS) and 4 (hardcoded password) are the kind of "workshop default" that live in repos for years because they never cause a visible failure — they only matter when something goes wrong.
- Express 5 (currently stable) wraps async handlers automatically, eliminating issue 1 entirely — worth considering as a future upgrade path.
`─────────────────────────────────────────────────`

---

**Summary table:**

| # | File | Lines | Category | Severity |
|---|------|-------|----------|----------|
| 1 | index.ts | 16–21, 24–34 | Error handling — unhandled async rejections | Critical |
| 2 | index.ts | 25 | Input validation — raw string to Postgres | High |
| 3 | index.ts | 8–13 | Security — CORS wildcard + no OPTIONS handler | High |
| 4 | db.ts | 9 | Security — hardcoded password fallback | High |
| 5 | index.ts | 38–42 | Error handling — no `.catch()` at startup | High |
| 6 | db.ts | 13–24 | Correctness — retrying permanent DB errors | Medium |
| 7 | db.ts | 5–11 | Performance — no pool/timeout config | Medium |
| 8 | index.ts | 17 | Performance — unbounded `SELECT *` | Medium |
| 9 | index.ts | 36 | Correctness — `NaN` PORT silently accepted | Low |

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 4273,
  "cache_read_input_tokens": 51331,
  "cache_creation_input_tokens": 14678,
  "total_tokens": 70286,
  "cost_usd": 0.1675743,
  "num_turns": 3,
  "permission_denials": 0
}
```
