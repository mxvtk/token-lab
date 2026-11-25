# caveman_long__on task 6 rep 2

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix" # live_only: opens a real PR — never part of the batch A/B; run by hand with --task 5.

## Agent result

`★ Insight ─────────────────────────────────────`
These files are small but pack several classic production failure modes: unhandled promise rejections crash the process, missing try/catch on async route handlers silently hangs requests, and hardcoded credentials mean any copy of the binary ships with working DB access.
`─────────────────────────────────────────────────`

---

## `api/src/db.ts`

**db.ts:9 — Hardcoded credential defaults**

`password: process.env.PGPASSWORD ?? "tokenlab"` means if the env var is ever missing in production the server connects anyway with a known-public password. A missing credential should be a startup failure, not a silent fallback.

```ts
const required = (name: string): string => {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
};

export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "tokenlab",
  password: required("PGPASSWORD"),
  database: process.env.PGDATABASE ?? "tokenlab",
});
```

---

**db.ts:15–21 — `withRetry` retries all errors, not just transient ones**

A syntax error in a query or a permissions failure will retry 10 times with a 1-second sleep before finally throwing. Only connection-class errors should be retried.

```ts
import { DatabaseError } from "pg";

const isTransient = (err: unknown) =>
  err instanceof DatabaseError &&
  ["08", "57P", "53"].some((prefix) => err.code?.startsWith(prefix));

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err)) throw err;   // fail fast on non-transient errors
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1))); // exponential backoff
    }
  }
  throw lastErr;
}
```

---

**db.ts:13 — No pool error listener → unhandled rejection crashes process**

`pg.Pool` emits `'error'` on idle client errors. Without a listener Node's default handler throws an uncaught exception and kills the process.

```ts
pool.on("error", (err) => {
  console.error("pg pool idle client error", err);
});
```

---

## `api/src/index.ts`

**index.ts:17–21 / 25–33 — Async route handlers have no error handling**

If `pool.query` rejects (network blip, Postgres restart), Express receives an unhandled rejection. In Express 4 (the default) the request hangs forever; in Express 5 it crashes. Add a wrapper or use Express 5's native async support consistently.

```ts
const asyncRoute =
  (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

app.get(
  "/api/users",
  asyncRoute(async (_req, res) => {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users ORDER BY id"
    );
    res.json(rows);
  })
);
```

And add a global error handler at the bottom:

```ts
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});
```

---

**index.ts:27 — `req.params.id` passed to query without integer validation**

`$1` is parameterized so SQL injection is blocked, but passing a non-numeric string (e.g. `/api/users/abc`) makes Postgres throw `invalid input syntax for type integer`. That error surfaces as a 500 (or a hang) instead of a 400. It also wastes a round-trip to the DB.

```ts
app.get("/api/users/:id", asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
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
}));
```

---

**index.ts:9 — Wildcard CORS in production**

`Access-Control-Allow-Origin: *` is fine for a local workshop but will allow any origin to call the API in prod. Credentials can't be sent with `*`, but if authentication is ever added this will silently break it, and it exposes unauthenticated data to any website.

```ts
const allowedOrigin = process.env.CORS_ORIGIN ?? "http://localhost:5173";

app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", allowedOrigin);
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  next();
});
```

---

**index.ts:38 — Startup failure swallowed silently**

If `withRetry` exhausts all attempts (DB never comes up) the rejected promise is unhandled — the process exits with no meaningful log. Add `.catch`:

```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("DB never became ready, aborting", err);
    process.exit(1);
  });
```

---

**index.ts:36 — `Number(undefined)` is `NaN` for PORT**

`Number(process.env.PORT ?? 3001)` is fine since the nullish coalesce runs first, but if `PORT=""` (empty string) `Number("")` is `0` and `app.listen(0)` picks an ephemeral port silently. Guard it:

```ts
const port = process.env.PORT ? Number(process.env.PORT) : 3001;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: "${process.env.PORT}"`);
}
```

---

**index.ts:16–21 — `GET /api/users` has no pagination**

Not a crash, but a production correctness issue: a full table scan returned as one JSON blob will OOM the process and time out for large tables. Add `LIMIT`/`OFFSET` or keyset pagination before this hits real data volumes.

```ts
app.get("/api/users", asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || !Number.isInteger(offset) || offset < 0) {
    res.status(400).json({ error: "invalid pagination params" }); return;
  }
  const { rows } = await pool.query(
    "SELECT id, email, created_at FROM users ORDER BY id LIMIT $1 OFFSET $2",
    [limit, offset]
  );
  res.json(rows);
}));
```

---

`★ Insight ─────────────────────────────────────`
The two most dangerous issues together: no try/catch on async routes (hanging/crashing requests) + no pool error listener (unhandled idle-client rejections). Both are silent in development, catastrophic in production. The retry-all-errors pattern is the subtler trap — it hides misconfigurations behind a 10-second delay that looks like a slow DB.
`─────────────────────────────────────────────────`

**Summary of issues by severity:**

| # | File:Line | Category | Severity |
|---|-----------|----------|----------|
| 1 | `index.ts:17,25` | Unhandled async errors in route handlers | Critical |
| 2 | `db.ts:5` | No pool `'error'` listener | Critical |
| 3 | `db.ts:15` | Retries all errors, not just transient ones | High |
| 4 | `db.ts:9` | Hardcoded credential fallback | High |
| 5 | `index.ts:38` | Startup rejection unhandled | High |
| 6 | `index.ts:27` | No integer validation on `:id` param | Medium |
| 7 | `index.ts:9` | Wildcard CORS | Medium |
| 8 | `index.ts:36` | `PORT=""` resolves to 0 | Low |
| 9 | `index.ts:16` | No pagination on `/users` | Low |

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 2561,
  "cache_read_input_tokens": 57758,
  "cache_creation_input_tokens": 20548,
  "total_tokens": 80871,
  "cost_usd": 0.1790424,
  "num_turns": 3
}
```
