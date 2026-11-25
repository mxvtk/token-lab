# caveman_long__on task 6 rep 1

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix" # live_only: opens a real PR — never part of the batch A/B; run by hand with --task 5.

## Agent result

`★ Insight ─────────────────────────────────────`
Reading these two files together is important — `db.ts` exports the pool and retry helper that every route depends on, so bugs there cascade into all error-handling paths in `index.ts`. The two most dangerous classes of issue here are: (1) async exceptions that silently swallow errors or crash the process, and (2) the pool emitting an "error" event with no handler, which Node turns into an immediate uncaught exception.
`─────────────────────────────────────────────────`

---

## `api/src/db.ts`

---

**db.ts:14 — `withRetry` retries all errors, including permanent ones**

Both auth failures (`password authentication failed`) and config errors (`database "foo" does not exist`) are retried 10× with 1-second gaps. You wait 10 seconds before exiting on a misconfiguration that will never self-heal.

```ts
// Before retrying, let permanent errors through immediately.
const TRANSIENT = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "57P03"]);

export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as any)?.code as string | undefined;
      if (code && !TRANSIENT.has(code)) throw err;   // permanent — fail fast
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}
```

---

**db.ts:21 — flat retry delay, no backoff**

Fixed 1 s × 10 means multiple API replicas starting simultaneously hammer the DB at the same cadence. Use exponential backoff with jitter.

```ts
await new Promise((r) =>
  setTimeout(r, Math.min(200 * 2 ** i + Math.random() * 100, 8000))
);
```

---

**db.ts:5 — no `pool.on("error")` handler**

`node-postgres` emits `"error"` on idle clients (e.g. DB restarts while connections are sitting in the pool). Without a listener Node raises `Unhandled 'error' event` and **crashes the process**. This is documented in pg's README as a required hook.

```ts
export const pool = new Pool({ ... });

pool.on("error", (err) => {
  console.error("Unexpected idle pool error:", err);
  // Do NOT exit here — the pool self-heals; just log.
});
```

---

**db.ts:9 — hardcoded fallback credentials**

`password: process.env.PGPASSWORD ?? "tokenlab"` silently falls back to a known-plaintext password if the env var is unset. A misconfigured prod deploy connects without any visible warning.

```ts
// Fail loudly instead of silently using a default.
if (!process.env.PGPASSWORD) {
  throw new Error("PGPASSWORD env var is required");
}
export const pool = new Pool({
  password: process.env.PGPASSWORD,
  ...
});
```

(Same logic applies to `PGUSER` / `PGDATABASE` if defaults don't match prod.)

---

**db.ts:5 — no pool limits or timeouts configured**

Default `max=10` and no `connectionTimeoutMillis`/`idleTimeoutMillis`. Under load, `pool.query()` can queue silently forever if all connections are busy. `connectionTimeoutMillis` makes it fail fast instead.

```ts
export const pool = new Pool({
  ...
  max: Number(process.env.PGPOOL_MAX ?? 10),
  connectionTimeoutMillis: 5000,   // fail after 5 s waiting for a connection
  idleTimeoutMillis: 30_000,       // close idle connections after 30 s
});
```

---

## `api/src/index.ts`

---

**index.ts:16–21 and 24–34 — async route handlers with no try/catch**

Both handlers are `async` but unguarded. Express 4 does **not** catch promise rejections from route handlers — an unhandled rejection hangs the request indefinitely (or crashes Node on newer versions). Any DB outage, query error, or pool timeout surfaces as a silent client hang.

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

Apply the same wrapper to `/api/users/:id`.

---

**index.ts:27 — no input validation on `:id`**

`req.params.id` goes directly into the parameterized query as `$1`. Parameterized queries prevent SQL injection, but passing `"abc"` to a Postgres `integer` column raises `invalid input syntax for type integer`. With no try/catch (see above) this hangs the request; with a catch it leaks the raw Postgres error message to the client.

```ts
app.get("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users WHERE id = $1",
      [id]
    );
    ...
  } catch (err) { ... }
});
```

---

**index.ts:8–13 — CORS OPTIONS preflight never answered**

The middleware appends headers and calls `next()` for all methods, including `OPTIONS`. Preflight `OPTIONS` requests fall through to no matching route handler and return 404. Browsers block the actual request.

```ts
// Either handle OPTIONS explicitly:
app.options("*", (_req, res) => res.sendStatus(204));

// Or, cleaner, use the cors package:
import cors from "cors";
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }));
```

---

**index.ts:38 — startup failure crashes silently**

`withRetry(...).then(...)` with no `.catch()`. If the pool never connects and `withRetry` exhausts retries, the rejected promise becomes an unhandled rejection — either a silent no-op or a process crash with no meaningful message.

```ts
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => console.log(`api listening on :${port}`));
  })
  .catch((err) => {
    console.error("Failed to connect to DB, shutting down:", err);
    process.exit(1);
  });
```

---

**index.ts — no graceful shutdown**

No `SIGTERM` handler. When the container scheduler stops the pod, in-flight requests are dropped and pool connections leak until the DB times them out. The standard pattern:

```ts
const server = app.listen(port, () => console.log(`api listening on :${port}`));

process.on("SIGTERM", () => {
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
});
```

---

`★ Insight ─────────────────────────────────────`
The two issues with the most blast radius at production scale are (1) the missing `pool.on("error")` handler — it's a silent process-killer that strikes exactly when you're under DB pressure and least want an outage — and (2) async routes with no error handling, which turns any transient DB hiccup into hung requests that exhaust the HTTP connection pool upstream. Fix those two first; the rest are correctness and hardening.
`─────────────────────────────────────────────────`

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 4,
  "output_tokens": 4056,
  "cache_read_input_tokens": 57746,
  "cache_creation_input_tokens": 20538,
  "total_tokens": 82344,
  "cost_usd": 0.20140380000000002,
  "num_turns": 3
}
```
