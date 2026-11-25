# headroom__on task 1 rep 1

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The health endpoint is added. None of the blocking guardrails apply here — there's no DB query, no feature flags, no UI, and no service-to-service calls.

`GET /api/health` now returns `{"status":"ok"}` with HTTP 200. The route is placed before the data routes in `api/src/index.ts`.

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
  "input_tokens": 10,
  "output_tokens": 1156,
  "cache_read_input_tokens": 199888,
  "cache_creation_input_tokens": 20047,
  "total_tokens": 221101,
  "cost_usd": 0.1976184,
  "num_turns": 6,
  "permission_denials": 0
}
```
