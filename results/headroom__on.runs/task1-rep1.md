# headroom__on task 1 rep 1

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The change is a single `app.get("/api/health")` route with no DB access, no feature flags, and no UI — none of the blocking guardrails apply to it.

`★ Insight ─────────────────────────────────────`
- Express routes are matched in registration order; placing `/api/health` before data routes ensures it short-circuits quickly without touching middleware that might add latency or fail.
- Using `_req` (underscore prefix) signals intentionally unused parameters — many linters (ESLint `no-unused-vars`) enforce this convention to avoid false positives.
`─────────────────────────────────────────────────`

Done — `GET /api/health` now returns `{"status":"ok"}` with HTTP 200.

## Diff

```diff
diff --git a/api/src/index.ts b/api/src/index.ts
index 6165a7f..0cf87e0 100644
--- a/api/src/index.ts
+++ b/api/src/index.ts
@@ -12,6 +12,10 @@ app.use((_req, res, next) => {
   next();
 });
 
+app.get("/api/health", (_req, res) => {
+  res.json({ status: "ok" });
+});
+
 // List all users.
 app.get("/api/users", async (_req, res) => {
   const { rows } = await pool.query(
```

## Usage

```json
{
  "input_tokens": 8,
  "output_tokens": 978,
  "cache_read_input_tokens": 128164,
  "cache_creation_input_tokens": 18425,
  "total_tokens": 147575,
  "cost_usd": 0.16369319999999998,
  "num_turns": 4
}
```
