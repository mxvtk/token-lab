# headroom__off task 1 rep 1

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The edit is already applied. The change is a 3-line health endpoint with no DB queries, no feature flags, no UI, and no service-to-service calls — none of the blocking guardrails (service boundaries, flag cleanup, Vibe, accessibility, DB columns, etc.) apply here.

`GET /api/health` is live at `api/src/index.ts:16`, returning `{"status":"ok"}` with HTTP 200.

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
  "output_tokens": 928,
  "cache_read_input_tokens": 109794,
  "cache_creation_input_tokens": 37771,
  "total_tokens": 148501,
  "cost_usd": 0.2735082,
  "num_turns": 4,
  "permission_denials": 0
}
```
