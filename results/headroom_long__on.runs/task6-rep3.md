# headroom_long__on task 6 rep 3

Grade: "No files changed; review lists >=5 distinct issues, each with file:line and a fix"

## Agent result

`★ Insight ─────────────────────────────────────`
Express 4 does not propagate async route handler rejections — it was designed before `async/await` existed. Express 5 (released 2024) wraps async handlers automatically. This codebase on Express 4 means every `async` handler needs manual `try/catch` or a wrapper like `express-async-errors`. The gap is invisible in happy-path testing, which is exactly why it gets shipped to prod.
`─────────────────────────────────────────────────`

---

## api/src/index.ts

### 1. Unhandled async rejections crash the process — `L16–21`, `L24–34`

**Why it matters:** Express 4 does not catch promise rejections inside `async` route handlers. When `pool.query` throws (Postgres restart, network blip, bad SQL), the rejection is unhandled. Node ≥ 15 terminates the process on `UnhandledPromiseRejection`. Both GET routes are exposed.

```typescript
// L16 — before
app.get("/api/users", async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT id, email, created_at FROM users ORDER BY id"
  );
  res.json(rows);
});

// fix
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

Same fix applies to the `GET /api/users/:id` handler at L24.

---

### 2. No input validation on `:id` — `L27`

**Why it matters:** `req.params.id` is a raw string. PostgreSQL will attempt to cast it to `INTEGER` (the column type). A path like `/api/users/abc` causes pg to throw `22P02 invalid input syntax for type integer`. Without a try/catch (issue 1), that crashes the process. Even after adding a catch, you should return 400 before hitting the database.

```typescript
// L24 — fix (combined with issue 1)
app.get("/api/users/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "id must be an integer" });
    return;
  }
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at FROM users WHERE id = $1",
      [id]                // number, not string
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("GET /api/users/:id:", err);
    res.status(500).json({ error: "internal server error" });
  }
});
```

---

### 3. CORS middleware doesn't handle OPTIONS preflight — `L8–13`

**Why it matters:** Browsers send an OPTIONS preflight before any cross-origin request with a non-simple method or header (POST with `Content-Type: application/json`, PUT, DELETE). The middleware sets the `Allow-*` headers and calls `next()`, so Express falls through to its 404 handler for OPTIONS. Any future POST/PUT/DELETE endpoint will fail in browser-based clients — which is exactly the workshop's Vite front-end.

```typescript
// L8 — fix
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE");
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
```

---

### 4. `withRetry(...).then(...)` has no `.catch()` — `L38–42`

**Why it matters:** If the database never becomes reachable and all 10 retries exhaust, `withRetry` rejects. There is no `.catch()`, so the rejection is unhandled. The HTTP server never starts, nothing is logged, and the process emits an `UnhandledPromiseRejection` warning and may exit — silently from an operator's perspective.

```typescript
// L38 — fix
withRetry(() => pool.query("SELECT 1"))
  .then(() => {
    app.listen(port, () => {
      console.log(`api listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error("Database never became ready, exiting:", err);
    process.exit(1);
  });
```

---

### 5. `Number(process.env.PORT ?? 3001)` doesn't guard non-numeric strings — `L36`

**Why it matters:** `??` only short-circuits on `undefined`/`null`. If `PORT` is set to any non-numeric string (`PORT=disabled`, `PORT=`), `Number(str)` returns `NaN` and `app.listen(NaN)` has undefined behavior in Node (may silently bind to port 0).

```typescript
// L36 — fix
const port = parseInt(process.env.PORT ?? "3001", 10) || 3001;
```

---

## api/src/db.ts

### 6. `withRetry` retries on permanent errors — `L13–24`

**Why it matters:** Every error class — including authentication failure (28P01), wrong database name (3D000), bad hostname (ENOTFOUND) — is retried 10 times over 10 seconds before surfacing. During workshop setup, a wrong `PGPASSWORD` becomes a 10-second hang with a misleading timeout-flavored error message instead of an immediate, actionable one.

```typescript
// L13 — fix
export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  const TRANSIENT = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"]);
  // 57P03 = cannot_connect_now (Postgres starting up)
  const TRANSIENT_PG = new Set(["57P03"]);

  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { code?: string };
      if (!TRANSIENT.has(e.code ?? "") && !TRANSIENT_PG.has(e.code ?? "")) {
        throw err; // permanent — fail fast
      }
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}
```

---

### 7. `throw lastErr` when `tries = 0` throws `undefined` — `L23`

**Why it matters:** `lastErr` is initialized as `unknown` (effectively `undefined`). If `tries ≤ 0`, the loop body never runs and `throw undefined` is executed. Callers catch `undefined` — `.message` is `undefined`, there is no stack trace, and error monitoring tools discard it.

```typescript
// L13 — fix: guard at entry
export async function withRetry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  if (tries < 1) throw new Error("withRetry: tries must be >= 1");
  let lastErr: Error = new Error("withRetry exhausted with no attempts");
  // ... rest of function
}
```

---

### 8. No `PGPORT` validation and no graceful shutdown — `L7`, module level

**Why it matters:**

`L7` has the same `Number(...)` NaN hazard as `PORT`:
```typescript
// L7 — fix
port: parseInt(process.env.PGPORT ?? "5432", 10) || 5432,
```

The pool is never closed on shutdown signals. When the container stops, Postgres will log "unexpected connection termination" for each live connection. For a workshop environment this is cosmetic, but in production it confuses DBA tooling and can exhaust connection slots during rolling deploys.

```typescript
// add after pool creation at db.ts L11
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => pool.end());
}
```

`★ Insight ─────────────────────────────────────`
Issues 1 and 4 share a root cause: Express 4 + `async` = invisible uncaught-rejection trap. The idiomatic fix in Express 4 projects is a one-line wrapper — `const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)` — applied to every handler. That way a central error-handling middleware handles all async failures uniformly instead of needing `try/catch` in every route.
`─────────────────────────────────────────────────`

---

**Summary table**

| # | File | Line | Category | Severity |
|---|------|------|----------|----------|
| 1 | index.ts | 16, 24 | Correctness / crash | **Critical** |
| 2 | index.ts | 27 | Input validation / crash | **Critical** |
| 3 | index.ts | 8 | CORS / correctness | High |
| 4 | index.ts | 38 | Error handling / operability | High |
| 5 | index.ts | 36 | Input validation / operability | Medium |
| 6 | db.ts | 13 | Error handling / operability | High |
| 7 | db.ts | 23 | Correctness | Low |
| 8 | db.ts | 7, 11 | Input validation / operability | Low |

Issues 1 and 2 are the ones most likely to surface in a demo/workshop mid-flight. Fix those two first.

## Diff

```diff
```

## Usage

```json
{
  "input_tokens": 5,
  "output_tokens": 4152,
  "cache_read_input_tokens": 94200,
  "cache_creation_input_tokens": 20800,
  "total_tokens": 119157,
  "cost_usd": 0.5748606,
  "num_turns": 4
}
```
