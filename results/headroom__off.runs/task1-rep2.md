# headroom__off task 1 rep 2

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The edit is done. For this change — a single route with no DB access, no UI, no feature flags — none of the blocking guardrails apply.

`GET /api/health` now lives at `api/src/index.ts:16`, before the data routes, and returns `{"status":"ok"}` with HTTP 200.

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
  "output_tokens": 805,
  "cache_read_input_tokens": 129081,
  "cache_creation_input_tokens": 18522,
  "total_tokens": 148416,
  "cost_usd": 0.1619553,
  "num_turns": 4,
  "permission_denials": 0
}
```
