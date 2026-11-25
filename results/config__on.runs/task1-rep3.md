# config__on task 1 rep 3

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The health endpoint is in place. The guardrails hook fired after the edit, but this change is exempt from all blocking guardrails — no DB queries, no feature flags, no UI components, no service-to-service calls.

`GET /api/health` now returns `{"status":"ok"}` with HTTP 200 at `api/src/index.ts:16`.

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
  "input_tokens": 7,
  "output_tokens": 564,
  "cache_read_input_tokens": 92653,
  "cache_creation_input_tokens": 18324,
  "total_tokens": 111548,
  "cost_usd": 0.1462209,
  "num_turns": 3
}
```
