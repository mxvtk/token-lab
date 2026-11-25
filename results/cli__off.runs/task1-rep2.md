# cli__off task 1 rep 2

Grade: "GET /api/health returns {status:'ok'}"

## Agent result

The guardrail check is for the edit I just made. This change is a single stateless route with no DB access, no feature flags, no UI components, and no cross-service calls — none of the blocking guardrails apply.

Added `GET /api/health` at `api/src/index.ts:16`. It returns `{"status":"ok"}` with HTTP 200 and sits above the other routes.

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
  "output_tokens": 932,
  "cache_read_input_tokens": 117286,
  "cache_creation_input_tokens": 14345,
  "total_tokens": 132571,
  "cost_usd": 0.1352598,
  "num_turns": 4,
  "permission_denials": 0
}
```
