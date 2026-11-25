# caveman_long__on task 6 rep 3

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix" # live_only: opens a real PR — never part of the batch A/B; run by hand with --task 5.

## Agent result

`★ Insight ─────────────────────────────────────`
Express 4 does **not** automatically forward thrown/rejected async errors to its error handler — that was added in Express 5. Any `throw` inside an `async` route in Express 4 silently hangs the request or crashes the process. All async routes need their own try/catch or an async wrapper.
`─────────────────────────────────────────────────`

---

## `db.ts`

---

**db.ts:9 — Hardcoded credential default (security)**

`password: "tokenlab"` ships a known password. If `PGPASSWORD` is ever unset in a deployed environment, the server connects with a public default credential. Fail loudly instead:

```ts
password: (() => {
  const p = process.env.PGPASSWORD;
  if (!p) throw new Error("PGPASSWORD must be set");
  return p;
})(),
```

---

**db.ts:5 — No pool `error` handler (correctness/crash)**

`pg.Pool` emits `'error'` on idle-client errors (e.g. unexpected disconnect). Without a listener Node.js treats it as an uncaught exception and crashes. This is a [documented pg pitfall](https://node-postgres.com/apis/pool#events).

```ts
export const pool = new Pool({ ... });
pool.on("error", (err) => {
  console.error("pg pool idle error:", err);
});
```

---

**db.ts:15-22 — `withRetry` retries all errors, including permanent ones (correctness)**

Auth failures (`28P01`), bad DB name (`3D000`), and other configuration errors will retry 10 times before surfacing. This wastes 10 seconds at startup and masks the real error. Only retry transient connectivity errors:

```ts
const TRANSIENT = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"]);

function isTransient(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code ?? (err as { routine?: string }).routine;
  return TRANSIENT.has(code as string);
}

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err)) throw err; // fail fast on permanent errors
      lastErr = err;
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** i, 10_000))); // exponential backoff
    }
  }
  throw lastErr;
}
```

This also replaces the flat 1 s delay with exponential backoff (capped at 10 s).

---

**db.ts:7 — `PGPORT` coercion without validation (correctness)**

`Number("abc")` returns `NaN`. `pg` will silently fail or use an unexpected default port. Same issue exists for `PORT` in `index.ts:36`.

```ts
function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error(`${name} must be an integer 1–65535, got "${v}"`);
  return n;
}

export const pool = new Pool({
  host: process.env.PGHOST ?? "db",
  port: envInt("PGPORT", 5432),
  ...
});
```

---

## `index.ts`

---

**index.ts:16-21 and 24-34 — Unhandled async errors in routes (correctness/crash)**

Both routes are `async` with no try/catch. In Express 4, a rejected promise never reaches the error handler — the request hangs and you get an `UnhandledPromiseRejection` (Node ≥ 15 crashes the process). This is the most critical issue.

```ts
function asyncRoute(
  fn: (req: express.Request, res: express.Response) => Promise<void>
): express.RequestHandler {
  return (req, res, next) => fn(req, res).catch(next);
}

app.get("/api/users", asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id, email, created_at FROM users ORDER BY id LIMIT 100"
  );
  res.json(rows);
}));

app.get("/api/users/:id", asyncRoute(async (req, res) => {
  ...
}));

// Error handler — must be LAST, after all routes
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal server error" });
});
```

---

**index.ts:24-34 — `req.params.id` not validated (correctness + DB error path)**

`req.params.id` is a string. If a caller hits `/api/users/abc`, Postgres throws `invalid input syntax for type integer` — which, combined with the missing try/catch above, crashes the process. Even with error handling in place, the failure happens inside the DB unnecessarily.

```ts
app.get("/api/users/:id", asyncRoute(async (req, res) => {
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
}));
```

---

**index.ts:38-42 — Startup rejection unhandled (correctness/crash)**

`withRetry(...).then(...)` has no `.catch()`. If the DB is unreachable after 10 retries, the rejection is unhandled — the process either crashes silently (Node ≥ 15) or logs `UnhandledPromiseRejectionWarning` and keeps running in a broken state (never listening).

```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("fatal: could not connect to database:", err);
    process.exit(1);
  });
```

---

**index.ts:16-21 — No pagination on `GET /api/users` (performance)**

`SELECT … FROM users ORDER BY id` with no LIMIT returns every row. A large table will buffer the full result set in memory before sending. At minimum add a default limit and expose cursor-based pagination.

```ts
app.get("/api/users", asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const after = Number(req.query.after ?? 0);
  if (!Number.isInteger(limit) || !Number.isInteger(after)) {
    res.status(400).json({ error: "invalid pagination params" });
    return;
  }
  const { rows } = await pool.query(
    "SELECT id, email, created_at FROM users WHERE id > $1 ORDER BY id LIMIT $2",
    [after, limit]
  );
  res.json(rows);
}));
```

---

**index.ts:8-13 — CORS wildcard + missing OPTIONS preflight (security + correctness)**

`*` allows any origin to call the API with cookies — fine for a local workshop, not for production. More immediately: `OPTIONS` preflight requests hit `next()` and fall through to actual routes, returning 404 instead of 200. Browsers will block the request.

```ts
import cors from "cors";

app.use(cors({
  origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  methods: ["GET", "POST", "PUT", "DELETE"],
}));
// cors() handles OPTIONS automatically
```

---

`★ Insight ─────────────────────────────────────`
Parameterized queries (`$1`, `$2`) prevent SQL injection regardless of input — that's already correct here. But they don't prevent type errors: Postgres still tries to cast the string `"abc"` to `int4` and throws, so application-level type validation and DB-level errors solve different problems and both are needed.
`─────────────────────────────────────────────────`

---

## Summary table

| # | File:Line | Category | Severity |
|---|-----------|----------|----------|
| 1 | `db.ts:5` | No pool `error` listener → crash | Critical |
| 2 | `index.ts:16,24` | Async routes without try/catch → crash | Critical |
| 3 | `index.ts:38` | No `.catch()` on startup → silent crash | Critical |
| 4 | `db.ts:15` | `withRetry` retries permanent errors | High |
| 5 | `index.ts:24` | No validation on `:id` → DB error unhandled | High |
| 6 | `db.ts:9` | Hardcoded default password | High |
| 7 | `index.ts:8` | CORS wildcard + no OPTIONS handler | Medium |
| 8 | `index.ts:16` | No pagination → potential OOM | Medium |
| 9 | `db.ts:7` / `index.ts:36` | `Number()` coercion without NaN guard | Medium |
| 10 | `db.ts:20` | Flat 1 s retry, no backoff | Low |

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 4508,
  "cache_read_input_tokens": 57758,
  "cache_creation_input_tokens": 20550,
  "total_tokens": 82820,
  "cost_usd": 0.2082594,
  "num_turns": 3
}
```
