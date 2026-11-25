# config__off task 1 rep 1

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The endpoint is added. I checked the blocking guardrails — none apply here: no DB queries, no feature flags, no UI, no service-to-service calls.

`GET /api/health` now lives at `api/src/index.ts:16`, above the DB-dependent routes, and returns `{"status":"ok"}` with HTTP 200.

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
  "output_tokens": 894,
  "cache_read_input_tokens": 128340,
  "cache_creation_input_tokens": 18156,
  "total_tokens": 147398,
  "cost_usd": 0.160872,
  "num_turns": 4
}
```
